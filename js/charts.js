// Statistik-Ansicht mit Diagrammen (Chart.js)
import * as store from './store.js';
import * as S from './stats.js';
import * as W from './weather.js';
import { esc, fmt, fmtAuto, fmtDate, cssVar, kreisFarbe } from './ui.js';

let charts = [];
let renderSeq = 0; // erkennt, ob nach dem Laden der Wetterdaten noch dieselbe Ansicht offen ist
const destroyAll = () => { charts.forEach(c => c.destroy()); charts = []; };
const LS_TAB = 'wz.stats.tab';
const LS_GRAN = 'wz.stats.gran';
const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* egal */ } };

const TABS = [
  ['verbrauch', 'Verbrauch'], ['kreise', 'Kreise'], ['jahre', 'Jahresvergleich'],
  ['witterung', 'Witterung'], ['oel', 'Öl'], ['effizienz', 'Nutzungsgrad'], ['einstellungen', 'Einstellungen'],
];
const GRANS = [['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr'], ['season', 'Heizperiode']];

function alpha(color, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function baseOptions(extra = {}) {
  const grid = cssVar('--border'), text = cssVar('--text-3');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = text;
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 14 } },
      tooltip: { backgroundColor: cssVar('--text'), titleColor: cssVar('--bg'), bodyColor: cssVar('--bg'), padding: 10, cornerRadius: 8, boxPadding: 4 },
    },
    scales: {
      x: { grid: { display: false }, border: { color: grid }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
      y: { grid: { color: grid }, border: { display: false }, beginAtZero: true, ticks: { callback: v => fmt(v) } },
    },
    ...extra,
  };
}
function chart(el, cfg) {
  const c = new Chart(el, cfg);
  charts.push(c);
  return c;
}
function canvas(root, sel) { return root.querySelector(sel); }

function heatMaps() {
  return S.kreisSeries({ split: S.splitEnabled() });
}
// Schalter: Unterzähler (Studio) einzeln zeigen oder im Hauptzähler (EG) lassen
function splitToggle() {
  if (!S.hasSubMeters()) return '';
  const ks = store.kreise();
  const subs = ks.filter(k => k.teilVon && ks.some(p => p.id === k.teilVon));
  const names = subs.map(k => k.name).join(', ');
  const parents = [...new Set(subs.map(k => store.kreis(k.teilVon).name))].join(', ');
  const on = S.splitEnabled();
  return `<label class="switch" data-split title="Aus: ${esc(names)} ist im ${esc(parents)} eingerechnet">
    <input type="checkbox" ${on ? 'checked' : ''}><span class="track" aria-hidden="true"></span>
    <span class="switch-label">${esc(names)} einzeln<small>${on ? `getrennt vom ${esc(parents)}` : `im ${esc(parents)} enthalten`}</small></span></label>`;
}
function allDayKeys(maps) {
  const s = new Set();
  maps.forEach(m => m.forEach((_, k) => s.add(k)));
  return [...s];
}
// ---------- Zeitraum (gilt für alle Statistik-Tabs) ----------
const LS_ZEIT = 'wz.stats.zeit';
const DAYMS = 86400000;
// Alle Heizperioden (Jul–Jun) von der ersten Aufzeichnung bis heute
function seasonsAll() {
  const e = store.eintraege();
  if (!e.length) return [];
  const first = S.periodKey(e[0].zeit.slice(0, 10), 'season');
  const last = S.periodKey(S.dayKey(new Date()), 'season');
  const out = [];
  for (let y = +first.slice(0, 4); y <= +last.slice(0, 4); y++) out.push(`${y}/${String(y + 1).slice(2)}`);
  return out;
}
function zeitraum() {
  let z = lsGet(LS_ZEIT, '12m');
  if (z.startsWith('hp:') && !seasonsAll().includes(z.slice(3))) z = '12m';
  const tomorrow = S.dayKey(new Date(Date.now() + DAYMS));
  if (z === 'all' || z === 'each') return { z, from: '0000', to: '9999', label: 'Gesamt' };
  if (z === 'd30') return { z, from: S.dayKey(new Date(Date.now() - 30 * DAYMS)), to: tomorrow, label: 'letzte 30 Tage' };
  if (z.startsWith('hp:')) { const y = +z.slice(3, 7); return { z, from: `${y}-07-01`, to: `${y + 1}-07-01`, label: 'Heizperiode ' + z.slice(3), season: z.slice(3) }; }
  return { z: '12m', from: S.dayKey(new Date(Date.now() - 365 * DAYMS)), to: tomorrow, label: 'letzte 12 Monate' };
}
const inRange = (dk, r) => dk >= r.from && dk < r.to;
function filterDaily(daily, r) { return new Map([...daily].filter(([k]) => inRange(k, r))); }
// Auswahlfeld; `einzeln`: zusätzlich „jede Heizperiode als eigenes Diagramm“, `d30`: letzte 30 Tage
function zeitSelect({ einzeln = false, d30 = false } = {}) {
  const r = zeitraum();
  const cur = r.z === 'each' && !einzeln ? 'all' : r.z;
  const opt = (v, l) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
  return `<label class="zeit-select"><span>Zeitraum</span><select data-zeit>
    ${d30 ? opt('d30', 'Letzte 30 Tage') : ''}${opt('12m', 'Letzte 12 Monate')}${opt('all', 'Gesamt (alle Jahre)')}
    ${einzeln ? opt('each', 'Jede Heizperiode einzeln') : ''}
    <optgroup label="Heizperiode (Jul–Jun)">${seasonsAll().reverse().map(y => opt('hp:' + y, 'HP ' + y)).join('')}</optgroup>
  </select></label>`;
}
// Breite Diagramme (viele Balken) werden auf dem Handy seitlich scrollbar statt gequetscht
function chartBox(n, cls = 'chart tall', px = 9) {
  return `<div class="chart-scroll"><div class="${cls}" style="width:max(100%, ${Math.round(n * px)}px)"><canvas data-c></canvas></div></div>`;
}

// Zeitachse auf den gewählten Zeitraum begrenzen (Heizperiode immer ganz zeigen)
function timeBounds(r) {
  return r.season ? { min: S.dayDate(r.from).getTime(), max: S.dayDate(r.to).getTime() } : {};
}
// Montag einer ISO-Woche „2025-W07“
function isoMonday(key) {
  const [y, w] = key.split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  const mon = new Date(jan4); mon.setDate(jan4.getDate() - ((jan4.getDay() || 7) - 1) + (w - 1) * 7);
  return mon;
}

