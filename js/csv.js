// CSV-Import (mit Spaltenzuordnung) und -Export
import * as store from './store.js';
import { esc, parseNum, dialog, toast, saveFile } from './ui.js';

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0];
  const delim = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// Akzeptiert 08.11.2026, 8.11.26, 2026-11-08, optional mit Uhrzeit (10:30)
function parseDate(s, timeStr) {
  s = (s || '').trim();
  let y, m, d, rest = '';
  let mm;
  if ((mm = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(.*)$/.exec(s))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; rest = mm[4]; if (y < 100) y += 2000; }
  else if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(s))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; rest = mm[4]; }
  else if ((mm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(.*)$/.exec(s))) { m = +mm[1]; d = +mm[2]; y = +mm[3]; rest = mm[4]; if (y < 100) y += 2000; }
  else return null;
  const t = /(\d{1,2}):(\d{2})/.exec(timeStr || rest);
  const p = n => String(n).padStart(2, '0');
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${p(m)}-${p(d)}T${t ? p(+t[1]) + ':' + t[2] : '12:00'}`;
}

function targets() {
  return [
    ['', '– ignorieren –'],
    ['datum', 'Datum (ggf. mit Uhrzeit)'],
    ['zeit', 'Uhrzeit'],
    ...store.kreise().map(k => ['k:' + k.id, `Zähler ${k.name} (kWh)`]),
    ['oel', 'Ölstand (L)'],
    ['getankt', 'Betankung (L)'],
    ['preis', 'Betankung Preis (€)'],
    ['vorlaufTag', 'Vorlauf Tag'],
    ['vorlaufNacht', 'Vorlauf Nacht'],
    ['kennlinie', 'Kennlinie'],
    ['pumpe', 'Pumpenstufe'],
    ['notiz', 'Notiz'],
  ];
}
function guess(h) {
  const s = h.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  if (/^(datum|date|tag)/.test(s)) return 'datum';
  if (/^(uhrzeit|zeit|time)$/.test(s)) return 'zeit';
  for (const k of store.kreise()) if (s.includes(k.name.toLowerCase())) return 'k:' + k.id;
  if (/tank|getankt|liefer/.test(s)) return /preis|eur|€/.test(h.toLowerCase()) ? 'preis' : 'getankt';
  if (/preis|kosten/.test(s)) return 'preis';
  if (/öl|oel|heizöl/.test(s)) return 'oel';
  if (/vorlauf.*(nacht|absenk)|nacht/.test(s)) return 'vorlaufNacht';
  if (/vorlauf/.test(s)) return 'vorlaufTag';
  if (/kennlinie|kurve|steilheit/.test(s)) return 'kennlinie';
  if (/pumpe/.test(s)) return 'pumpe';
  if (/notiz|bemerk|kommentar/.test(s)) return 'notiz';
  return '';
}

export function importDialog(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return toast('Die Datei enthält keine Datenzeilen.', true);
  const header = rows[0];
  const data = rows.slice(1);
  const opts = targets();
  const html = `<h2>CSV importieren</h2>
    <p class="muted small">${data.length} Zeilen gefunden. Bitte jeder Spalte das passende Feld zuordnen.</p>
    <div class="stack">${header.map((h, i) => `<label class="field"><span>${esc(h || 'Spalte ' + (i + 1))} <span class="muted">– z. B. „${esc(data[0][i] || '')}“</span></span>
      <select data-col="${i}">${opts.map(([v, l]) => `<option value="${v}" ${guess(h) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('')}</div>
    <p data-preview class="muted small" style="margin-top:12px"></p>
    <div class="actions"><button class="btn primary" data-ok>Importieren</button><button class="btn" data-cancel>Abbrechen</button></div>`;
  dialog(html, (root, close) => {
    const build = () => {
      const map = {};
      root.querySelectorAll('[data-col]').forEach(s => { if (s.value) map[s.value] = +s.dataset.col; });
      const out = [], errors = [];
      data.forEach((r, n) => {
        const get = k => (k in map ? r[map[k]] : undefined);
        const zeit = parseDate(get('datum'), get('zeit'));
        if (!zeit) { errors.push(n + 2); return; }
        const e = { typ: 'ablesung', zeit, werte: {} };
        for (const [k, col] of Object.entries(map)) {
          if (k.startsWith('k:')) { const v = parseNum(r[col]); if (v !== null) e.werte[k.slice(2)] = v; }
        }
        for (const k of ['oel', 'vorlaufTag', 'vorlaufNacht', 'kennlinie', 'pumpe']) { const v = parseNum(get(k)); if (v !== null) e[k] = v; }
        const notiz = (get('notiz') || '').trim(); if (notiz) e.notiz = notiz;
        const getankt = parseNum(get('getankt'));
        if (getankt) out.push({ typ: 'betankung', zeit, liter: getankt, preis: parseNum(get('preis')) ?? undefined });
        if (Object.keys(e.werte).length || ['oel', 'vorlaufTag', 'vorlaufNacht', 'kennlinie', 'pumpe'].some(k => k in e)) out.push(e);
      });
      return { out, errors, hasDate: 'datum' in map };
    };
    const preview = () => {
      const { out, errors, hasDate } = build();
      root.querySelector('[data-preview]').textContent = !hasDate ? 'Bitte eine Datumsspalte zuordnen.'
        : `${out.filter(e => e.typ === 'ablesung').length} Ablesungen, ${out.filter(e => e.typ === 'betankung').length} Betankungen werden importiert.` + (errors.length ? ` Zeilen ohne lesbares Datum werden übersprungen: ${errors.slice(0, 8).join(', ')}${errors.length > 8 ? ' …' : ''}` : '');
    };
    root.addEventListener('change', preview);
    preview();
    root.querySelector('[data-cancel]').onclick = close;
    root.querySelector('[data-ok]').onclick = () => {
      const { out, hasDate } = build();
      if (!hasDate || !out.length) return toast('Nichts zu importieren.', true);
      store.importEintraege(out);
      close();
      toast(`${out.length} Einträge importiert`);
    };
  });
}

export function exportCsv() {
  const kreise = store.kreise({ alle: true });
  const head = ['Typ', 'Datum', 'Uhrzeit', ...kreise.map(k => k.name + ' kWh'), 'Ölstand L', 'Vorlauf Tag', 'Vorlauf Nacht', 'Kennlinie', 'Pumpe', 'Getankt L', 'Preis €', 'Kreis (Wechsel)', 'Endstand alt', 'Startstand neu', 'Notiz', 'Erfasst von'];
  const n = v => (Number.isFinite(v) ? String(v).replace('.', ',') : '');
  const q = s => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const typName = { ablesung: 'Ablesung', betankung: 'Betankung', zaehlerwechsel: 'Zählerwechsel' };
  const lines = [head.join(';')];
  for (const e of store.eintraege()) {
    const [d, t] = e.zeit.split('T');
    const [y, m, dd] = d.split('-');
    lines.push([
      typName[e.typ], `${dd}.${m}.${y}`, t || '',
      ...kreise.map(k => n(e.werte?.[k.id])), n(e.oel), n(e.vorlaufTag), n(e.vorlaufNacht), n(e.kennlinie), n(e.pumpe),
      n(e.liter), n(e.preis), e.kreisId ? store.kreis(e.kreisId)?.name || '' : '', n(e.endstand), n(e.startstand),
      q(e.notiz || ''), q(e.von || ''),
    ].join(';'));
  }
  saveFile(`waermezaehler-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}
