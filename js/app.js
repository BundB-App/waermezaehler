// Einstieg: Navigation, Übersicht, Erfassen, Verlauf, Einstellungen
import * as store from './store.js';
import * as dbx from './dropbox.js';
import * as S from './stats.js';
import * as W from './weather.js';
import { formHtml, bindForm } from './forms.js';
import { renderStats, destroyCharts } from './charts.js';
import { importDialog, exportCsv } from './csv.js';
import { DROPBOX_APP_KEY } from './config.js';
import { esc, fmt, fmtAuto, fmtDate, fmtAgo, toast, dialog, confirmDialog, kreisFarbe, saveFile, parseNum } from './ui.js';

const view = document.getElementById('view');
const TITLES = { home: 'Übersicht', add: 'Erfassen', list: 'Verlauf', stats: 'Statistik', settings: 'Einstellungen' };
let current = 'home';
let addTyp = 'ablesung';

// ---------- Theme ----------
function applyTheme() {
  const t = store.localSettings().theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (current === 'stats' || current === 'home') render(); });

// ---------- Navigation ----------
function go(v, opts = {}) {
  current = v;
  if (opts.typ) addTyp = opts.typ;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.getElementById('view-title').textContent = TITLES[v];
  if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
  render();
  window.scrollTo(0, 0);
}
document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});
view.addEventListener('click', e => {
  const a = e.target.closest('[data-go]');
  if (a) { e.preventDefault(); go(a.dataset.go, { typ: a.dataset.typ }); }
});

function render() {
  destroyCharts();
  miniChart?.destroy(); miniChart = null;
  ({ home, add, list, stats: () => renderStats(view), settings })[current]();
}

// ---------- Sync-Anzeige ----------
const syncBtn = document.getElementById('sync-btn');
const syncText = document.getElementById('sync-text');
function updateSync() {
  const s = store.syncStatus();
  let state = 'idle', text = 'nur lokal';
  if (s.connected && store.dateiPfad()) {
    if (s.state === 'busy') { state = 'busy'; text = 'gleiche ab …'; }
    else if (s.state === 'err') { state = 'err'; text = 'Fehler'; }
    else if (s.state === 'offline') { state = s.dirty ? 'dirty' : 'idle'; text = 'offline'; }
    else if (s.dirty) { state = 'dirty'; text = 'nicht synchron'; }
    else if (s.lastSync) { state = 'ok'; text = 'Dropbox'; }
  } else if (s.connected) { text = 'Ordner wählen'; }
  syncBtn.dataset.state = state;
  syncText.textContent = text;
  syncBtn.title = s.message || (s.lastSync ? 'Zuletzt abgeglichen ' + fmtAgo(s.lastSync) : '');
}
syncBtn.addEventListener('click', async () => {
  const s = store.syncStatus();
  if (!s.connected || !store.dateiPfad()) return go('settings');
  try { await store.sync(); toast('Abgeglichen'); } catch (e) { toast(e.message, true); }
});

let lastSyncSeen = 0;
store.subscribe(() => {
  updateSync();
  const s = store.syncStatus();
  // Nach einem Abgleich mit neuen Daten die Ansicht aktualisieren (außer mitten in einer Eingabe)
  if (s.lastSync && s.lastSync !== lastSyncSeen) {
    lastSyncSeen = s.lastSync;
    if (current !== 'add' && current !== 'settings' && !document.querySelector('dialog[open]')) render();
  }
});