// Hinweis, wenn im gewählten Zeitraum keine Werte liegen
function leer(r, was = 'Wärmezählerwerte') {
  return `<div class="card empty"><strong>Keine Daten im Zeitraum</strong>Für ${esc(r.label)} gibt es keine ${was}. Bitte einen anderen Zeitraum wählen.</div>`;
}

function noData(msg = 'Für diese Auswertung braucht es mindestens zwei Ablesungen.') {
  return `<div class="card empty"><strong>Noch keine Daten</strong>${esc(msg)}</div>`;
}

export function renderStats(root) {
  destroyAll();
  renderSeq++;
  const tab = lsGet(LS_TAB, 'verbrauch');
  root.innerHTML = `
    <div class="scroll-x"><div class="seg" data-tabs>${TABS.map(([k, l]) => `<button data-k="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div data-body></div>`;
  root.querySelector('[data-tabs]').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    lsSet(LS_TAB, b.dataset.k);
    renderStats(root);
  });
  const body = root.querySelector('[data-body]');
  body.addEventListener('change', ev => {
    if (ev.target.closest('[data-split]')) { lsSet('wz.stats.split', ev.target.checked ? '1' : '0'); renderStats(root); }
    if (ev.target.matches('[data-zeit]')) { lsSet(LS_ZEIT, ev.target.value); renderStats(root); }
  });
  ({ verbrauch, kreise: kreiseTab, jahre, witterung, oel, effizienz, einstellungen })[tab]?.(body);
}

