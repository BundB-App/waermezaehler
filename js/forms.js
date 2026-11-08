// Formulare: Ablesung, Betankung, Zählerwechsel (für Neu-Anlage und Bearbeiten)
import * as store from './store.js';
import { parseZeit } from './stats.js';
import { esc, fmt, fmtAuto, fmtAgo, parseNum, numStr, nowLocal, toast, confirmDialog } from './ui.js';

const HEIZ = ['vorlaufTag', 'vorlaufNacht', 'kennlinie', 'pumpe'];

// Letzter Wert eines Feldes vor einem Zeitpunkt (bearbeiteter Eintrag ausgenommen)
function lastBefore(zeit, getter, excludeId) {
  const list = store.eintraege('ablesung').filter(e => e.id !== excludeId && (!zeit || e.zeit <= zeit));
  for (let i = list.length - 1; i >= 0; i--) {
    const v = getter(list[i]);
    if (Number.isFinite(v)) return { v, e: list[i] };
  }
  return null;
}

export function formHtml(typ, e = null) {
  const zeit = e?.zeit || nowLocal();
  const head = `
    <label class="field"><span>Datum &amp; Uhrzeit</span>
      <input type="datetime-local" name="zeit" value="${esc(zeit)}" required></label>`;
  const notiz = `<label class="field" style="margin-top:12px"><span>Notiz</span><textarea name="notiz" placeholder="optional">${esc(e?.notiz || '')}</textarea></label>`;

  if (typ === 'betankung') {
    return `<form class="stack" data-typ="betankung">
      ${head}
      <div class="fields">
        <label class="field"><span>Getankt (Liter)</span><input name="liter" inputmode="decimal" value="${numStr(e?.liter)}" required></label>
        <label class="field"><span>Preis gesamt (€)</span><input name="preis" inputmode="decimal" value="${numStr(e?.preis)}" placeholder="optional"></label>
      </div>
      <p class="muted small">Tipp: Lies den Ölstand direkt nach dem Tanken mit ab – dann stimmt die Verbrauchsrechnung am genauesten.</p>
      ${notiz}
      ${buttons(e)}
    </form>`;
  }

  if (typ === 'zaehlerwechsel') {
    const opts = store.kreise({ alle: true }).map(k => `<option value="${k.id}" ${e?.kreisId === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
    return `<form class="stack" data-typ="zaehlerwechsel">
      ${head}
      <label class="field"><span>Kreis</span><select name="kreisId">${opts}</select></label>
      <div class="fields">
        <label class="field"><span>Endstand alter Zähler (kWh)</span><input name="endstand" inputmode="decimal" value="${numStr(e?.endstand)}" placeholder="falls bekannt"></label>
        <label class="field"><span>Startstand neuer Zähler (kWh)</span><input name="startstand" inputmode="decimal" value="${numStr(e?.startstand ?? 0)}" required></label>
      </div>
      <p class="muted small">Auch für einen Reset oder Überlauf des Zählers. Ab diesem Zeitpunkt rechnet die Statistik mit dem neuen Zähler weiter.</p>
      ${notiz}
      ${buttons(e)}
    </form>`;
  }

  // Ablesung
  const kreise = store.kreise();
  const kreisFields = kreise.map(k => {
    const prev = lastBefore(e?.zeit, x => x.werte?.[k.id], e?.id);
    const val = e?.werte?.[k.id];
    return `<label class="field" data-kreis="${k.id}"><span>${esc(k.name)} (kWh)</span>
      <input name="k:${k.id}" inputmode="decimal" value="${numStr(val)}" placeholder="${prev ? fmt(prev.v, prev.v % 1 ? 1 : 0) : ''}" autocomplete="off">
      <span class="hint" data-hint>${prev ? `zuletzt ${fmtAuto(prev.v)} · ${fmtAgo(parseZeit(prev.e.zeit))}` : 'erste Ablesung'}</span></label>`;
  }).join('');
  const prevOil = lastBefore(e?.zeit, x => x.oel, e?.id);
  const pre = k => (e ? e[k] : lastBefore(null, x => x[k])?.v);
  const s = store.settings();
  const kl = pre('kennlinie');
  const klOpts = ['<option value="">–</option>'];
  for (let i = s.kennlinieMin; i <= s.kennlinieMax; i++) klOpts.push(`<option ${kl === i ? 'selected' : ''}>${i}</option>`);
  const pumpe = pre('pumpe');

  return `<form class="stack" data-typ="ablesung">
    ${head}
    <div class="section-title">Wärmemengenzähler</div>
    <div class="fields">${kreisFields || '<p class="muted">Keine Kreise angelegt – siehe Einstellungen.</p>'}</div>
    <div class="section-title">Öl</div>
    <div class="fields">
      <label class="field" data-oel><span>Ölstand (Liter)</span>
        <input name="oel" inputmode="decimal" value="${numStr(e?.oel)}" placeholder="${prevOil ? fmt(prevOil.v) : ''}" autocomplete="off">
        <span class="hint" data-hint>${prevOil ? `zuletzt ${fmt(prevOil.v)} L · ${fmtAgo(parseZeit(prevOil.e.zeit))}` : ''}</span></label>
    </div>
    <div class="section-title">Heizung</div>
    <div class="fields">
      <label class="field" data-heiz="vorlaufTag"><span>Vorlauf Tag (°C)</span><input name="vorlaufTag" inputmode="decimal" value="${numStr(pre('vorlaufTag'))}"></label>
      <label class="field" data-heiz="vorlaufNacht"><span>Vorlauf Nacht (°C)</span><input name="vorlaufNacht" inputmode="decimal" value="${numStr(pre('vorlaufNacht'))}"></label>
      <label class="field" data-heiz="kennlinie"><span>Kennlinie</span><select name="kennlinie">${klOpts.join('')}</select></label>
      <div class="field" data-heiz="pumpe"><span>Pumpenstufe</span>
        <div class="seg full" data-pumpe>${[1, 2, 3].map(p => `<button type="button" data-v="${p}" class="${pumpe === p ? 'active' : ''}">${p}</button>`).join('')}</div>
        <input type="hidden" name="pumpe" value="${pumpe ?? ''}"></div>
    </div>
    <p class="muted small" style="margin-top:6px">Die Heizungswerte sind mit der letzten Ablesung vorbelegt. Geänderte Werte werden markiert.</p>
    ${notiz}
    ${buttons(e)}
  </form>`;
}

function buttons(e) {
  return `<div class="actions">
    <button type="submit" class="btn primary block">${e ? 'Änderungen speichern' : 'Speichern'}</button>
    ${e ? '<button type="button" class="btn danger block" data-delete>Eintrag löschen</button>' : ''}
  </div>`;
}

export function bindForm(root, e, onDone) {
  const form = root.querySelector('form');
  const typ = form.dataset.typ;

  if (typ === 'ablesung') {
    const seg = form.querySelector('[data-pumpe]');
    seg.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const hidden = form.elements.pumpe;
      const same = hidden.value === b.dataset.v;
      hidden.value = same ? '' : b.dataset.v;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', !same && x === b));
      markChanged();
    });
    // Markierung geänderter Heizungswerte + Plausibilitätsprüfung der Zählerstände
    const markChanged = () => {
      const zeit = form.elements.zeit.value;
      for (const k of HEIZ) {
        const prev = lastBefore(zeit, x => x[k], e?.id);
        const cur = parseNum(form.elements[k].value);
        form.querySelector(`[data-heiz="${k}"]`).classList.toggle('changed', !!prev && cur !== null && cur !== prev.v);
      }
    };
    const checkValues = () => {
      const zeit = form.elements.zeit.value;
      form.querySelectorAll('[data-kreis]').forEach(f => {
        const id = f.dataset.kreis;
        const prev = lastBefore(zeit, x => x.werte?.[id], e?.id);
        const cur = parseNum(form.elements['k:' + id].value);
        const hint = f.querySelector('[data-hint]');
        if (prev && cur !== null) {
          const d = cur - prev.v;
          hint.className = d < 0 ? 'warn-text' : 'hint';
          hint.textContent = d < 0 ? `kleiner als zuletzt (${fmtAuto(prev.v)}) – Zählerwechsel?` : `+${fmtAuto(d)} kWh · letzte Ablesung ${fmtAgo(parseZeit(prev.e.zeit))}`;
        }
      });
      const of = form.querySelector('[data-oel]');
      const prevO = lastBefore(zeit, x => x.oel, e?.id);
      const curO = parseNum(form.elements.oel.value);
      if (prevO && curO !== null) {
        const h = of.querySelector('[data-hint]');
        const d = prevO.v - curO;
        h.className = 'hint';
        h.textContent = d >= 0 ? `−${fmt(d)} L · letzte Ablesung ${fmtAgo(parseZeit(prevO.e.zeit))}` : `+${fmt(-d)} L – bitte Betankung erfassen`;
      }
    };
    form.addEventListener('input', () => { markChanged(); checkValues(); });
    markChanged(); checkValues();
  }

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const f = form.elements;
    const zeit = f.zeit.value;
    if (!zeit) return toast('Bitte Datum und Uhrzeit angeben.', true);
    const rec = { ...(e || {}), typ, zeit, notiz: f.notiz.value.trim() || undefined };
    if (typ === 'ablesung') {
      rec.werte = {};
      store.kreise().forEach(k => { const v = parseNum(f['k:' + k.id].value); if (v !== null) rec.werte[k.id] = v; });
      // Werte archivierter Kreise beim Bearbeiten erhalten
      if (e?.werte) for (const [id, v] of Object.entries(e.werte)) if (!(id in rec.werte) && store.kreis(id)?.archiviert) rec.werte[id] = v;
      rec.oel = parseNum(f.oel.value) ?? undefined;
      for (const k of HEIZ) rec[k] = parseNum(f[k].value) ?? undefined;
      if (!Object.keys(rec.werte).length && rec.oel === undefined && HEIZ.every(k => rec[k] === undefined))
        return toast('Bitte mindestens einen Wert eintragen.', true);
    } else if (typ === 'betankung') {
      rec.liter = parseNum(f.liter.value);
      rec.preis = parseNum(f.preis.value) ?? undefined;
      if (!rec.liter) return toast('Bitte die getankten Liter angeben.', true);
    } else {
      rec.kreisId = f.kreisId.value;
      rec.endstand = parseNum(f.endstand.value) ?? undefined;
      rec.startstand = parseNum(f.startstand.value) ?? 0;
    }
    store.saveEintrag(rec);
    toast(e ? 'Änderungen gespeichert' : 'Gespeichert');
    onDone?.();
  });

  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (await confirmDialog('Diesen Eintrag wirklich löschen?', 'Löschen', true)) {
      store.deleteEintrag(e.id);
      toast('Gelöscht');
      onDone?.();
    }
  });
}
