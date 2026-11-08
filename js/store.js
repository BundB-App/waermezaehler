// Datenhaltung: lokal (localStorage) + Abgleich mit einer JSON-Datei in der Dropbox.
// Jeder Datensatz hat eine id und einen Zeitstempel `geaendert`. Beim Abgleich gewinnt pro id
// die jüngere Version; Löschungen bleiben als `geloescht: true` erhalten, damit sie sich verbreiten.
import * as dbx from './dropbox.js';
import { DEFAULT_FILE } from './config.js';

const LS_DATA = 'wz.data';
const LS_META = 'wz.meta';
const LS_LOCAL = 'wz.local';

export const DEFAULT_SETTINGS = {
  ort: 'Radeberg (01454)',
  lat: 51.1167,
  lon: 13.9167,
  oelKwhProLiter: 10.0,
  heizgrenze: 15,
  innentemp: 20,
  tankvolumen: null,
  kennlinieMin: 10,
  kennlinieMax: 25,
  warnAktiv: true,
  warnSchwelle: 25,
  warnTage: 14,
  ngSchwelle: 10,
  geaendert: 0,
};

function defaultData() {
  // Feste IDs, damit zwei frisch gestartete Geräte dieselben Kreise haben.
  return {
    version: 1,
    kreise: [
      { id: 'k-ug', name: 'EG', farbe: 1, reihenfolge: 1, archiviert: false, geaendert: 0 },
      { id: 'k-og', name: 'OG', farbe: 2, reihenfolge: 2, archiviert: false, geaendert: 0 },
      { id: 'k-studio', name: 'Studio', farbe: 3, reihenfolge: 3, teilVon: 'k-ug', archiviert: false, geaendert: 0 },
    ],
    eintraege: [],
    einstellungen: { ...DEFAULT_SETTINGS },
  };
}

let data = load(LS_DATA) || defaultData();
let meta = load(LS_META) || { rev: null, dirty: false, lastSync: null };
let local = load(LS_LOCAL) || {};
let status = { state: 'idle', message: '' };
const listeners = new Set();

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function persist() {
  localStorage.setItem(LS_DATA, JSON.stringify(data));
  localStorage.setItem(LS_META, JSON.stringify(meta));
}
function emit() { listeners.forEach(fn => fn()); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- Lesen ----------
export function kreise({ alle = false } = {}) {
  return data.kreise
    .filter(k => !k.geloescht && (alle || !k.archiviert))
    .sort((a, b) => (a.reihenfolge ?? 0) - (b.reihenfolge ?? 0));
}
export function kreis(id) { return data.kreise.find(k => k.id === id); }
export function eintraege(typ) {
  return data.eintraege
    .filter(e => !e.geloescht && (!typ || e.typ === typ))
    .sort((a, b) => a.zeit.localeCompare(b.zeit));
}
export function eintrag(id) { return data.eintraege.find(e => e.id === id); }
export function settings() { return { ...DEFAULT_SETTINGS, ...data.einstellungen }; }
export function localSettings() { return { dateiPfad: '', name: '', ...local }; }
export function syncStatus() { return { ...status, dirty: meta.dirty, lastSync: meta.lastSync, connected: dbx.isConnected() }; }

export function benutzer() { return local.name || dbx.accountName() || 'Ich'; }

// ---------- Schreiben ----------
function touch() { meta.dirty = true; persist(); emit(); scheduleSync(); }

export function saveEintrag(e) {
  const now = Date.now();
  const existing = data.eintraege.findIndex(x => x.id === e.id);
  const rec = { ...e, id: e.id || uid(), geaendert: now };
  if (existing >= 0) {
    rec.von = data.eintraege[existing].von || benutzer();
    data.eintraege[existing] = rec;
  } else {
    rec.von = benutzer();
    rec.erstellt = now;
    data.eintraege.push(rec);
  }
  touch();
  return rec;
}
export function deleteEintrag(id) {
  const i = data.eintraege.findIndex(x => x.id === id);
  if (i < 0) return;
  data.eintraege[i] = { id, typ: data.eintraege[i].typ, zeit: data.eintraege[i].zeit, geloescht: true, geaendert: Date.now() };
  touch();
}
export function saveKreis(k) {
  const i = data.kreise.findIndex(x => x.id === k.id);
  const rec = { ...k, id: k.id || 'k-' + uid().slice(0, 8), geaendert: Date.now() };
  if (i >= 0) data.kreise[i] = rec; else data.kreise.push(rec);
  touch();
  return rec;
}
export function saveSettings(patch) {
  data.einstellungen = { ...settings(), ...patch, geaendert: Date.now() };
  touch();
}
export function saveLocal(patch) {
  local = { ...local, ...patch };
  localStorage.setItem(LS_LOCAL, JSON.stringify(local));
  emit();
}
export function importEintraege(list) {
  const now = Date.now();
  list.forEach(e => data.eintraege.push({ ...e, id: e.id || uid(), von: e.von || benutzer(), erstellt: now, geaendert: now }));
  touch();
}
export function replaceAll(newData) {
  // Backup-Wiederherstellung: Datensätze übernehmen und als neu markieren, damit sie sich durchsetzen.
  const now = Date.now();
  const merged = merge(data, newData);
  merged.eintraege.forEach(e => (e.geaendert = Math.max(e.geaendert || 0, now)));
  data = merged;
  touch();
}
export function exportData() { return canonical(data); }

// ---------- Abgleich ----------
function mergeById(a = [], b = []) {
  const m = new Map();
  for (const x of a) m.set(x.id, x);
  for (const y of b) {
    const x = m.get(y.id);
    if (!x || (y.geaendert || 0) > (x.geaendert || 0)) m.set(y.id, y);
  }
  return [...m.values()];
}
export function merge(a, b) {
  if (!b) return a;
  const sa = a.einstellungen || {}, sb = b.einstellungen || {};
  return {
    version: 1,
    kreise: mergeById(a.kreise, b.kreise),
    eintraege: mergeById(a.eintraege, b.eintraege),
    einstellungen: (sb.geaendert || 0) > (sa.geaendert || 0) ? sb : sa,
  };
}
function canonical(d) {
  const sortId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  return {
    version: 1,
    kreise: [...d.kreise].sort(sortId),
    eintraege: [...d.eintraege].sort((x, y) => (x.zeit || '').localeCompare(y.zeit || '') || sortId(x, y)),
    einstellungen: d.einstellungen,
  };
}

export function dateiPfad() {
  const p = (local.dateiPfad || '').trim();
  if (!p) return '';
  return p.endsWith('.json') ? p : p.replace(/\/+$/, '') + '/' + DEFAULT_FILE;
}

function setStatus(state, message = '') { status = { state, message }; emit(); }

let syncing = null;
let timer = null;
function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(() => sync().catch(() => {}), 800);
}