// ---------- Verbrauch ----------
function verbrauch(body) {
  const gran = lsGet(LS_GRAN, 'week');
  const mode = lsGet('wz.stats.mode', 'sum');
  const maps = heatMaps();
  const r = zeitraum();
  const days = allDayKeys(maps.map(m => m.daily));
  if (!days.length) { body.innerHTML = noData(); return; }
  const keys = S.periodRange(days.filter(k => inRange(k, r)), gran);
  const agg = maps.map(m => ({ ...m, agg: S.aggregate(m.daily, gran) }));
  const each = r.z === 'each';
  const seasons = each ? seasonsAll().filter(y => days.some(k => S.periodKey(k, 'season') === y)).reverse() : [];
  const egran = gran === 'week' ? 'week' : 'month'; // für „jede Heizperiode einzeln“
  const val = (a, k) => { const o = a.get(k); if (!o) return null; return mode === 'avg' ? (o.tage > 0 ? o.menge / o.tage : null) : o.menge; };

  body.innerHTML = `
    <div class="toolbar">
      <div class="seg" data-gran>${GRANS.map(([k, l]) => `<button data-k="${k}" class="${k === gran ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" data-mode><button data-k="sum" class="${mode === 'sum' ? 'active' : ''}">Summe</button><button data-k="avg" class="${mode === 'avg' ? 'active' : ''}">Ø pro Tag</button></div>
      ${zeitSelect({ einzeln: true })}
      ${splitToggle()}
    </div>
    ${each ? seasons.map(y => `<div class="card"><h2>Heizperiode ${y} ${mode === 'avg' ? '(Ø kWh pro Tag)' : '(kWh)'}</h2><div class="chart"><canvas data-hp="${y}"></canvas></div></div>`).join('')
      + `<p class="muted small" style="margin:-4px 2px 12px">Alle Heizperioden mit gleicher Skala – direkt vergleichbar. ${gran === 'week' ? 'Wochen' : 'Monate'} von Juli bis Juni.</p>`
    : !keys.length ? leer(r) : `<div class="card"><h2>Wärmeverbrauch ${mode === 'avg' ? '(Ø kWh pro Tag)' : '(kWh)'} · ${esc(r.label)}</h2>${chartBox(keys.length)}
      <p class="muted small">Blassere Balken: Zeitraum nur teilweise abgedeckt oder geschätzt (alte Zähler 2022/23: nur zwei Ablesungen, Verteilung nach Ölverbrauch).</p></div>`}
    <div class="card"><h2>Tabelle</h2><div class="table-wrap"><table>
      <thead><tr><th>Zeitraum</th>${agg.map(a => `<th>${esc(a.label)}</th>`).join('')}<th>Gesamt</th></tr></thead>
      <tbody>${[...keys].reverse().map(k => {
        const vs = agg.map(a => val(a.agg, k));
        const tot = vs.some(v => v !== null) ? vs.reduce((s, v) => s + (v || 0), 0) : null;
        return `<tr><td>${S.periodLabel(k, gran)}</td>${vs.map(v => `<td>${fmtAuto(v)}</td>`).join('')}<td><b>${fmtAuto(tot)}</b></td></tr>`;
      }).join('')}</tbody></table></div></div>`;

  body.querySelector('[data-gran]').onclick = ev => { const b = ev.target.closest('button'); if (b) { lsSet(LS_GRAN, b.dataset.k); verbrauch(body); } };
  body.querySelector('[data-mode]').onclick = ev => { const b = ev.target.closest('button'); if (b) { lsSet('wz.stats.mode', b.dataset.k); verbrauch(body); } };

  const tooltipFor = (ks, g) => ({
    ...baseOptions().plugins.tooltip,
    callbacks: {
      label: c => `${c.dataset.label}: ${fmtAuto(c.raw)} kWh`,
      footer: items => {
        const k = ks[items[0].dataIndex];
        const tot = items.reduce((s, i) => s + (i.raw || 0), 0);
        const ag = agg.map(a => (g === gran ? a.agg : S.aggregate(a.daily, g)).get(k));
        const cov = Math.min(...ag.map(o => o?.abdeckung ?? 0));
        return `Gesamt: ${fmtAuto(tot)} kWh` + (cov < 0.95 ? `\nnur ${Math.round(cov * 100)} % des Zeitraums abgedeckt` : '')
          + (ag.some(o => o?.geschaetzt) ? '\ngeschätzt: Jahreswert nach Ölverbrauch verteilt' : '');
      },
    },
  });
  if (!each && !keys.length) return;
  if (each) {
    // Eine Grafik je Heizperiode, gleiche y-Achse
    const eagg = agg.map(a => ({ ...a, agg: S.aggregate(a.daily, egran) }));
    const per = seasons.map(y => {
      const y0 = +y.slice(0, 4);
      return { y, keys: S.periodRange([`${y0}-07-01`, `${y0 + 1}-06-30`], egran) };
    });
    let max = 0;
    for (const p of per) for (const k of p.keys) max = Math.max(max, eagg.reduce((s, a) => s + (val(a.agg, k) || 0), 0));
    for (const p of per) {
      chart(canvas(body, `[data-hp="${p.y}"]`), {
        type: 'bar',
        data: {
          labels: p.keys.map(k => S.periodLabel(k, egran).replace(/ ’\d+/, '')),
          datasets: eagg.map(a => { const c = kreisFarbe(a.idx); return { label: a.label, data: p.keys.map(k => val(a.agg, k)), stack: 's', backgroundColor: p.keys.map(k => ((a.agg.get(k)?.abdeckung ?? 1) < 0.95 || a.agg.get(k)?.geschaetzt ? alpha(c, 0.4) : c)), borderRadius: 2, maxBarThickness: 30 }; }),
        },
        options: baseOptions({
          plugins: { legend: { ...baseOptions().plugins.legend, display: p === per[0] }, tooltip: tooltipFor(p.keys, egran) },
          scales: { x: { ...baseOptions().scales.x, stacked: true }, y: { ...baseOptions().scales.y, stacked: true, max: Math.ceil(max * 1.05) || undefined } },
        }),
      });
    }
    return;
  }
  chart(canvas(body, '[data-c]'), {
    type: 'bar',
    data: {
      labels: keys.map(k => S.periodLabel(k, gran)),
      datasets: agg.map(a => {
        const c = kreisFarbe(a.idx);
        return {
          label: a.label, data: keys.map(k => val(a.agg, k)), stack: 's',
          backgroundColor: keys.map(k => ((a.agg.get(k)?.abdeckung ?? 1) < 0.95 || a.agg.get(k)?.geschaetzt ? alpha(c, 0.4) : c)),
          borderRadius: 3, maxBarThickness: 46,
        };
      }),
    },
    options: baseOptions({
      plugins: {
        ...baseOptions().plugins,
        tooltip: {
          ...baseOptions().plugins.tooltip,
          callbacks: {
            label: c => `${c.dataset.label}: ${fmtAuto(c.raw)} kWh`,
            footer: items => {
              const k = keys[items[0].dataIndex];
              const tot = items.reduce((s, i) => s + (i.raw || 0), 0);
              const cov = Math.min(...agg.map(a => a.agg.get(k)?.abdeckung ?? 0));
              return `Gesamt: ${fmtAuto(tot)} kWh` + (cov < 0.95 ? `\nnur ${Math.round(cov * 100)} % des Zeitraums abgedeckt` : '');
            },
          },
        },
      },
      scales: { ...baseOptions().scales, x: { ...baseOptions().scales.x, stacked: true }, y: { ...baseOptions().scales.y, stacked: true } },
    }),
  });
}

// ---------- Kreise ----------
function kreiseTab(body) {
  const maps = heatMaps();
  const days = allDayKeys(maps.map(m => m.daily));
  if (!days.length) { body.innerHTML = noData(); return; }
  const r = zeitraum();
  // Monatsverlauf: bei kurzen Zeiträumen trotzdem mindestens 12 Monate zeigen
  const lr = r.z === 'd30' || r.z === '12m' ? { from: S.dayKey(new Date(Date.now() - 365 * DAYMS)), to: r.to } : r;
  const lkeys = S.periodRange(days.filter(k => inRange(k, lr)), 'month');
  const rows = maps.map(m => {
    let menge = 0, tage = 0;
    for (const [k, v] of m.daily) if (inRange(k, r)) { menge += v.menge; tage += v.abdeckung; }
    return { ...m, menge, proTag: tage ? menge / tage : null };
  });
  const total = rows.reduce((s, r) => s + r.menge, 0);
  if (!lkeys.length && !total) { body.innerHTML = `<div class="toolbar">${zeitSelect({ d30: true })}${splitToggle()}</div>` + leer(r); return; }

  body.innerHTML = `
    <div class="toolbar">${zeitSelect({ d30: true })}${splitToggle()}</div>
    <div class="grid">
      <div class="card"><h2>Anteile · ${esc(r.label)}</h2><div class="chart"><canvas data-c></canvas></div></div>
      <div class="card"><h2>Kreise im Vergleich</h2><div class="table-wrap"><table>
        <thead><tr><th>Kreis</th><th>kWh</th><th>Anteil</th><th>Ø kWh/Tag</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td><span class="swatch" style="background:${kreisFarbe(r.idx)}"></span>${esc(r.label)}</td><td>${fmtAuto(r.menge)}</td><td>${total ? fmt(r.menge / total * 100, 1) + ' %' : '–'}</td><td>${fmtAuto(r.proTag)}</td></tr>`).join('')}
        <tr><td><b>Gesamt</b></td><td><b>${fmtAuto(total)}</b></td><td></td><td><b>${fmtAuto(rows.reduce((s, r) => s + (r.proTag || 0), 0))}</b></td></tr></tbody>
      </table></div></div>
    </div>
    <div class="card"><h2>Ø kWh pro Tag je Monat</h2><div class="chart-scroll"><div class="chart" style="width:max(100%, ${Math.round(lkeys.length * 16)}px)"><canvas data-l></canvas></div></div></div>`;

  chart(canvas(body, '[data-c]'), {
    type: 'doughnut',
    data: { labels: rows.map(r => r.label), datasets: [{ data: rows.map(r => Math.max(0, r.menge)), backgroundColor: rows.map(r => kreisFarbe(r.idx)), borderColor: cssVar('--surface'), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: baseOptions().plugins.legend,
        tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: c => `${c.label}: ${fmtAuto(c.raw)} kWh (${total ? fmt(c.raw / total * 100, 1) : 0} %)` } },
      },
    },
  });

  const keys = lkeys;
  chart(canvas(body, '[data-l]'), {
    type: 'line',
    data: {
      labels: keys.map(k => S.periodLabel(k, 'month')),
      datasets: rows.map(r => {
        const a = S.aggregate(r.daily, 'month');
        return { label: r.label, data: keys.map(k => { const o = a.get(k); return o && o.tage ? o.menge / o.tage : null; }), borderColor: kreisFarbe(r.idx), backgroundColor: kreisFarbe(r.idx), tension: .3, spanGaps: true, pointRadius: 3 };
      }),
    },
    options: baseOptions({ plugins: { ...baseOptions().plugins, tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${fmtAuto(c.raw)} kWh/Tag` } } } }),
  });
}

// ---------- Jahresvergleich ----------
function seriesFor(sel) {
  if (sel === 'oel') return { daily: S.oilDaily(), unit: 'L' };
  if (sel === 'alle') return { daily: S.totalHeatDaily(), unit: 'kWh' };
  return { daily: S.heatDaily(sel), unit: 'kWh' };
}
function seriesSelect(sel) {
  return `<select data-sel style="width:auto;font-size:15px;padding:7px 30px 7px 12px">
    <option value="alle" ${sel === 'alle' ? 'selected' : ''}>Alle Kreise</option>
    ${store.kreise().map(k => `<option value="${k.id}" ${sel === k.id ? 'selected' : ''}>${esc(k.name)}${store.kreise().some(c => c.teilVon === k.id) ? ' (ganzer Zähler)' : ''}</option>`).join('')}
    <option value="oel" ${sel === 'oel' ? 'selected' : ''}>Öl (Liter)</option></select>`;
}

function jahre(body) {
  const basis = lsGet('wz.stats.jbasis', 'season');
  const sel = lsGet('wz.stats.jsel', 'alle');
  const { daily, unit } = seriesFor(sel);
  if (!daily.size) { body.innerHTML = noData(); return; }
  const month = S.aggregate(daily, 'month');
  const groups = new Map(); // Jahr/HP → Array(12)
  for (const [k, o] of month) {
    const [y, m] = k.split('-').map(Number);
    const g = basis === 'season' ? S.periodKey(k + '-01', 'season') : String(y);
    const idx = basis === 'season' ? (m + 5) % 12 : m - 1;
    if (!groups.has(g)) groups.set(g, Array(12).fill(null));
    groups.get(g)[idx] = o;
  }
  const allG = [...groups.keys()].sort();
  let hidden = [];
  try { hidden = JSON.parse(lsGet('wz.stats.jhide', '[]')); } catch { /* leer */ }
  const gkeys = allG.filter(g => !hidden.includes(g));
  const labels = basis === 'season' ? S.MONATE_HP : ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const palette = ['--text-3', '--c2', '--c4', '--c3', '--c5', '--c1'];
  const gColor = g => { const i = allG.indexOf(g); return i === allG.length - 1 ? cssVar('--accent') : cssVar(palette[Math.max(0, palette.length - allG.length + i)] || '--c1'); };

  body.innerHTML = `
    <div class="toolbar">
      <div class="seg" data-basis><button data-k="season" class="${basis === 'season' ? 'active' : ''}">Heizperiode (Jul–Jun)</button><button data-k="year" class="${basis === 'year' ? 'active' : ''}">Kalenderjahr</button></div>
      ${seriesSelect(sel)}
    </div>
    <div class="chips" data-chips><span class="muted small">Anzeigen:</span>
      ${allG.map(g => `<button type="button" class="chip ${hidden.includes(g) ? '' : 'on'}" data-g="${g}"><i style="background:${gColor(g)}"></i>${basis === 'season' ? 'HP ' : ''}${g}</button>`).join('')}
      <button type="button" class="chip link" data-g="*">${hidden.length ? 'alle' : 'keine'}</button></div>
    <div class="card"><h2>Monatsverbrauch im Vergleich (${unit})</h2><div class="chart tall"><canvas data-c></canvas></div></div>
    <div class="card"><h2>Kumuliert</h2><div class="chart"><canvas data-k></canvas></div></div>
    <div class="card"><h2>Summen</h2><div class="table-wrap"><table>
      <thead><tr><th>${basis === 'season' ? 'Heizperiode' : 'Jahr'}</th><th>${unit}</th><th>Abgedeckte Monate</th><th>Ø ${unit}/Tag</th></tr></thead>
      <tbody>${[...gkeys].reverse().map(g => {
        const arr = groups.get(g).filter(Boolean);
        const sum = arr.reduce((s, o) => s + o.menge, 0), tage = arr.reduce((s, o) => s + o.tage, 0);
        return `<tr><td>${g}</td><td>${fmtAuto(sum)}</td><td>${arr.filter(o => o.abdeckung > .95).length} / 12</td><td>${fmtAuto(tage ? sum / tage : null)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted small">Für einen fairen Vergleich unterschiedlich kalter Jahre siehe „Witterung“.</p></div>`;
  body.querySelector('[data-basis]').onclick = ev => { const b = ev.target.closest('button'); if (b) { lsSet('wz.stats.jbasis', b.dataset.k); jahre(body); } };
  body.querySelector('[data-sel]').onchange = ev => { lsSet('wz.stats.jsel', ev.target.value); jahre(body); };
  body.querySelector('[data-chips]').onclick = ev => {
    const b = ev.target.closest('[data-g]'); if (!b) return;
    const g = b.dataset.g;
    const next = g === '*' ? (hidden.length ? [] : [...allG]) : hidden.includes(g) ? hidden.filter(x => x !== g) : [...hidden, g];
    lsSet('wz.stats.jhide', JSON.stringify(next)); destroyAll(); jahre(body);
  };

  const ds = (cum) => gkeys.map(g => {
    const col = gColor(g);
    const isLast = g === allG.at(-1);
    let acc = 0;
    const data = groups.get(g).map(o => { if (!cum) return o ? o.menge : null; if (!o) return null; acc += o.menge; return acc; });
    return cum
      ? { label: g, data, borderColor: col, backgroundColor: col, borderWidth: isLast ? 3 : 2, tension: .25, spanGaps: true, pointRadius: 2 }
      : { label: g, data, backgroundColor: col, borderRadius: 3, maxBarThickness: 22 };
  });
  const tt = { ...baseOptions().plugins, tooltip: { ...baseOptions().plugins.tooltip, callbacks: { label: c => `${c.dataset.label}: ${fmtAuto(c.raw)} ${unit}` } } };
  chart(canvas(body, '[data-c]'), { type: 'bar', data: { labels, datasets: ds(false) }, options: baseOptions({ plugins: tt }) });
  chart(canvas(body, '[data-k]'), { type: 'line', data: { labels, datasets: ds(true) }, options: baseOptions({ plugins: tt }) });
}

// ---------- Witterung ----------
async function witterung(body) {
  const sel = lsGet('wz.stats.wsel', 'alle');
  const { daily, unit } = seriesFor(sel);
  if (!daily.size) { body.innerHTML = noData(); return; }
  body.innerHTML = `<div class="card empty">Lade Wetterdaten für ${esc(store.settings().ort)} …</div>`;
  let temps, normal;
  const first = [...daily.keys()].sort()[0];
  const seq = renderSeq;
  try {
    temps = await W.temperatures(first);
    normal = await W.normalGradtage().catch(() => null);
    if (seq !== renderSeq || !body.isConnected) return; // inzwischen andere Ansicht gewählt
  } catch (e) {
    body.innerHTML = noData('Wetterdaten konnten nicht geladen werden (Internetverbindung?).');
    return;
  }
  const gt = S.gradtageDaily(temps);
  const s = store.settings();

  // Monatstabelle
  const mVal = S.aggregate(daily, 'month');
  const mGt = S.aggregate(gt, 'month');
  const mT = new Map();
  for (const [k, t] of temps) { const m = k.slice(0, 7); const o = mT.get(m) || { s: 0, n: 0 }; o.s += t; o.n++; mT.set(m, o); }
  const r = zeitraum();
  const months = [...mVal.keys()].sort().filter(m => m + '-31' >= r.from && m + '-01' < r.to);
  const rows = months.map(m => {
    const v = mVal.get(m), g = mGt.get(m);
    // Gradtage nur für abgedeckte Tage zählen
    let gCov = 0;
    for (const [dk, dv] of daily) if (dk.startsWith(m)) gCov += S.gradtag(temps.get(dk) ?? 99, s) * dv.abdeckung;
    // Erst ab nennenswertem Heizbedarf (Ø ≥ 4 Gradtage pro Tag, also kühler als ~16 °C) aussagekräftig
    const proGt = v.tage > 0 && gCov / v.tage >= 4 ? v.menge / gCov : null;
    const norm = normal?.proMonat[+m.slice(5) - 1];
    return { m, menge: v.menge, abdeckung: v.abdeckung, geschaetzt: v.geschaetzt, gt: g?.menge ?? null, gCov, proGt, bereinigt: proGt !== null && norm ? proGt * norm * (v.tage / S.periodDays(m, 'month')) : null, temp: mT.get(m) ? mT.get(m).s / mT.get(m).n : null };
  });

  // Energiesignatur: Wochenmittel Verbrauch/Tag gegen Wochenmittel Temperatur
  const wVal = S.aggregate(daily, 'week');
  const wT = new Map();
  for (const [k, t] of temps) { const w = S.periodKey(k, 'week'); const o = wT.get(w) || { s: 0, n: 0 }; o.s += t; o.n++; wT.set(w, o); }
  const inR = w => { const d = S.dayKey(isoMonday(w)); return d >= r.from && d < r.to; };
  const pts = [...wVal].filter(([w, o]) => o.tage >= 3 && !o.geschaetzt && wT.get(w) && inR(w)).map(([w, o]) => ({ x: wT.get(w).s / wT.get(w).n, y: o.menge / o.tage, w }));

  body.innerHTML = `
    <div class="toolbar">${seriesSelect(sel)}${zeitSelect()}</div>
    <div class="notice">Witterungsbereinigung nach Gradtagen (VDI 3807, G ${s.innentemp}/${s.heizgrenze}): Je kälter, desto mehr Gradtage. <b>${unit} pro Gradtag</b> ist damit über milde und kalte Monate vergleichbar.${normal ? ` „Bereinigt“ rechnet auf ein durchschnittliches Jahr (${normal.jahre}) für ${esc(s.ort)} um.` : ''}</div>
    ${!rows.length ? leer(r, 'Verbrauchswerte') : ''}
    <div class="card" ${!rows.length ? 'hidden' : ''}><h2>${unit} pro Gradtag und Außentemperatur · ${esc(r.label)}</h2>${chartBox(rows.length, 'chart tall', 22)}</div>
    <div class="card"><h2>Energiesignatur (Wochen)</h2><div class="chart"><canvas data-s></canvas></div>
      <p class="muted small">Jeder Punkt ist eine Woche: Ø Außentemperatur gegen Ø Verbrauch pro Tag. Liegen neue Punkte unter der alten Wolke, heizt ihr effizienter.</p></div>
    <div class="card"><h2>Monate</h2><div class="table-wrap"><table>
      <thead><tr><th>Monat</th><th>Ø °C</th><th>${unit}</th><th>Gradtage</th><th>${unit}/Gt</th>${normal ? `<th>bereinigt ${unit}</th>` : ''}</tr></thead>
      <tbody>${[...rows].reverse().map(r => `<tr><td>${S.periodLabel(r.m, 'month')}${r.abdeckung < .95 ? ' *' : ''}${r.geschaetzt ? ' ≈' : ''}</td><td>${fmt(r.temp, 1)}</td><td>${fmtAuto(r.menge)}</td><td>${fmt(r.gt, 0)}</td><td>${r.proGt !== null ? fmt(r.proGt, 2) : '–'}</td>${normal ? `<td>${fmtAuto(r.bereinigt)}</td>` : ''}</tr>`).join('')}</tbody>
    </table></div><p class="muted small">* Monat nur teilweise abgedeckt. ≈ geschätzt (nach Ölverbrauch verteilt). In Monaten ohne Heizbedarf (kaum Gradtage) ist kein Wert sinnvoll.</p></div>`;
  body.querySelector('[data-sel]').onchange = ev => { lsSet('wz.stats.wsel', ev.target.value); witterung(body); };

  const o = baseOptions();
  chart(canvas(body, '[data-c]'), {
    data: {
      labels: rows.map(r => S.periodLabel(r.m, 'month')),
      datasets: [
        { type: 'bar', label: `${unit}/Gradtag`, data: rows.map(r => r.proGt), backgroundColor: cssVar('--accent'), borderRadius: 3, maxBarThickness: 34, yAxisID: 'y' },
        { type: 'line', label: 'Ø Außentemperatur', data: rows.map(r => r.temp), borderColor: cssVar('--c2'), backgroundColor: cssVar('--c2'), tension: .3, pointRadius: 2, yAxisID: 'y2' },
      ],
    },
    options: baseOptions({
      plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => c.dataset.yAxisID === 'y2' ? `Ø ${fmt(c.raw, 1)} °C` : `${fmt(c.raw, 2)} ${unit}/Gt` } } },
      scales: {
        x: o.scales.x,
        y: { ...o.scales.y, title: { display: true, text: `${unit}/Gt` }, ticks: { callback: v => fmt(v, 1) } },
        y2: { position: 'right', grid: { display: false }, border: { display: false }, title: { display: true, text: '°C' }, ticks: { callback: v => fmt(v) } },
      },
    }),
  });

  const now = Date.now();
  chart(canvas(body, '[data-s]'), {
    type: 'scatter',
    data: { datasets: [{
      label: 'Wochen', data: pts,
      backgroundColor: pts.map(p => { const age = (now - isoMonday(p.w)) / (365 * 86400000); return alpha(cssVar('--accent'), age < 0.5 ? 0.95 : age < 1.2 ? 0.55 : 0.25); }),
      pointRadius: 5, pointHoverRadius: 7,
    }] },
    options: baseOptions({
      interaction: { mode: 'nearest', intersect: true },
      plugins: { legend: { display: false }, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => `${S.periodLabel(c.raw.w, 'week')}: ${fmt(c.raw.x, 1)} °C → ${fmtAuto(c.raw.y)} ${unit}/Tag` } } },
      scales: {
        x: { type: 'linear', grid: { color: cssVar('--border') }, title: { display: true, text: 'Ø Außentemperatur °C' } },
        y: { ...o.scales.y, title: { display: true, text: `${unit} pro Tag` } },
      },
    }),
  });
}

// ---------- Öl ----------
function oel(body) {
  const pts = S.oilPoints();
  if (pts.length < 2) { body.innerHTML = noData('Für die Ölauswertung braucht es mindestens zwei Ablesungen mit Ölstand.'); return; }
  const daily = S.oilDaily();
  const fc = S.oilForecast();
  const gran = lsGet('wz.stats.ogran', 'week');
  const r = zeitraum();
  const keys = S.periodRange([...daily.keys()].filter(k => inRange(k, r)), gran);
  const lpts = pts.filter(p => inRange(S.dayKey(p.t), r));
  const agg = S.aggregate(daily, gran);
  const fills = store.eintraege('betankung');
  const priced = fills.filter(f => f.preis && f.liter);
  const literpreis = priced.length ? priced.reduce((s, f) => s + f.preis, 0) / priced.reduce((s, f) => s + f.liter, 0) : null;
  const tank = store.settings().tankvolumen;

  body.innerHTML = `
    <div class="card"><div class="kpis">
      <div class="kpi"><div class="label">Geschätzter Stand heute</div><div class="value">${fmt(fc.geschaetzt)}<span class="unit">L</span></div>${tank ? `<div class="muted small">${fmt(fc.geschaetzt / tank * 100)} % von ${fmt(tank)} L</div>` : ''}</div>
      <div class="kpi"><div class="label">Verbrauch aktuell</div><div class="value">${fmt(fc.proWoche, 0)}<span class="unit">L/Woche</span></div><div class="muted small">${fmt(fc.proTag, 1)} L/Tag</div></div>
      <div class="kpi"><div class="label">Reicht bis ca.</div><div class="value" style="font-size:18px">${fc.leerAm ? fc.leerAm.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }) : '–'}</div><div class="muted small">bei gleichbleibendem Verbrauch</div></div>
      ${literpreis ? `<div class="kpi"><div class="label">Ø Literpreis</div><div class="value">${fmt(literpreis, 2)}<span class="unit">€/L</span></div><div class="muted small">≈ ${fmt(fc.proWoche * literpreis, 0)} € pro Woche</div></div>` : ''}
    </div></div>
    <div class="toolbar"><div class="seg" data-gran>${GRANS.map(([k, l]) => `<button data-k="${k}" class="${k === gran ? 'active' : ''}">${l}</button>`).join('')}</div>${zeitSelect()}</div>
    <div class="card"><h2>Ölverbrauch (Liter) · ${esc(r.label)}</h2>${chartBox(keys.length, 'chart')}</div>
    <div class="card"><h2>Füllstand</h2><div class="chart"><canvas data-l></canvas></div></div>
    ${fills.length ? `<div class="card"><h2>Betankungen</h2><div class="table-wrap"><table><thead><tr><th>Datum</th><th>Liter</th><th>Preis</th><th>€/L</th></tr></thead><tbody>
      ${[...fills].reverse().map(f => `<tr><td>${fmtDate(S.parseZeit(f.zeit), false)}</td><td>${fmt(f.liter)}</td><td>${f.preis ? fmt(f.preis, 2) + ' €' : '–'}</td><td>${f.preis ? fmt(f.preis / f.liter, 3) : '–'}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}`;
  body.querySelector('[data-gran]').onclick = ev => { const b = ev.target.closest('button'); if (b) { lsSet('wz.stats.ogran', b.dataset.k); oel(body); } };

  const o = baseOptions();
  chart(canvas(body, '[data-c]'), {
    type: 'bar',
    data: { labels: keys.map(k => S.periodLabel(k, gran)), datasets: [{ label: 'Liter', data: keys.map(k => agg.get(k)?.menge ?? null), backgroundColor: keys.map(k => ((agg.get(k)?.abdeckung ?? 1) < .95 ? alpha(cssVar('--oil'), .4) : cssVar('--oil'))), borderRadius: 3, maxBarThickness: 40 }] },
    options: baseOptions({ plugins: { legend: { display: false }, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => `${fmt(c.raw)} L` } } } }),
  });
  chart(canvas(body, '[data-l]'), {
    type: 'line',
    data: { datasets: [
      { label: 'Ölstand', data: lpts.map(p => ({ x: p.t, y: p.v })), borderColor: cssVar('--oil'), backgroundColor: alpha(cssVar('--oil'), .12), fill: true, stepped: false, pointRadius: 2, tension: 0 },
      { label: 'Betankung', type: 'scatter', data: fills.filter(f => inRange(f.zeit.slice(0, 10), r)).map(f => ({ x: S.parseZeit(f.zeit), y: f.liter })), backgroundColor: cssVar('--accent'), pointStyle: 'triangle', pointRadius: 7 },
    ] },
    options: baseOptions({
      plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { title: i => fmtDate(i[0].raw.x, false), label: c => c.dataset.label === 'Betankung' ? `getankt ${fmt(c.raw.y)} L` : `${fmt(c.raw.y)} L` } } },
      scales: { x: { type: 'time', time: { tooltipFormat: 'dd.MM.yyyy', displayFormats: { month: 'MM.yy', quarter: 'MM.yy', year: 'yyyy', week: 'dd.MM.', day: 'dd.MM.' } }, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 }, ...timeBounds(r) }, y: { ...o.scales.y, ...(tank ? { max: tank } : {}) } },
    }),
  });
}