// ---------- Übersicht ----------
function home() {
  const entries = store.eintraege();
  if (!entries.length) {
    view.innerHTML = `<div class="card empty"><strong>Willkommen!</strong>
      Trage die erste Ablesung ein oder importiere vorhandene Werte aus einer CSV-Datei.
      <div class="actions" style="justify-content:center"><button class="btn primary" data-go="add">Erste Ablesung</button><button class="btn" data-go="settings">Einstellungen & Import</button></div></div>
      ${!dbx.isConnected() ? `<div class="notice">Tipp: In den Einstellungen mit Dropbox verbinden, damit beide Geräte und Nutzer dieselben Daten sehen.</div>` : ''}`;
    return;
  }
  const lastAbl = store.eintraege('ablesung').at(-1);
  const maps = store.kreise().map(k => ({ k, daily: S.heatDaily(k.id) }));
  const fc = S.oilForecast();
  const heiz = S.settingsSeries().at(-1);
  const kpi = (n) => maps.map(m => ({ m, a: S.avgPerDay(m.daily, n) }));
  const k7 = kpi(7), k30 = kpi(30);
  const sum = arr => arr.some(x => x.a) ? arr.reduce((s, x) => s + (x.a?.proTag || 0), 0) : null;

  view.innerHTML = `
    <div class="card">
      <div class="row"><div><div class="muted small">Letzte Ablesung</div>
        <div style="font-weight:650">${lastAbl ? fmtDate(S.parseZeit(lastAbl.zeit)) : '–'}</div>
        <div class="muted small">${lastAbl ? fmtAgo(S.parseZeit(lastAbl.zeit)) + (lastAbl.von ? ' · ' + esc(lastAbl.von) : '') : ''}</div></div>
        <button class="btn primary" data-go="add" data-typ="ablesung">+ Ablesung</button></div>
    </div>
    <div class="grid">
      <div class="card"><h2>Ø Wärme pro Tag</h2>
        <table><thead><tr><th>Kreis</th><th>7 Tage</th><th>30 Tage</th></tr></thead><tbody>
        ${maps.map((m, i) => `<tr><td><span class="swatch" style="background:${kreisFarbe(m.k.farbe || i + 1)}"></span>${esc(m.k.name)}</td><td>${fmtAuto(k7[i].a?.proTag)}</td><td>${fmtAuto(k30[i].a?.proTag)}</td></tr>`).join('')}
        <tr><td><b>Gesamt</b></td><td><b>${fmtAuto(sum(k7))}</b></td><td><b>${fmtAuto(sum(k30))}</b></td></tr></tbody></table>
        <p class="muted small">kWh pro Tag</p></div>
      <div class="card"><h2>Öl</h2>
        ${fc ? `<div class="kpis">
          <div class="kpi"><div class="label">Stand (geschätzt)</div><div class="value">${fmt(fc.geschaetzt)}<span class="unit">L</span></div></div>
          <div class="kpi"><div class="label">Verbrauch</div><div class="value">${fmt(fc.proWoche)}<span class="unit">L/Wo</span></div></div></div>
          <p class="muted small">${fc.leerAm ? 'Reicht bei aktuellem Verbrauch bis ca. ' + fc.leerAm.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</p>`
          : `<p class="muted">${S.oilPoints().length ? `Stand ${fmt(S.oilPoints().at(-1).v)} L – für den Verbrauch braucht es eine zweite Ablesung.` : 'Noch kein Ölstand erfasst.'}</p>`}
        <div class="actions" style="margin-top:8px"><button class="btn small" data-go="add" data-typ="betankung">+ Betankung</button></div></div>
      <div class="card"><h2>Heizung aktuell</h2>
        ${heiz ? `<div class="kpis">
          <div class="kpi"><div class="label">Vorlauf Tag</div><div class="value">${fmt(heiz.vorlaufTag, heiz.vorlaufTag % 1 ? 1 : 0)}<span class="unit">°C</span></div></div>
          <div class="kpi"><div class="label">Vorlauf Nacht</div><div class="value">${fmt(heiz.vorlaufNacht, heiz.vorlaufNacht % 1 ? 1 : 0)}<span class="unit">°C</span></div></div>
          <div class="kpi"><div class="label">Kennlinie</div><div class="value">${fmt(heiz.kennlinie)}</div></div>
          <div class="kpi"><div class="label">Pumpe</div><div class="value">${fmt(heiz.pumpe)}</div></div></div>` : '<p class="muted">Noch nichts erfasst.</p>'}</div>
    </div>
    <div class="card" style="margin-top:12px"><h2>Letzte 12 Wochen (kWh)</h2><div class="chart short"><canvas data-mini></canvas></div>
      <div class="actions"><button class="btn small" data-go="stats">Alle Auswertungen →</button></div></div>
    ${!dbx.isConnected() ? `<div class="notice">Die Daten liegen bisher nur auf diesem Gerät. <a href="#settings" data-go="settings">Mit Dropbox verbinden</a></div>` : ''}`;

  // Mini-Diagramm
  const days = new Set(); maps.forEach(m => m.daily.forEach((_, k) => days.add(k)));
  const keys = S.periodRange([...days], 'week').slice(-12);
  if (!keys.length) return;
  const c = view.querySelector('[data-mini]');
  const ds = maps.map((m, i) => { const a = S.aggregate(m.daily, 'week'); return { label: m.k.name, data: keys.map(k => a.get(k)?.menge ?? null), backgroundColor: kreisFarbe(m.k.farbe || i + 1), stack: 's', borderRadius: 2 }; });
  miniChart = new Chart(c, {
      type: 'bar', data: { labels: keys.map(k => S.periodLabel(k, 'week').replace(/ ’\d+/, '')), datasets: ds },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: x => `${x.dataset.label}: ${fmtAuto(x.raw)} kWh` } } },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--border') } } } },
  });
}
let miniChart = null;

