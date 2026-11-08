// Warnsystem: vergleicht den Verbrauch der letzten Wochen mit dem, was bei diesem Wetter zu erwarten wäre.
//
// Modell (Energiesignatur): Verbrauch = Grundlast × Tage + b × Heizgradtage.
// Heizgradtage hier gleitend: Summe max(0, Heizgrenze − Tagesmittel). Das passt bei euren Daten besser als
// die VDI-Gradtage mit ihrem harten Sprung an der Heizgrenze (geprüft an den Ablesungen 2022–2026).
// Gelernt wird aus den 12 Monaten vor dem geprüften Zeitraum – das Modell passt sich also an Änderungen an.
import * as store from './store.js';
import * as S from './stats.js';
import * as W from './weather.js';
import { fmtAuto } from './ui.js';

const DAY = 86400000;
const OEL_TAGE = 28;          // Öl wird in 10-L-Schritten abgelesen → längeres Fenster nötig
const MIN_REF_TAGE = 120;     // so viel Vergleichszeit braucht das Modell mindestens
const MIN_HGT_PRO_TAG = 5;    // darunter (Ø wärmer als ~10 °C) ist der Heizbedarf zu klein für eine Aussage
const UNTERE_GRENZE = -0.5;   // so viel weniger als erwartet → Tippfehler oder Zähler prüfen
const NG_MIN_LITER = 200;

// Heizgradtage zwischen zwei Zeitpunkten, angeschnittene Tage anteilig
function hgt(t0, t1, temps, grenze) {
  let h = 0, fehlt = 0;
  let cur = new Date(t0);
  while (cur < t1) {
    const next = new Date(cur); next.setHours(24, 0, 0, 0);
    const end = next < t1 ? next : t1;
    const f = (end - cur) / DAY;
    const t = temps.get(S.dayKey(cur));
    if (t === undefined) fehlt += f; else h += Math.max(0, grenze - t) * f;
    cur = end;
  }
  return { h, fehlt };
}

function intervalle(pts) {
  const iv = [];
  for (let i = 1; i < pts.length; i++) {
    const t0 = pts[i - 1].t, t1 = pts[i].t;
    if (t1 > t0) iv.push({ t0, t1, tage: (t1 - t0) / DAY, menge: pts[i].v - pts[i - 1].v });
  }
  return iv;
}

// Gewichtete Ausgleichsgerade der Tagesraten: menge/tage = a + b · hgt/tage (Gewicht = Tage)
function fit(iv) {
  const W_ = iv.reduce((s, x) => s + x.tage, 0);
  if (!W_) return null;
  const xs = iv.map(x => [x.hgt / x.tage, x.menge / x.tage, x.tage]);
  const mx = xs.reduce((s, [x, , w]) => s + x * w, 0) / W_;
  const my = xs.reduce((s, [, y, w]) => s + y * w, 0) / W_;
  let sxx = 0, sxy = 0;
  for (const [x, y, w] of xs) { sxx += w * (x - mx) ** 2; sxy += w * (x - mx) * (y - my); }
  if (sxx <= 0) return null;
  let b = sxy / sxx, a = my - b * mx;
  if (a < 0) { // keine negative Grundlast: Gerade durch den Ursprung
    a = 0;
    b = xs.reduce((s, [x, y, w]) => s + w * x * y, 0) / xs.reduce((s, [x, , w]) => s + w * x * x, 0);
  }
  return b > 0 ? { a, b } : null;
}

