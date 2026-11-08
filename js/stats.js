// Auswertungslogik. Alle Verbräuche werden zwischen zwei Ablesungen gleichmäßig auf die
// dazwischenliegende Zeit verteilt und dann zu Tagen und weiter zu Wochen/Monaten/Jahren summiert.
import * as store from './store.js';

const DAY = 86400000;

export const parseZeit = s => new Date(s.length <= 10 ? s + 'T12:00' : s);
export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const dayDate = k => new Date(k + 'T00:00');
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function nextDay(d) { const x = new Date(d); x.setDate(x.getDate() + 1); x.setHours(0, 0, 0, 0); return x; }

// Verteilt Intervalle {t0, t1, menge} auf Kalendertage. Ergebnis: Map Tag → {menge, abdeckung (0..1)}
export function distribute(intervals) {
  const out = new Map();
  for (const { t0, t1, menge } of intervals) {
    const span = t1 - t0;
    if (span <= 0) continue;
    let cur = new Date(t0);
    while (cur < t1) {
      const dayStart = startOfDay(cur);
      const end = new Date(Math.min(nextDay(cur), t1));
      const part = end - cur;
      const k = dayKey(dayStart);
      const o = out.get(k) || { menge: 0, abdeckung: 0 };
      o.menge += menge * (part / span);
      o.abdeckung += part / (nextDay(dayStart) - dayStart);
      out.set(k, o);
      cur = end;
    }
  }
  return out;
}

// ---------- Wärme ----------
// Zählerstände eines Kreises, um Zählerwechsel bereinigt (fortlaufender Stand).
export function heatPoints(kreisId) {
  const events = store.eintraege().filter(e =>
    (e.typ === 'ablesung' && e.werte && Number.isFinite(e.werte[kreisId])) ||
    (e.typ === 'zaehlerwechsel' && e.kreisId === kreisId));
  let offset = 0;
  const pts = [];
  for (const e of events) {
    const t = parseZeit(e.zeit);
    if (e.typ === 'ablesung') pts.push({ t, v: e.werte[kreisId] + offset, roh: e.werte[kreisId], id: e.id });
    else {
      if (Number.isFinite(e.endstand)) pts.push({ t, v: e.endstand + offset, roh: e.endstand, id: e.id, wechsel: true });
      const base = Number.isFinite(e.endstand) ? e.endstand + offset : (pts.at(-1)?.v ?? 0);
      offset = base - (e.startstand || 0);
    }
  }
  return pts;
}
function pointsToIntervals(pts) {
  const iv = [];
  for (let i = 1; i < pts.length; i++) iv.push({ t0: pts[i - 1].t, t1: pts[i].t, menge: pts[i].v - pts[i - 1].v });
  return iv;
}
export function heatDaily(kreisId) { return distribute(pointsToIntervals(heatPoints(kreisId))); }

// ---------- Öl ----------
export function oilPoints() {
  return store.eintraege('ablesung').filter(e => Number.isFinite(e.oel)).map(e => ({ t: parseZeit(e.zeit), v: e.oel, id: e.id }));
}
export function oilIntervals() {
  const pts = oilPoints();
  const fills = store.eintraege('betankung').map(f => ({ t: parseZeit(f.zeit), liter: f.liter || 0 }));
  const iv = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    // Betankung zählt zum Intervall (a, b]. Gleiche Uhrzeit wie b → Ablesung b zeigt Stand nach dem Tanken.
    const getankt = fills.filter(f => f.t > a.t && f.t <= b.t).reduce((s, f) => s + f.liter, 0);
    iv.push({ t0: a.t, t1: b.t, menge: Math.max(0, a.v + getankt - b.v) });
  }
  return iv;
}
export function oilDaily() { return distribute(oilIntervals()); }

export function oilForecast() {
  const pts = oilPoints();
  if (pts.length < 2) return null;
  const last = pts.at(-1);
  const iv = oilIntervals();
  // Verbrauchsrate aus den letzten ~28 Tagen (mindestens das letzte Intervall)
  let menge = 0, dauer = 0;
  for (let i = iv.length - 1; i >= 0; i--) {
    menge += iv[i].menge; dauer += iv[i].t1 - iv[i].t0;
    if (dauer >= 28 * DAY) break;
  }
  const proTag = dauer > 0 ? menge / (dauer / DAY) : 0;
  const fillsAfter = store.eintraege('betankung').filter(f => parseZeit(f.zeit) > last.t).reduce((s, f) => s + (f.liter || 0), 0);
  const tageSeit = (Date.now() - last.t) / DAY;
  const geschaetzt = Math.max(0, last.v + fillsAfter - proTag * tageSeit);
  const tageRest = proTag > 0 ? geschaetzt / proTag : Infinity;
  return {
    stand: last.v, standZeit: last.t, geschaetzt, proTag, proWoche: proTag * 7,
    leerAm: Number.isFinite(tageRest) ? new Date(Date.now() + tageRest * DAY) : null,
  };
}