// ---------- Nutzungsgrad ----------
function effizienz(body) {
  const heat = S.totalHeatDaily();
  const oil = S.oilDaily();
  const f = store.settings().oelKwhProLiter;
  if (!heat.size || !oil.size) { body.innerHTML = noData('Dafür braucht es Ablesungen mit Wärmezählern und Ölstand im selben Zeitraum.'); return; }
  const gran = lsGet('wz.stats.egran', 'month');
  // Nur Tage, die von beiden abgedeckt sind
  // Geschätzte Wärme (nach Öl verteilt) würde den Nutzungsgrad nur nachbilden → für Teilzeiträume auslassen
  const both = [...heat.keys()].filter(k => oil.has(k) && !heat.get(k).geschaetzt);
  const h = new Map(both.map(k => [k, heat.get(k)])), o2 = new Map(both.map(k => [k, oil.get(k)]));
  const ah = S.aggregate(h, gran), ao = S.aggregate(o2, gran);
  const r = zeitraum();
  const keys = S.periodRange(both.filter(k => inRange(k, r)), gran);
  const rows = keys.map(k => {
    const w = ah.get(k)?.menge, l = ao.get(k)?.menge;
    return { k, w, l, oelKwh: l ? l * f : null, grad: w && l ? w / (l * f) : null, abdeckung: Math.min(ah.get(k)?.abdeckung ?? 0, ao.get(k)?.abdeckung ?? 0) };
  });
  if (!keys.length) { body.innerHTML = `<div class="toolbar"><div class="seg" data-gran>${GRANS.map(([k, l]) => `<button data-k="${k}" class="${k === gran ? 'active' : ''}">${l}</button>`).join('')}</div>${zeitSelect()}</div>` + leer(r, 'gemeinsamen Wärme- und Öldaten'); body.querySelector('[data-gran]').onclick = ev => { const b = ev.target.closest('button'); if (b) { lsSet('wz.stats.egran', b.dataset.k); effizienz(body); } }; return; }
  const totW = rows.reduce((s, r) => s + (r.w || 0), 0), totL = rows.reduce((s, r) => s + (r.l || 0), 0);

  body.innerHTML = `
    <div class="toolbar"><div class="seg" data-gran>${GRANS.map(([k, l]) => `<button data-k="${k}" class="${k === gran ? 'active' : ''}">${l}</button>`).join('')}</div>${zeitSelect()}</div>
    <div class="card"><div class="kpis">
      <div class="kpi"><div class="label">Nutzungsgrad · ${esc(r.label)}</div><div class="value">${totL ? fmt(totW / (totL * f) * 100, 0) : '–'}<span class="unit">%</span></div></div>
      <div class="kpi"><div class="label">Wärme gemessen</div><div class="value">${fmtAuto(totW)}<span class="unit">kWh</span></div></div>
      <div class="kpi"><div class="label">Öl eingesetzt</div><div class="value">${fmtAuto(totL)}<span class="unit">L</span></div><div class="muted small">≈ ${fmtAuto(totL * f)} kWh (${fmt(f, 1)} kWh/L)</div></div>
    </div></div>
    <div class="card"><h2>Nutzungsgrad (gemessene Wärme ÷ Energie im Öl)</h2>${chartBox(keys.length, 'chart', gran === 'week' ? 9 : 22)}
      <p class="muted small">Die Differenz sind Kessel-, Abgas- und Leitungsverluste sowie Wärme, die an keinem Zähler vorbeikommt (z. B. Warmwasser ohne Zähler). Werte über 100 % deuten auf Ablesefehler oder einen zu niedrigen Heizwert hin (Einstellungen).</p></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Zeitraum</th><th>Wärme kWh</th><th>Öl L</th><th>Öl kWh</th><th>Nutzungsgrad</th></tr></thead><tbody>
      ${[...rows].reverse().map(r => `<tr><td>${S.periodLabel(r.k, gran)}${r.abdeckung < .95 ? ' *' : ''}</td><td>${fmtAuto(r.w)}</td><td>${fmtAuto(r.l)}</td><td>${fmtAuto(r.oelKwh)}</td><td>${r.grad !== null ? fmt(r.grad * 100, 0) + ' %' : '–'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  body.querySelector('[data-gran]').onclick = ev => { const b = ev.target.closest('button'); if (b) { lsSet('wz.stats.egran', b.dataset.k); effizienz(body); } };
  const o = baseOptions();
  chart(canvas(body, '[data-c]'), {
    data: {
      labels: rows.map(r => S.periodLabel(r.k, gran)),
      datasets: [
        { type: 'line', label: 'Nutzungsgrad %', data: rows.map(r => r.grad !== null ? r.grad * 100 : null), borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent'), yAxisID: 'y2', tension: .3, spanGaps: true },
        { type: 'bar', label: 'Wärme kWh', data: rows.map(r => r.w), backgroundColor: alpha(cssVar('--c2'), .7), borderRadius: 3, maxBarThickness: 30 },
        { type: 'bar', label: 'Öl kWh', data: rows.map(r => r.oelKwh), backgroundColor: alpha(cssVar('--oil'), .5), borderRadius: 3, maxBarThickness: 30 },
      ],
    },
    options: baseOptions({
      plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => c.dataset.yAxisID === 'y2' ? `Nutzungsgrad ${fmt(c.raw, 0)} %` : `${c.dataset.label}: ${fmtAuto(c.raw)}` } } },
      scales: { x: o.scales.x, y: o.scales.y, y2: { position: 'right', min: 0, suggestedMax: 100, grid: { display: false }, border: { display: false }, ticks: { callback: v => v + ' %' } } },
    }),
  });
}