// Prüft das jüngste Zeitfenster (≥ minTage) einer Intervall-Reihe.
function pruefe(iv, temps, minTage, grenze) {
  if (!iv.length) return { status: 'leer' };
  let i = iv.length - 1, tage = 0;
  while (i >= 0 && tage < minTage) { tage += iv[i].tage; i--; }
  if (tage < minTage) return { status: 'leer' };
  const fenster = iv.slice(i + 1);
  const t0 = fenster[0].t0, t1 = fenster.at(-1).t1;
  const basis = { t0, t1, tage };

  const ref = [];
  for (const x of iv) {
    if (x.t1 > t0 || x.t1 <= t0 - 365 * DAY) continue;
    const g = hgt(x.t0, x.t1, temps, grenze);
    if (g.fehlt > 0.1 * x.tage) continue;
    ref.push({ ...x, hgt: g.h });
  }
  if (ref.reduce((s, x) => s + x.tage, 0) < MIN_REF_TAGE) return { ...basis, status: 'lernt' };
  const m = fit(ref);
  if (!m) return { ...basis, status: 'lernt' };

  let H = 0, fehlt = 0;
  for (const x of fenster) { const g = hgt(x.t0, x.t1, temps, grenze); H += g.h; fehlt += g.fehlt; }
  if (fehlt > 0.1 * tage) return { ...basis, status: 'wetter' };
  if (H / tage < MIN_HGT_PRO_TAG) return { ...basis, status: 'sommer' };
  const erwartet = m.a * tage + m.b * H;
  const ist = fenster.reduce((s, x) => s + x.menge, 0);
  if (erwartet <= 0) return { ...basis, status: 'lernt' };
  return { ...basis, status: 'ok', ist, erwartet, abw: (ist - erwartet) / erwartet, modell: m };
}

// ---------- Datenreihen (optional mit einer noch nicht gespeicherten Ablesung) ----------
function heatPts(kreisId, extra) {
  const pts = S.heatPoints(kreisId);
  const raw = extra?.werte?.[kreisId];
  if (Number.isFinite(raw) && (!pts.length || extra.t > pts.at(-1).t)) pts.push({ t: extra.t, v: raw + (pts.offset || 0) });
  return pts;
}
function oilIv(extra) {
  const pts = S.oilPoints();
  if (Number.isFinite(extra?.oel) && (!pts.length || extra.t > pts.at(-1).t)) pts.push({ t: extra.t, v: extra.oel });
  const fills = store.eintraege('betankung').map(f => ({ t: S.parseZeit(f.zeit), liter: f.liter || 0 }));
  const iv = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const getankt = fills.filter(f => f.t > a.t && f.t <= b.t).reduce((s, f) => s + f.liter, 0);
    if (b.t > a.t) iv.push({ t0: a.t, t1: b.t, tage: (b.t - a.t) / DAY, menge: Math.max(0, a.v + getankt - b.v) });
  }
  return iv;
}

// Wärme aller Hauptzähler zwischen a und b (anteilig); null, wenn ein Zähler den Zeitraum nicht abdeckt
function waermeZwischen(ivs, a, b) {
  let sum = 0;
  for (const iv of ivs) {
    if (!iv.length || iv[0].t0 > a || iv.at(-1).t1 < b) return null;
    for (const x of iv) {
      const o = Math.min(b, x.t1) - Math.max(a, x.t0);
      if (o > 0) sum += x.menge * o / (x.t1 - x.t0);
    }
  }
  return sum;
}

function nutzungsgrad(heatIvs, oiv, kwhProL) {
  const fensterBis = j => {
    let i = j, tage = 0, liter = 0;
    while (i >= 0 && tage < OEL_TAGE) { tage += oiv[i].tage; liter += oiv[i].menge; i--; }
    if (tage < OEL_TAGE || liter < NG_MIN_LITER) return null;
    const t0 = oiv[i + 1].t0, t1 = oiv[j].t1;
    const w = waermeZwischen(heatIvs, t0, t1);
    return w === null ? null : { t0, t1, liter, waerme: w, ng: w / (liter * kwhProL) };
  };
  if (!oiv.length) return { status: 'leer' };
  const cur = fensterBis(oiv.length - 1);
  if (!cur) return { status: 'leer' };
  const ref = [];
  for (let j = 0; j < oiv.length - 1; j++) {
    if (oiv[j].t1 > cur.t0 || oiv[j].t1 <= cur.t0 - 365 * DAY) continue;
    const r = fensterBis(j);
    if (r && r.ng < 1.2) ref.push(r.ng);
  }
  if (ref.length < 4) return { ...cur, status: 'lernt' };
  ref.sort((x, y) => x - y);
  const median = ref[Math.floor(ref.length / 2)];
  return { ...cur, status: 'ok', median, drop: median - cur.ng };
}