// ---------- Perioden ----------
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y = x.getUTCFullYear();
  const w = Math.ceil(((x - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return { y, w };
}
export function periodKey(dk, gran) {
  const d = dayDate(dk);
  const y = d.getFullYear(), m = d.getMonth() + 1;
  switch (gran) {
    case 'day': return dk;
    case 'week': { const { y: wy, w } = isoWeek(d); return `${wy}-W${String(w).padStart(2, '0')}`; }
    case 'month': return `${y}-${String(m).padStart(2, '0')}`;
    case 'year': return String(y);
    case 'season': return m >= 7 ? `${y}/${String(y + 1).slice(2)}` : `${y - 1}/${String(y).slice(2)}`;
  }
}
const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const MONATE_HP = ['Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez', 'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun'];
export function periodLabel(key, gran) {
  switch (gran) {
    case 'day': { const d = dayDate(key); return `${d.getDate()}.${d.getMonth() + 1}.`; }
    case 'week': { const [y, w] = key.split('-W'); return `KW ${+w} ’${y.slice(2)}`; }
    case 'month': { const [y, m] = key.split('-'); return `${MONATE[+m - 1]} ’${y.slice(2)}`; }
    case 'year': return key;
    case 'season': return 'HP ' + key;
  }
}
export function periodDays(key, gran) {
  if (gran === 'day') return 1;
  if (gran === 'week') return 7;
  if (gran === 'month') { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); }
  if (gran === 'year') { const y = +key; return (new Date(y + 1, 0, 1) - new Date(y, 0, 1)) / DAY; }
  if (gran === 'season') { const y = +key.slice(0, 4); return Math.round((new Date(y + 1, 6, 1) - new Date(y, 6, 1)) / DAY); }
}

// Summiert eine Tages-Map auf Perioden. Ergebnis: Map key → {menge, abdeckung (Anteil abgedeckter Tage)}
export function aggregate(daily, gran) {
  const out = new Map();
  for (const [dk, v] of daily) {
    const k = periodKey(dk, gran);
    const o = out.get(k) || { menge: 0, tage: 0 };
    o.menge += v.menge; o.tage += v.abdeckung;
    out.set(k, o);
  }
  for (const [k, o] of out) o.abdeckung = Math.min(1, o.tage / periodDays(k, gran));
  return out;
}

// Alle Periodenschlüssel zwischen erstem und letztem Tag (lückenlos), für saubere Achsen.
export function periodRange(dayKeys, gran) {
  if (!dayKeys.length) return [];
  const sorted = [...dayKeys].sort();
  const keys = [];
  let d = dayDate(sorted[0]);
  const end = dayDate(sorted.at(-1));
  let last = null;
  while (d <= end) {
    const k = periodKey(dayKey(d), gran);
    if (k !== last) { keys.push(k); last = k; }
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

// Summe mehrerer Tages-Maps (z. B. alle Kreise). Abdeckung = Minimum über die Maps, die den Tag enthalten.
export function sumDaily(maps) {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) {
    const o = out.get(k);
    if (!o) out.set(k, { menge: v.menge, abdeckung: v.abdeckung });
    else { o.menge += v.menge; o.abdeckung = Math.min(o.abdeckung, v.abdeckung); }
  }
  return out;
}

// Ø pro Tag über die letzten n Tage (nur abgedeckte Zeit)
export function avgPerDay(daily, n) {
  const cutoff = dayKey(new Date(Date.now() - n * DAY));
  let menge = 0, tage = 0;
  for (const [k, v] of daily) if (k >= cutoff) { menge += v.menge; tage += v.abdeckung; }
  return tage > 0.5 ? { proTag: menge / tage, tage } : null;
}

// ---------- Heizungseinstellungen ----------
export function settingsSeries() {
  return store.eintraege('ablesung')
    .filter(e => [e.kennlinie, e.kennlinieNacht, e.vorlaufTag, e.vorlaufNacht, e.pumpe].some(Number.isFinite))
    .map(e => ({ t: parseZeit(e.zeit), kennlinie: e.kennlinie, kennlinieNacht: e.kennlinieNacht, vorlaufTag: e.vorlaufTag, vorlaufNacht: e.vorlaufNacht, pumpe: e.pumpe }));
}
export function settingChanges() {
  const s = settingsSeries();
  const ch = [];
  const keys = ['kennlinie', 'kennlinieNacht', 'vorlaufTag', 'vorlaufNacht', 'pumpe'];
  for (let i = 1; i < s.length; i++) {
    const diff = keys.filter(k => Number.isFinite(s[i][k]) && Number.isFinite(s[i - 1][k]) && s[i][k] !== s[i - 1][k]);
    if (diff.length) ch.push({ t: s[i].t, diff: diff.map(k => ({ k, von: s[i - 1][k], nach: s[i][k] })) });
  }
  return ch;
}

// ---------- Gradtage (VDI 3807: G 20/15) ----------
export function gradtag(tm, s = store.settings()) {
  return tm < s.heizgrenze ? s.innentemp - tm : 0;
}
export function gradtageDaily(temps) {
  const s = store.settings();
  const out = new Map();
  for (const [k, t] of temps) out.set(k, { menge: gradtag(t, s), abdeckung: 1 });
  return out;
}