// ---------- Erfassen ----------
function add() {
  const tabs = [['ablesung', 'Ablesung'], ['betankung', 'Betankung'], ['zaehlerwechsel', 'Zählerwechsel']];
  view.innerHTML = `
    <div class="seg full" data-typ style="margin-bottom:12px">${tabs.map(([k, l]) => `<button type="button" data-k="${k}" class="${k === addTyp ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="card">${formHtml(addTyp)}</div>`;
  view.querySelector('[data-typ]').onclick = e => { const b = e.target.closest('button'); if (b) { addTyp = b.dataset.k; add(); } };
  bindForm(view, null, () => { addTyp = 'ablesung'; go('home'); });
}

// ---------- Verlauf ----------
function list() {
  const filter = sessionStorage.getItem('wz.list.filter') || 'alle';
  const all = store.eintraege().reverse();
  const entries = filter === 'alle' ? all : all.filter(e => e.typ === filter);
  const kreise = store.kreise({ alle: true });
  const LBL = { betankung: '<span class="tag fill">Betankung</span>', zaehlerwechsel: '<span class="tag swap">Zählerwechsel</span>' };
  const group = new Map();
  for (const e of entries) {
    const d = S.parseZeit(e.zeit);
    const k = d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    if (!group.has(k)) group.set(k, []);
    group.get(k).push(e);
  }
  const vals = e => {
    if (e.typ === 'betankung') return [`${fmt(e.liter)} L getankt`, e.preis ? `${fmt(e.preis, 2)} €` : null];
    if (e.typ === 'zaehlerwechsel') return [store.kreis(e.kreisId)?.name, Number.isFinite(e.endstand) ? `alt ${fmtAuto(e.endstand)}` : null, `neu ${fmtAuto(e.startstand)}`];
    return [
      ...kreise.filter(k => Number.isFinite(e.werte?.[k.id])).map(k => `${esc(k.name)} ${fmt(e.werte[k.id], e.werte[k.id] % 1 ? 1 : 0)}`),
      Number.isFinite(e.oel) ? `Öl ${fmt(e.oel)} L` : null,
      Number.isFinite(e.vorlaufTag) || Number.isFinite(e.vorlaufNacht) ? `VL ${fmt(e.vorlaufTag)}/${fmt(e.vorlaufNacht)} °C` : null,
      Number.isFinite(e.kennlinie) ? `KL ${fmt(e.kennlinie)}` : null,
      Number.isFinite(e.pumpe) ? `P${e.pumpe}` : null,
    ];
  };
  view.innerHTML = `
    <div class="toolbar"><div class="seg" data-filter>${[['alle', 'Alle'], ['ablesung', 'Ablesungen'], ['betankung', 'Betankungen'], ['zaehlerwechsel', 'Wechsel']].map(([k, l]) => `<button data-k="${k}" class="${k === filter ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    ${!entries.length ? '<div class="card empty"><strong>Keine Einträge</strong>Neue Werte unter „Erfassen“ eintragen.</div>' : ''}
    ${[...group].map(([m, es]) => `<div class="section-title">${esc(m)}</div><div class="card" style="padding:4px 16px"><ul class="list">
      ${es.map(e => `<li data-id="${e.id}"><div class="row"><div>${LBL[e.typ] || ''}<b>${fmtDate(S.parseZeit(e.zeit))}</b></div><span class="meta">${esc(e.von || '')}</span></div>
        <div class="vals">${vals(e).filter(Boolean).map(v => `<span>${v}</span>`).join('')}</div>
        ${e.notiz ? `<div class="meta" style="margin-top:4px">${esc(e.notiz)}</div>` : ''}</li>`).join('')}
    </ul></div>`).join('')}`;
  view.querySelector('[data-filter]').onclick = ev => { const b = ev.target.closest('button'); if (b) { sessionStorage.setItem('wz.list.filter', b.dataset.k); list(); } };
  view.querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', () => {
    const e = store.eintrag(li.dataset.id);
    const titles = { ablesung: 'Ablesung bearbeiten', betankung: 'Betankung bearbeiten', zaehlerwechsel: 'Zählerwechsel bearbeiten' };
    dialog(`<div class="row" style="margin-bottom:8px"><h2 style="margin:0">${titles[e.typ]}</h2><button class="btn small" data-close>Schließen</button></div>${formHtml(e.typ, e)}`, (root, close) => {
      root.querySelector('[data-close]').onclick = close;
      bindForm(root, e, () => { close(); list(); });
    });
  }));
}

// ---------- Einstellungen ----------
function settings() {
  const s = store.settings();
  const l = store.localSettings();
  const connected = dbx.isConnected();
  const redirect = location.origin + location.pathname;
  const st = store.syncStatus();
  view.innerHTML = `
    <div class="section-title">Dropbox-Abgleich</div>
    <div class="card stack">
      ${connected ? `
        <div class="row"><div><b>Verbunden</b>${dbx.accountName() ? ' als ' + esc(dbx.accountName()) : ''}<div class="muted small">${st.lastSync ? 'Zuletzt abgeglichen ' + fmtAgo(st.lastSync) : 'Noch nicht abgeglichen'}${st.state === 'err' ? ` · <span style="color:var(--err)">${esc(st.message)}</span>` : ''}</div></div>
          <button class="btn small" data-logout>Trennen</button></div>
        <label class="field"><span>Ordner bzw. Datei in der Dropbox</span>
          <div class="row" style="gap:8px"><input name="dateiPfad" value="${esc(l.dateiPfad)}" placeholder="/Heizung"><button class="btn" data-browse>Wählen…</button></div>
          <span class="hint">Den geteilten Ordner wählen. Die Daten liegen darin als <code>waermezaehler-daten.json</code>. Bei geteilten Ordnern kann der Pfad bei jedem Nutzer anders aussehen – deshalb stellt jeder ihn selbst ein.</span></label>
        <div class="actions" style="margin-top:4px"><button class="btn primary" data-savepath>Speichern & abgleichen</button></div>`
      : `
        <p class="muted" style="margin-top:0">Verbinde die App mit deinem Dropbox-Konto. Die Daten landen als JSON-Datei in einem (geteilten) Ordner – so sehen alle Geräte und beide Nutzer denselben Stand.</p>
        ${DROPBOX_APP_KEY ? '' : `<label class="field"><span>Dropbox App-Key</span><input name="appkey" value="${esc(dbx.appKey())}" placeholder="z. B. a1b2c3d4e5f6g7h" autocomplete="off" autocapitalize="off"></label>`}
        <button class="btn primary" data-login>Mit Dropbox verbinden</button>
        <details><summary>Einmalige Einrichtung der Dropbox-App</summary>
          <ol class="steps small">
            <li><a href="https://www.dropbox.com/developers/apps/create" target="_blank" rel="noopener">dropbox.com/developers/apps/create</a> öffnen.</li>
            <li>„Scoped access“ → <b>„Full Dropbox“</b> (nötig für geteilte Ordner), Name z. B. „Waermezaehler-Haus“.</li>
            <li>Tab <b>Permissions</b>: <code>files.metadata.read</code>, <code>files.content.read</code>, <code>files.content.write</code>, <code>account_info.read</code> anhaken → Submit.</li>
            <li>Tab <b>Settings</b> → OAuth 2 → Redirect URIs: <code>${esc(redirect)}</code> hinzufügen. „Allow public clients (Implicit Grant & PKCE)“ auf <b>Allow</b>.</li>
            <li>Für den zweiten Nutzer: unter Settings „Development users“ → <b>Enable additional users</b> (bis 500 Nutzer ohne Freigabe-Prozess).</li>
            <li>Den <b>App key</b> oben eintragen und verbinden.</li>
          </ol></details>`}
    </div>

    <div class="section-title">Allgemein</div>
    <div class="card stack">
      <label class="field"><span>Mein Name (für „erfasst von“)</span><input name="name" value="${esc(l.name)}" placeholder="${esc(dbx.accountName() || 'z. B. Thomas')}"></label>
      <div class="field"><span>Darstellung</span><div class="seg" data-theme>${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, n]) => `<button data-k="${k}" class="${(l.theme || 'auto') === k ? 'active' : ''}">${n}</button>`).join('')}</div></div>
    </div>

    <div class="section-title">Kreise</div>
    <div class="card" style="padding:4px 16px"><ul class="list" data-kreise>
      ${store.kreise({ alle: true }).map((k, i, arr) => `<li data-id="${k.id}" style="cursor:default"><div class="row" style="flex-wrap:wrap">
        <div><span class="swatch" style="background:${kreisFarbe(k.farbe || i + 1)}"></span><b>${esc(k.name)}</b>${k.archiviert ? ' <span class="tag">archiviert</span>' : ''}</div>
        <div style="display:flex;gap:6px">
          <button class="btn small" data-up ${i === 0 ? 'disabled' : ''} aria-label="nach oben">↑</button>
          <button class="btn small" data-down ${i === arr.length - 1 ? 'disabled' : ''} aria-label="nach unten">↓</button>
          <button class="btn small" data-rename>Umbenennen</button>
          <button class="btn small" data-archive>${k.archiviert ? 'Aktivieren' : 'Archivieren'}</button></div></div></li>`).join('')}
    </ul><div class="actions" style="margin:4px 0 12px"><button class="btn small" data-addkreis>+ Kreis hinzufügen</button></div></div>

    <div class="section-title">Standort & Witterung</div>
    <div class="card stack">
      <label class="field"><span>Ort (für Außentemperaturen)</span>
        <div class="row" style="gap:8px"><input name="ortsuche" value="${esc(s.ort)}"><button class="btn" data-geo>Suchen</button></div>
        <span class="hint">${fmt(s.lat, 4)}° N, ${fmt(s.lon, 4)}° O · Daten: Open-Meteo</span></label>
      <div class="fields">
        <label class="field"><span>Heizgrenze (°C)</span><input name="heizgrenze" inputmode="decimal" value="${s.heizgrenze}"></label>
        <label class="field"><span>Raumtemperatur (°C)</span><input name="innentemp" inputmode="decimal" value="${s.innentemp}"></label>
      </div>
      <p class="muted small">Gradtage nach VDI 3807: Tage mit Tagesmittel unter der Heizgrenze zählen mit (Raumtemperatur − Außentemperatur).</p>
    </div>

    <div class="section-title">Öl & Anlage</div>
    <div class="card stack">
      <div class="fields">
        <label class="field"><span>Heizwert Öl (kWh/L)</span><input name="oelKwhProLiter" inputmode="decimal" value="${String(s.oelKwhProLiter).replace('.', ',')}"><span class="hint">Heizöl EL ≈ 10,0 (Hi) bzw. 10,6 (Hs)</span></label>
        <label class="field"><span>Tankvolumen (L)</span><input name="tankvolumen" inputmode="decimal" value="${s.tankvolumen ?? ''}" placeholder="optional"></label>
        <label class="field"><span>Kennlinie von</span><input name="kennlinieMin" inputmode="numeric" value="${s.kennlinieMin}"></label>
        <label class="field"><span>Kennlinie bis</span><input name="kennlinieMax" inputmode="numeric" value="${s.kennlinieMax}"></label>
      </div>
      <div class="actions" style="margin-top:4px"><button class="btn primary" data-savesettings>Speichern</button></div>
    </div>

    <div class="section-title">Daten</div>
    <div class="card stack">
      <div class="actions" style="margin-top:0">
        <label class="btn">CSV importieren<input type="file" accept=".csv,.txt,text/csv" data-csv hidden></label>
        <button class="btn" data-exportcsv>CSV exportieren</button>
        <button class="btn" data-backup>Backup (JSON)</button>
        <label class="btn">Backup einspielen<input type="file" accept=".json,application/json" data-restore hidden></label>
      </div>
      <p class="muted small">CSV aus Excel/Numbers: erste Zeile mit Spaltennamen, Datum als TT.MM.JJJJ. Beim Import ordnest du die Spalten zu.</p>
    </div>
    <p class="muted small" style="text-align:center;margin:24px 0">Wärmezähler · ${store.eintraege().length} Einträge</p>`;

  const $ = sel => view.querySelector(sel);
  const inp = n => view.querySelector(`[name="${n}"]`);

  $('[data-login]')?.addEventListener('click', async () => {
    const k = inp('appkey');
    if (k) { if (!k.value.trim()) return toast('Bitte zuerst den App-Key eintragen.', true); dbx.setAppKey(k.value); }
    try { await dbx.login(); } catch (e) { toast(e.message, true); }
  });
  $('[data-logout]')?.addEventListener('click', async () => {
    if (await confirmDialog('Verbindung zur Dropbox trennen? Die Daten bleiben auf diesem Gerät und in der Dropbox erhalten.', 'Trennen')) { dbx.logout(); settings(); updateSync(); }
  });
  $('[data-browse]')?.addEventListener('click', () => folderPicker(p => { inp('dateiPfad').value = p; }));
  $('[data-savepath]')?.addEventListener('click', async () => {
    store.saveLocal({ dateiPfad: inp('dateiPfad').value.trim() });
    if (!store.dateiPfad()) return toast('Bitte einen Ordner angeben.', true);
    try { await store.sync(); toast('Abgeglichen'); } catch (e) { toast(e.message, true); }
    settings();
  });
  inp('name').addEventListener('change', e => { store.saveLocal({ name: e.target.value.trim() }); toast('Gespeichert'); });
  $('[data-theme]').onclick = e => { const b = e.target.closest('button'); if (!b) return; store.saveLocal({ theme: b.dataset.k }); applyTheme(); settings(); };

  // Kreise
  const kreisList = store.kreise({ alle: true });
  view.querySelectorAll('[data-kreise] li').forEach(li => {
    const k = store.kreis(li.dataset.id);
    const i = kreisList.findIndex(x => x.id === k.id);
    const swap = j => {
      const other = kreisList[j];
      const a = k.reihenfolge ?? i, b = other.reihenfolge ?? j;
      store.saveKreis({ ...k, reihenfolge: b === a ? j : b });
      store.saveKreis({ ...other, reihenfolge: b === a ? i : a });
      settings();
    };
    li.querySelector('[data-up]').onclick = () => swap(i - 1);
    li.querySelector('[data-down]').onclick = () => swap(i + 1);
    li.querySelector('[data-rename]').onclick = () => {
      const n = prompt('Neuer Name für den Kreis:', k.name);
      if (n && n.trim()) { store.saveKreis({ ...k, name: n.trim() }); settings(); }
    };
    li.querySelector('[data-archive]').onclick = async () => {
      if (!k.archiviert && !(await confirmDialog(`„${k.name}“ archivieren? Er verschwindet aus Formular und Statistik, alle Werte bleiben erhalten.`, 'Archivieren'))) return;
      store.saveKreis({ ...k, archiviert: !k.archiviert }); settings();
    };
  });
  $('[data-addkreis]').onclick = () => {
    const n = prompt('Name des neuen Kreises:');
    if (!n || !n.trim()) return;
    const all = store.kreise({ alle: true });
    store.saveKreis({ name: n.trim(), farbe: all.length + 1, reihenfolge: Math.max(0, ...all.map(x => x.reihenfolge || 0)) + 1, archiviert: false });
    settings();
  };

  // Standort
  $('[data-geo]').onclick = async () => {
    const q = inp('ortsuche').value.trim();
    if (!q) return;
    try {
      const res = await W.geocode(q);
      if (!res.length) return toast('Ort nicht gefunden.', true);
      dialog(`<h2>Ort wählen</h2><ul class="list">${res.map((r, i) => `<li data-i="${i}">${esc(r.name)}<div class="meta">${fmt(r.lat, 3)}, ${fmt(r.lon, 3)}</div></li>`).join('')}</ul>`, (root, close) => {
        root.querySelectorAll('li').forEach(li => li.onclick = () => {
          const r = res[+li.dataset.i];
          store.saveSettings({ ort: r.name, lat: r.lat, lon: r.lon });
          close(); settings(); toast('Standort gespeichert');
        });
      });
    } catch { toast('Ortssuche nicht erreichbar.', true); }
  };

  $('[data-savesettings]').onclick = () => {
    const n = (name, d) => parseNum(inp(name).value) ?? d;
    const min = Math.round(n('kennlinieMin', 10)), max = Math.round(n('kennlinieMax', 25));
    store.saveSettings({
      heizgrenze: n('heizgrenze', 15), innentemp: n('innentemp', 20),
      oelKwhProLiter: n('oelKwhProLiter', 10), tankvolumen: n('tankvolumen', null),
      kennlinieMin: Math.min(min, max), kennlinieMax: Math.max(min, max),
    });
    toast('Gespeichert');
  };

  // Daten
  $('[data-csv]').onchange = async e => { const f = e.target.files[0]; if (f) importDialog(await f.text()); e.target.value = ''; };
  $('[data-exportcsv]').onclick = exportCsv;
  $('[data-backup]').onclick = () => saveFile(`waermezaehler-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store.exportData(), null, 1), 'application/json');
  $('[data-restore]').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.eintraege)) throw new Error();
      if (!(await confirmDialog(`Backup mit ${d.eintraege.length} Einträgen einspielen? Es wird mit den vorhandenen Daten zusammengeführt.`, 'Einspielen'))) return;
      store.replaceAll(d); toast('Backup eingespielt'); settings();
    } catch { toast('Keine gültige Backup-Datei.', true); }
  };
}