// ---------- Öffentliche Schnittstelle ----------
export async function loadTemps() {
  return W.temperatures(S.dayKey(new Date(Date.now() - 400 * DAY)));
}

const pct = x => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(Math.round(x * 100)) + ' %';
export { pct };
const dm = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
const LBL = { kennlinie: 'Kennlinie Tag', kennlinieNacht: 'Kennlinie Nacht', vorlaufTag: 'Vorlauf Tag', vorlaufNacht: 'Vorlauf Nacht', pumpe: 'Pumpe' };

const geaendert = ae => ae.length ? ` Einstellungen geändert: ${ae.slice(-4).join(', ')}` : '';
function aenderungen(t0, t1) {
  return S.settingChanges().filter(c => c.t > t0 - 7 * DAY && c.t <= t1)
    .flatMap(c => c.diff.map(d => `${LBL[d.k]} ${d.von}→${d.nach} (${dm(c.t)})`));
}

// extra = { t: Date, werte: {kreisId: Rohwert}, oel } – noch nicht gespeicherte Ablesung (Formular)
export function analyse(temps, extra = null, { waermeTage } = {}) {
  const s = store.settings();
  const grenze = s.heizgrenze ?? 15;
  const schwelle = (s.warnSchwelle ?? 25) / 100;
  const ks = store.kreise();

  const waerme = ks.map(k => ({ k, res: pruefe(intervalle(heatPts(k.id, extra)), temps, waermeTage ?? s.warnTage ?? 14, grenze) }));
  const oel = pruefe(oilIv(extra), temps, OEL_TAGE, grenze);
  const top = ks.filter(k => !k.teilVon || !ks.some(p => p.id === k.teilVon));
  const ng = nutzungsgrad(top.map(k => intervalle(heatPts(k.id, extra))), oilIv(extra), s.oelKwhProLiter || 10);

  const warnungen = [];
  if (s.warnAktiv !== false) {
    const zeitraum = r => `${dm(r.t0)}–${dm(r.t1)}`;
    for (const { k, res: r } of waerme) {
      if (r.status !== 'ok') continue;
      const ae = aenderungen(r.t0, r.t1);
      if (r.abw >= schwelle) warnungen.push({ level: 'warn', titel: `${k.name}: ${pct(r.abw)} Wärme`,
        text: `${fmtAuto(r.ist)} statt etwa ${fmtAuto(r.erwartet)} kWh bei diesem Wetter (${zeitraum(r)}).` + geaendert(ae) });
      else if (r.abw <= UNTERE_GRENZE) warnungen.push({ level: 'info', titel: `${k.name}: ungewöhnlich wenig`,
        text: `${fmtAuto(r.ist)} statt etwa ${fmtAuto(r.erwartet)} kWh (${zeitraum(r)}) – Tippfehler oder Zähler prüfen.` });
    }
    if (oel.status === 'ok' && oel.abw >= schwelle) {
      const ae = aenderungen(oel.t0, oel.t1);
      warnungen.push({ level: 'warn', titel: `Öl: ${pct(oel.abw)} Verbrauch`,
        text: `${Math.round(oel.ist)} L statt etwa ${Math.round(oel.erwartet)} L in ${Math.round(oel.tage)} Tagen (${zeitraum(oel)}).` + geaendert(ae) });
    }
    if (ng.status === 'ok' && ng.drop * 100 >= (s.ngSchwelle ?? 10)) warnungen.push({ level: 'warn', titel: `Nutzungsgrad nur ${Math.round(ng.ng * 100)} %`,
      text: `Sonst etwa ${Math.round(ng.median * 100)} % (${zeitraum(ng)}). Aus ${Math.round(ng.liter)} L Öl kam weniger Wärme an als üblich – Brenner/Wartung prüfen oder Ölstand-Ablesung kontrollieren.` });
  }
  return { waerme, oel, ng, warnungen, schwelle };
}
