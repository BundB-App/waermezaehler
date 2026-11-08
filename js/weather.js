// Tagesmitteltemperaturen von Open-Meteo (kostenlos, ohne API-Key), lokal zwischengespeichert.
import * as store from './store.js';
import { dayKey, gradtag } from './stats.js';

const DAY = 86400000;
const cacheKey = (s) => `wz.wetter.${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
const normKey = (s, y) => `wz.klima.${s.lat.toFixed(3)},${s.lon.toFixed(3)}.${y}`;

function readCache(s) {
  try { return JSON.parse(localStorage.getItem(cacheKey(s))) || { temps: {}, recentFetch: 0 }; }
  catch { return { temps: {}, recentFetch: 0 }; }
}

async function fetchDaily(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Wetterdaten nicht verfügbar');
  const j = await res.json();
  const out = {};
  (j.daily?.time || []).forEach((t, i) => {
    const v = j.daily.temperature_2m_mean[i];
    if (v !== null && v !== undefined) out[t] = v;
  });
  return out;
}

// Liefert Map Tag → Tagesmittel (°C) für den Zeitraum ab `fromKey` bis heute.
export async function temperatures(fromKey) {
  const s = store.settings();
  const c = readCache(s);
  const today = dayKey(new Date());
  const archiveEnd = dayKey(new Date(Date.now() - 6 * DAY));
  const base = `latitude=${s.lat}&longitude=${s.lon}&daily=temperature_2m_mean&timezone=Europe%2FBerlin`;

  // Fehlende Archivtage nachladen (Archiv hat ein paar Tage Verzug)
  const missing = [];
  for (let d = new Date(fromKey + 'T00:00'); dayKey(d) <= archiveEnd; d.setDate(d.getDate() + 1)) {
    if (!(dayKey(d) in c.temps)) missing.push(dayKey(d));
  }
  try {
    if (missing.length) {
      Object.assign(c.temps, await fetchDaily(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${missing[0]}&end_date=${missing.at(-1)}`));
    }
    if (Date.now() - c.recentFetch > 3 * 3600 * 1000) {
      Object.assign(c.temps, await fetchDaily(`https://api.open-meteo.com/v1/forecast?${base}&past_days=10&forecast_days=1`));
      c.recentFetch = Date.now();
    }
    localStorage.setItem(cacheKey(s), JSON.stringify(c));
  } catch (e) {
    if (!Object.keys(c.temps).length) throw e;
  }
  const out = new Map();
  for (const [k, v] of Object.entries(c.temps)) if (k >= fromKey && k <= today) out.set(k, v);
  return new Map([...out].sort());
}

// Langjähriges Mittel der Gradtage pro Kalendermonat (letzte 10 vollständige Jahre).
export async function normalGradtage() {
  const s = store.settings();
  const y = new Date().getFullYear() - 1;
  const key = normKey(s, y);
  try { const c = JSON.parse(localStorage.getItem(key)); if (c) return c; } catch { /* neu laden */ }
  const temps = await fetchDaily(`https://archive-api.open-meteo.com/v1/archive?latitude=${s.lat}&longitude=${s.lon}&daily=temperature_2m_mean&timezone=Europe%2FBerlin&start_date=${y - 9}-01-01&end_date=${y}-12-31`);
  const sum = Array(12).fill(0);
  for (const [k, t] of Object.entries(temps)) sum[+k.slice(5, 7) - 1] += gradtag(t, s);
  const proMonat = sum.map(v => v / 10);
  const res = { proMonat, jahre: `${y - 9}–${y}` };
  localStorage.setItem(key, JSON.stringify(res));
  return res;
}

export async function geocode(query) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=de&countryCode=DE`);
  const j = await res.json();
  return (j.results || []).map(r => ({ name: `${r.name}${r.postcodes?.[0] ? ' (' + r.postcodes[0] + ')' : ''}${r.admin1 ? ', ' + r.admin1 : ''}`, lat: r.latitude, lon: r.longitude }));
}