export function sync() {
  if (syncing) return syncing;
  syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  if (!dbx.isConnected() || !dateiPfad()) { setStatus('idle'); return; }
  if (!navigator.onLine) { setStatus('offline', 'Offline'); return; }
  setStatus('busy');
  const path = dateiPfad();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await dbx.download(path);
      let remoteData = null;
      if (remote) {
        try { remoteData = JSON.parse(remote.text); } catch { throw new Error('Die Datei in der Dropbox ist kein gültiges JSON.'); }
      }
      const merged = canonical(merge(data, remoteData));
      const mergedText = JSON.stringify(merged, null, 1);
      if (remoteData && JSON.stringify(canonical(remoteData), null, 1) === mergedText) {
        data = merged; meta.rev = remote.rev; meta.dirty = false; meta.lastSync = Date.now();
        persist(); setStatus('ok'); return;
      }
      try {
        const rev = await dbx.upload(path, mergedText, remote?.rev);
        data = merged; meta.rev = rev; meta.dirty = false; meta.lastSync = Date.now();
        persist(); setStatus('ok'); return;
      } catch (e) {
        if (e instanceof dbx.DropboxError && e.status === 409 && e.summary.includes('conflict')) continue; // jemand war schneller → neu laden & mischen
        throw e;
      }
    }
    throw new Error('Abgleich nach mehreren Versuchen fehlgeschlagen.');
  } catch (e) {
    let msg = e.message || String(e);
    if (e instanceof dbx.DropboxError && e.summary.includes('not_found')) msg = 'Ordner nicht gefunden – Pfad in den Einstellungen prüfen.';
    setStatus('err', msg);
    throw new Error(msg);
  }
}

// Automatisch abgleichen beim Start, beim Zurückkehren in die App und alle 5 Minuten.
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync().catch(() => {}); });
window.addEventListener('online', () => sync().catch(() => {}));
setInterval(() => { if (!document.hidden) sync().catch(() => {}); }, 5 * 60 * 1000);