// ---------- Einstellungen vs. Verbrauch ----------
async function einstellungen(body) {
  const ser = S.settingsSeries();
  const heat = S.totalHeatDaily();
  if (!ser.length && !heat.size) { body.innerHTML = noData('Noch keine Heizungseinstellungen oder Verbräuche erfasst.'); return; }
  const r = zeitraum();
  const changes = S.settingChanges().filter(c => inRange(S.dayKey(c.t), r));
  const serR = ser.filter(p => inRange(S.dayKey(p.t), r));
  let temps = null;
  const first = [...heat.keys()].sort()[0];
  const seq = renderSeq;
  if (first) { try { temps = await W.temperatures(first); } catch { /* ohne Witterung */ } }
  if (seq !== renderSeq || !body.isConnected) return; // inzwischen andere Ansicht gewählt
  const s = store.settings();
  const LBL = { kennlinie: 'Kennlinie Tag', kennlinieNacht: 'Kennlinie Nacht', vorlaufTag: 'Vorlauf Tag', vorlaufNacht: 'Vorlauf Nacht', pumpe: 'Pumpe' };

  // Wirkung je Änderung: Ø kWh/Gradtag 14 Tage vorher vs. nachher
  const effect = ch => {
    if (!temps) return null;
    const win = (from, to) => {
      let m = 0, g = 0;
      for (const [k, v] of heat) { const d = S.dayDate(k); if (d >= from && d < to) { m += v.menge; g += S.gradtag(temps.get(k) ?? 99, s) * v.abdeckung; } }
      return g > 40 ? m / g : null; // nur mit nennenswertem Heizbedarf aussagekräftig
    };
    const t = ch.t, D = 14 * 86400000;
    return { vor: win(new Date(t - D), t), nach: win(t, new Date(+t + D)) };
  };

  body.innerHTML = `
    <div class="toolbar">${zeitSelect()}</div>
    <div class="card"><h2>Heizungseinstellungen und Wärmeverbrauch · ${esc(r.label)}</h2>${chartBox(Math.ceil((Date.parse(r.to === '9999' ? new Date() : r.to) - Date.parse(r.from === '0000' ? (first || S.dayKey(new Date())) : r.from)) / (7 * DAYMS)))}
      <p class="muted small">Balken: Ø Wärmeverbrauch aller Kreise pro Tag (Woche). Linien: Vorlauftemperaturen, Kennlinien Tag/Nacht und Pumpenstufe (rechte Achse).</p></div>
    <div class="card"><h2>Änderungen und ihre Wirkung</h2>
      ${changes.length ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Änderung</th>${temps ? '<th>kWh/Gt vorher</th><th>nachher</th><th>Δ</th>' : ''}</tr></thead><tbody>
        ${[...changes].reverse().map(ch => { const e = effect(ch); const d = e && e.vor && e.nach ? (e.nach / e.vor - 1) * 100 : null; return `<tr><td>${fmtDate(ch.t, false)}</td><td style="text-align:left;white-space:normal">${ch.diff.map(x => `${LBL[x.k]} ${fmt(x.von, x.von % 1 ? 1 : 0)} → ${fmt(x.nach, x.nach % 1 ? 1 : 0)}`).join('<br>')}</td>${temps ? `<td>${e?.vor ? fmt(e.vor, 2) : '–'}</td><td>${e?.nach ? fmt(e.nach, 2) : '–'}</td><td>${d !== null ? (d > 0 ? '+' : '') + fmt(d, 0) + ' %' : '–'}</td>` : ''}</tr>`; }).join('')}
      </tbody></table></div><p class="muted small">Vergleich je 14 Tage vor und nach der Änderung, witterungsbereinigt pro Gradtag. Kurze Zeiträume schwanken stark – als Tendenz verstehen.</p>` : '<p class="muted">Noch keine Änderungen erfasst. Sobald sich Kennlinie, Vorlauf oder Pumpenstufe zwischen zwei Ablesungen ändern, erscheint das hier.</p>'}
    </div>`;

  const wk = S.aggregate(heat, 'week');
  const bars = [...wk].filter(([k, o]) => o.tage >= 2 && inRange(S.dayKey(isoMonday(k)), r)).map(([k, o]) => {
    const mon = isoMonday(k); mon.setDate(mon.getDate() + 3);
    return { x: mon, y: o.menge / o.tage };
  }).sort((a, b) => a.x - b.x);
  const line = (k, col, dash) => ({ type: 'line', label: LBL[k], data: serR.filter(p => Number.isFinite(p[k])).map(p => ({ x: p.t, y: p[k] })), borderColor: col, backgroundColor: col, stepped: 'before', pointRadius: 2, borderWidth: 2, borderDash: dash, yAxisID: 'y2' });
  const o = baseOptions();
  chart(canvas(body, '[data-c]'), {
    data: { datasets: [
      { type: 'bar', label: 'kWh/Tag', data: bars, backgroundColor: alpha(cssVar('--accent'), .45), borderRadius: 2, barPercentage: 1, categoryPercentage: 1, maxBarThickness: 18, yAxisID: 'y' },
      line('vorlaufTag', cssVar('--c1'), []), line('vorlaufNacht', cssVar('--c2'), []), line('kennlinie', cssVar('--c3'), [5, 3]), line('kennlinieNacht', cssVar('--c5'), [5, 3]), line('pumpe', cssVar('--c4'), [2, 3]),
    ] },
    options: baseOptions({
      plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { title: i => fmtDate(i[0].raw.x, false), label: c => `${c.dataset.label}: ${fmt(c.raw.y, c.dataset.yAxisID === 'y' ? 1 : (c.raw.y % 1 ? 1 : 0))}` } } },
      scales: {
        x: { type: 'time', time: { tooltipFormat: 'dd.MM.yyyy', displayFormats: { month: 'MM.yy', quarter: 'MM.yy', year: 'yyyy', week: 'dd.MM.', day: 'dd.MM.' } }, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 }, ...timeBounds(r) },
        y: { ...o.scales.y, title: { display: true, text: 'kWh/Tag' } },
        y2: { position: 'right', grid: { display: false }, border: { display: false }, beginAtZero: true, title: { display: true, text: '°C / Stufe' } },
      },
    }),
  });
}

export function destroyCharts() { destroyAll(); }