function folderPicker(onPick) {
  let path = '';
  dialog(`<div class="row"><h2 style="margin:0">Ordner wählen</h2><button class="btn small" data-close>Abbrechen</button></div>
    <p class="muted small" data-path></p><ul class="list" data-list><li class="muted">Lade …</li></ul>
    <div class="actions"><button class="btn primary" data-pick>Diesen Ordner verwenden</button><button class="btn" data-new>Neuer Ordner</button></div>`, (root, close) => {
    const load = async () => {
      root.querySelector('[data-path]').textContent = 'Dropbox' + (path || '/');
      const ul = root.querySelector('[data-list]');
      ul.innerHTML = '<li class="muted">Lade …</li>';
      try {
        const fs = await dbx.listFolders(path || '/');
        ul.innerHTML = (path ? '<li data-up>⬆︎ übergeordneter Ordner</li>' : '') + (fs.length ? fs.map(f => `<li data-p="${esc(f.path)}">📁 ${esc(f.name)}</li>`).join('') : '<li class="muted">keine Unterordner</li>');
        ul.querySelector('[data-up]')?.addEventListener('click', () => { path = path.split('/').slice(0, -1).join('/'); load(); });
        ul.querySelectorAll('[data-p]').forEach(li => li.onclick = () => { path = li.dataset.p; load(); });
      } catch (e) { ul.innerHTML = `<li style="color:var(--err)">${esc(e.message)}</li>`; }
    };
    root.querySelector('[data-close]').onclick = close;
    root.querySelector('[data-pick]').onclick = () => { if (!path) return toast('Bitte einen Ordner öffnen.', true); onPick(path); close(); };
    root.querySelector('[data-new]').onclick = async () => {
      const n = prompt('Name des neuen Ordners:', 'Heizung');
      if (!n) return;
      try { await dbx.createFolder((path || '') + '/' + n.trim()); path = (path || '') + '/' + n.trim(); load(); } catch (e) { toast(e.message, true); }
    };
    load();
  });
}

// ---------- Start ----------
(async function start() {
  try {
    if (await dbx.handleRedirect()) { toast('Mit Dropbox verbunden – jetzt Ordner wählen'); go('settings'); }
  } catch (e) { toast(e.message, true); }
  const h = location.hash.slice(1);
  if (TITLES[h] && current !== 'settings') go(h); else if (current !== 'settings') go('home');
  updateSync();
  store.sync().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
