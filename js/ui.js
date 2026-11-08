// Kleine UI-Helfer, die von mehreren Ansichten genutzt werden.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = {};
export function fmt(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  nf[digits] ||= new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return nf[digits].format(n);
}
// Sinnvolle Nachkommastellen je nach Größenordnung
export function fmtAuto(n) {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  return fmt(n, a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

export function fmtDate(d, withTime = true) {
  if (!(d instanceof Date)) d = new Date(d);
  const s = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  return withTime ? `${s}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : s;
}
export function fmtAgo(d) {
  const diff = (Date.now() - d) / 1000;
  if (diff < 90) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.round(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.round(diff / 3600)} Std.`;
  const t = Math.round(diff / 86400);
  return t === 1 ? 'gestern' : `vor ${t} Tagen`;
}

// Deutsche Zahleneingabe: "12,5" und "12.5" → 12.5; "1.234,5" → 1234.5
export function parseNum(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "12.100" = Tausenderpunkt
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export const numStr = n => (Number.isFinite(n) ? String(n).replace('.', ',') : '');

export function nowLocal() {
  const d = new Date();
  d.setSeconds(0, 0);
  return toLocalInput(d);
}
export function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer;
export function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 5000 : 2200);
}

// Öffnet einen Dialog mit HTML-Inhalt; `setup(root, close)` verdrahtet die Elemente.
export function dialog(html, setup) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="dlg-body">${html}</div>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('click', e => { if (e.target === d) close(); });
  d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  d.showModal();
  setup?.(d, close);
  return close;
}

export function confirmDialog(text, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    dialog(`<p>${esc(text)}</p><div class="actions"><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button><button class="btn" data-cancel>Abbrechen</button></div>`,
      (root, close) => {
        root.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
        root.querySelector('[data-cancel]').onclick = () => { close(); resolve(false); };
      });
  });
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function kreisFarbe(idx) {
  return cssVar(`--c${((idx - 1) % 5) + 1}`);
}

export async function saveFile(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad/.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
