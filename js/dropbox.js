// Dropbox-Anbindung ohne SDK: OAuth 2 mit PKCE (kein Server, kein Secret) + Dateizugriff.
import { DROPBOX_APP_KEY } from './config.js';

const LS_AUTH = 'wz.dropbox.auth';
const LS_PKCE = 'wz.dropbox.pkce';
const LS_KEY = 'wz.dropbox.appkey';

export function appKey() {
  return DROPBOX_APP_KEY || localStorage.getItem(LS_KEY) || '';
}
export function setAppKey(k) {
  localStorage.setItem(LS_KEY, k.trim());
}

function redirectUri() {
  return location.origin + location.pathname;
}

function loadAuth() {
  try { return JSON.parse(localStorage.getItem(LS_AUTH)) || null; } catch { return null; }
}
function saveAuth(a) {
  if (a) localStorage.setItem(LS_AUTH, JSON.stringify(a)); else localStorage.removeItem(LS_AUTH);
}

export function isConnected() {
  return !!loadAuth()?.refresh_token;
}
export function accountName() {
  return loadAuth()?.name || '';
}

function b64url(bytes) {
  let s = '';
  bytes.forEach(b => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const key = appKey();
  if (!key) throw new Error('Kein Dropbox App-Key hinterlegt.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  localStorage.setItem(LS_PKCE, JSON.stringify({ verifier, state }));
  const p = new URLSearchParams({
    client_id: key,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri(),
    token_access_type: 'offline',
    state,
  });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + p;
}

// Nach dem Redirect von Dropbox aufrufen. Gibt true zurück, wenn ein Login abgeschlossen wurde.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code && !q.get('error')) return false;
  history.replaceState(null, '', redirectUri() + location.hash);
  if (!code) throw new Error('Dropbox-Anmeldung abgebrochen.');
  const pkce = JSON.parse(localStorage.getItem(LS_PKCE) || '{}');
  localStorage.removeItem(LS_PKCE);
  if (!pkce.verifier || pkce.state !== q.get('state')) throw new Error('Anmeldung ungültig, bitte erneut versuchen.');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      code_verifier: pkce.verifier,
      client_id: appKey(),
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error('Token-Abruf fehlgeschlagen: ' + (await res.text()));
  const t = await res.json();
  const auth = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires: Date.now() + (t.expires_in - 60) * 1000,
  };
  saveAuth(auth);
  try {
    const acc = await rpc('users/get_current_account', null);
    auth.name = acc.name?.given_name || acc.name?.display_name || acc.email;
    auth.account_id = acc.account_id;
    saveAuth(auth);
  } catch { /* Name ist optional */ }
  return true;
}

export function logout() {
  saveAuth(null);
}

async function token() {
  const a = loadAuth();
  if (!a) throw new Error('Nicht mit Dropbox verbunden.');
  if (a.access_token && a.expires > Date.now()) return a.access_token;
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: appKey() }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) saveAuth(null);
    throw new Error('Dropbox-Anmeldung abgelaufen, bitte neu verbinden.');
  }
  const t = await res.json();
  a.access_token = t.access_token;
  a.expires = Date.now() + (t.expires_in - 60) * 1000;
  saveAuth(a);
  return a.access_token;
}

// HTTP-Header dürfen nur ASCII enthalten (Umlaute in Pfaden!).
function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export class DropboxError extends Error {
  constructor(status, body) {
    super(body?.error_summary || `Dropbox-Fehler ${status}`);
    this.status = status;
    this.body = body;
    this.summary = body?.error_summary || '';
  }
}

async function rpc(endpoint, args) {
  const opts = { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()) } };
  if (args !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(args);
  }
  const res = await fetch('https://api.dropboxapi.com/2/' + endpoint, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { error_summary: text }; }
  if (!res.ok) throw new DropboxError(res.status, body);
  return body;
}

// Liefert { text, rev } oder null, wenn die Datei nicht existiert.
export async function download(path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await token()), 'Dropbox-API-Arg': headerJson({ path }) },
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if ((body.error_summary || '').includes('not_found')) return null;
    throw new DropboxError(409, body);
  }
  if (!res.ok) throw new DropboxError(res.status, await res.json().catch(() => ({})));
  const meta = JSON.parse(res.headers.get('Dropbox-API-Result') || '{}');
  const text = await res.text();
  // Falls der Browser den Header nicht freigibt, Revision separat abfragen
  const rev = meta.rev || (await rpc('files/get_metadata', { path })).rev;
  return { text, rev };
}

// Lädt hoch. Mit rev nur, wenn die Datei seither unverändert ist (sonst DropboxError mit conflict).
export async function upload(path, text, rev) {
  const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + (await token()),
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': headerJson({ path, mode, autorename: false, mute: true, strict_conflict: true }),
    },
    body: new TextEncoder().encode(text),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new DropboxError(res.status, body);
  return body.rev;
}

export async function listFolders(path) {
  const r = await rpc('files/list_folder', { path: path === '/' ? '' : path, limit: 500 });
  let entries = r.entries;
  let cursor = r.cursor, more = r.has_more;
  while (more) {
    const n = await rpc('files/list_folder/continue', { cursor });
    entries = entries.concat(n.entries); cursor = n.cursor; more = n.has_more;
  }
  return entries
    .filter(e => e['.tag'] === 'folder')
    .map(e => ({ name: e.name, path: e.path_display }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function createFolder(path) {
  return rpc('files/create_folder_v2', { path, autorename: false });
}
