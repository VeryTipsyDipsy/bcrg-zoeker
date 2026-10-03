// BCRG Zoeker — zoeklogica en weergave. Wordt door index.html geladen zodra window.BCRG klaarstaat.
const track = window.track || (() => {});
const $ = s => document.querySelector(s);
const PAGE = 40;          // kaarten per 'meer tonen'
const HITS_SHOWN = 4;     // treffer-regels per kaart voor 'meer'
const TODAY = new Date().toISOString().slice(0, 10);


// ---------- Normaliseren: alleen letters/cijfers, geen accenten ----------
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = d => d ? d.split('-').reverse().join('-') : '';

const TYPE_SHORT = { 'Kwaliteitsverklaring': 'KV', 'Gelijkwaardigheidsverklaring': 'GV', 'EMG-verklaring': 'EMG' };

function status(r) {
  if (r.rev) return { key: 'bad', label: `Ingetrokken ${fmtDate(r.rev)}`, valid: false };
  if (!r.avail) return { key: 'bad', label: r.disc ? `Vervallen per ${fmtDate(r.disc)}` : 'Vervallen', valid: false };
  if (r.exp && r.exp <= TODAY) return { key: 'warn', label: `Verlopen ${fmtDate(r.exp)}`, valid: false };
  if (r.disc && r.disc > TODAY) return { key: 'warn', label: `Geldig · vervalt ${fmtDate(r.disc)}`, valid: true };
  if (r.exp) return { key: 'ok', label: `Geldig t/m ${fmtDate(r.exp)}`, valid: true };
  return { key: 'ok', label: 'Geldig', valid: true };
}

// Getallen als geheel herkennen: '440' wel in '440 Wp' of 'BLK-G9 440', niet in '1440' of '14400'.
// Duizendtal-/decimaaltekens tussen cijfers eerst weg, zodat '1.389' als 1389 telt.
const digitsJoined = s => s.toLowerCase().replace(/(\d)[.,](?=\d)/g, '$1');
const isNum = t => /^\d+$/.test(t);
const numIn = (rawD, t) => new RegExp(`(?<!\\d)${t}(?!\\d)`).test(rawD);

// ---------- Index opbouwen ----------
const R = BCRG.records;
const byNr = new Map();
for (const r of R) {
  r.st = status(r);
  r.mainCats = [...new Set(r.cats.map(c => c.split(' › ')[0]))];
  r.metaN = norm([r.nr, r.nr2, r.title, r.desc, r.mfr, r.ean].join(' '));
  r.metaD = digitsJoined([r.nr, r.nr2, r.title, r.desc, r.mfr, r.ean].join(' '));
  r.catN = norm(r.cats.join(' '));
  const aliasByLine = new Map(r.alias.map(([n, a]) => [n, a]));
  r.linesN = r.lines.map((l, i) => norm(l + (aliasByLine.has(i) ? ' ' + aliasByLine.get(i) : '')));
  r.textN = r.linesN.join('~');   // '~' komt nooit voor na norm(): geen treffers over regelgrenzen
  byNr.set(norm(r.nr), r);
  byNr.set(norm(r.nr.split(/[ (]/)[0]), r);
  if (r.nr2) byNr.set(norm(r.nr2), r);
}

const findNr = n => byNr.get(norm(n)) || byNr.get(norm(n.split(/[ (]/)[0]));
const baseNr = nr => nr.split(/[ (]/)[0];

// Opvolgers volgen tot de laatste in de keten (vervallen → vervallen → geldig)
function successors(r) {
  return r.next.map(n => {
    let cur = findNr(n);
    if (!cur) return { label: n, via: [] };
    const via = [], seen = new Set([r]);
    while (!cur.st.valid && cur.next.length && via.length < 6) {
      const nx = findNr(cur.next[0]);
      if (!nx || seen.has(nx) || nx === cur) break;
      seen.add(cur); via.push(cur); cur = nx;
    }
    return { r: cur, via };
  });
}

// ---------- Interpoleren warmtepomp (NTA 8800 bijlage Q) ----------
// Lineair tussen twee kolommen warmtebehoefte, binnen één θsup-blok. Nooit extrapoleren.
function interpolate(variant, hi, q) {
  const block = variant.blocks.find(b => b.hi === hi);
  const cols = variant.cols;
  if (!block) return { error: 'Kies een aanvoertemperatuur.' };
  if (!(q > 0)) return { error: 'Vul de warmtebehoefte in.' };
  if (q < cols[0] || q > cols[cols.length - 1]) {
    return { error: `${fmtNum(q, 0)} kWh valt buiten de tabel (${fmtNum(cols[0], 0)} – ${fmtNum(cols[cols.length - 1], 0)} kWh/jaar). Niet geëxtrapoleerd — zie de PDF.` };
  }
  let k = cols.findIndex((c, i) => q >= c && q <= cols[i + 1]);
  if (k === -1) k = cols.length - 2;   // q is precies de laatste kolom
  const t = (q - cols[k]) / (cols[k + 1] - cols[k]);
  const val = arr => {
    if (!arr) return null;
    const a = arr[k], b = arr[k + 1];
    if (t === 0 && a != null) return a;
    if (t === 1 && b != null) return b;
    if (a == null || b == null) return NaN;
    return a + t * (b - a);
  };
  const out = { k, t, c0: cols[k], c1: cols[k + 1], block, e: val(block.e), f: val(block.f), w: val(block.w), forf: !block.f };
  if ([out.e, out.f, out.w].some(Number.isNaN)) return { error: 'De tabel heeft hier een "–" (niet van toepassing). Zie de PDF.' };
  return out;
}

const fmtNum = (v, d) => v.toLocaleString('nl', { minimumFractionDigits: d, maximumFractionDigits: d });

// '12.345', '12345', '12345,6' en '12 345' → getal
function parseNL(s) {
  s = String(s).trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, ''));
  return parseFloat(s);
}

const tempLabel = b => b.lo ? `${b.lo} °C < θsup ≤ ${b.hi} °C` : `θsup ≤ ${b.hi} °C`;
const CLASS_INFO = {
  WLE: 'Woning, laag energiegebruik (QH;nd/Ag;tot ≤ 41,67 kWh/m²)',
  WHE: 'Woning, hoog energiegebruik (QH;nd/Ag;tot > 41,67 kWh/m²)',
  ULE: 'Utiliteit, laag energiegebruik (QH;nd/Ag;tot ≤ 69,44 kWh/m²)',
  UHE: 'Utiliteit, hoog energiegebruik (QH;nd/Ag;tot > 69,44 kWh/m²)',
};
const calcState = new Map();          // per verklaring: open/klasse/variant/θsup/q, blijft staan bij opnieuw tekenen
let lastCalc = { cls: 'WLE', hi: null };

// ---------- Laatst gezocht (alleen in deze browser) ----------
const RECENT_KEY = 'bcrg-recent';
const recent = {
  get() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } },
  save(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {} },
};
function remember(q) {
  q = q.trim();
  if (norm(q).length < 3) return;
  const lq = q.toLowerCase();
  // 'Kings' wordt vervangen door 'Kingspan' als je doortypt
  const list = recent.get().filter(x => x.toLowerCase() !== lq && !lq.startsWith(x.toLowerCase()));
  recent.save([q, ...list].slice(0, 8));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta); ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

$('#meta').innerHTML = `${R.length.toLocaleString('nl')} verklaringen · data van ${fmtDate(BCRG.fetched_at.slice(0, 10))} · <a href="https://mijn.bcrg.nl/" target="_blank" rel="noopener">BCRG databank</a>`;

// ---------- Filters ----------
const state = { q: '', cat: null, type: null, onlyValid: true, calc: false, loose: false, shown: PAGE };
const CATS = [...new Set(R.flatMap(r => r.mainCats))].sort((a, b) =>
  R.filter(r => r.mainCats.includes(b)).length - R.filter(r => r.mainCats.includes(a)).length);
const TYPES = Object.keys(TYPE_SHORT);

function chip(label, count, on, onclick) {
  const b = document.createElement('button');
  b.className = 'chip' + (on ? ' on' : '');
  b.innerHTML = `${esc(label)}${count != null ? `<b>${count.toLocaleString('nl')}</b>` : ''}`;
  b.hidden = count === 0 && !on && state.q.trim() !== '';
  b.disabled = count === 0 && !on;
  b.onclick = onclick;
  return b;
}

function renderFilters(matches) {
  // Tellingen per filter binnen de huidige zoekopdracht (andere filters wel toegepast)
  const count = (pred, skip) => matches.filter(m => pass(m.r, skip) && pred(m.r)).length;

  const fc = $('#f-cat'); fc.replaceChildren(fc.firstElementChild);
  fc.append(chip('Alle', null, !state.cat, () => set({ cat: null })));
  for (const c of CATS) fc.append(chip(c, count(r => r.mainCats.includes(c), 'cat'), state.cat === c,
    () => set({ cat: state.cat === c ? null : c })));

  const ft = $('#f-type'); ft.replaceChildren(ft.firstElementChild);
  for (const t of TYPES) ft.append(chip(TYPE_SHORT[t], count(r => r.type === t, 'type'), state.type === t,
    () => set({ type: state.type === t ? null : t })));

  const fs = $('#f-status'); fs.replaceChildren(fs.firstElementChild);
  fs.append(chip('Alleen geldig', count(r => r.st.valid, 'valid'), state.onlyValid,
    () => set({ onlyValid: !state.onlyValid })));
  fs.append(chip('Met rekentabel', count(r => !!r.wp, 'calc'), state.calc,
    () => set({ calc: !state.calc })));

  // Groep zonder zichtbare knoppen helemaal verbergen
  for (const g of [fc, ft, fs]) g.hidden = ![...g.querySelectorAll('.chip')].some(c => !c.hidden);
}

function pass(r, skip) {
  if (skip !== 'cat' && state.cat && !r.mainCats.includes(state.cat)) return false;
  if (skip !== 'type' && state.type && r.type !== state.type) return false;
  if (skip !== 'valid' && state.onlyValid && !r.st.valid) return false;
  if (skip !== 'calc' && state.calc && !r.wp) return false;
  return true;
}

// ---------- Zoeken ----------
function search(q) {
  const terms = q.split(/\s+/).map(norm).filter(Boolean);
  if (!terms.length || terms.join('').length < 2) return { terms, matches: [] };
  const phrase = terms.join('');
  const exactNr = byNr.get(phrase);
  const matches = [];
  for (const r of R) {
    let score = 0;
    for (const t of terms) {
      if (r.metaN.includes(t)) score += 10;
      else if (r.textN.includes(t)) score += 3;
      else if (r.catN.includes(t)) score += 1;
      else { score = -1; break; }
    }
    if (score < 0) continue;
    if (terms.length > 1 || phrase.length >= 3) {
      if (r.metaN.includes(phrase)) score += 100;
      else if (r.textN.includes(phrase)) score += 40;
    }
    if (r === exactNr) score += 1000;
    if (r.st.valid) score += 5;
    matches.push({ r, score, strict: r === exactNr || together(r, terms) });
  }
  matches.sort((a, b) => b.score - a.score || (b.r.from || '').localeCompare(a.r.from || ''));
  return { terms, matches };
}

// Horen de zoekwoorden bij elkaar? Woorden die niet in titel/fabrikant/categorie staan, moeten samen in
// één regel (tabelrij) van de PDF staan. Zo telt 'Q.PEAK DUO BLK G9 440' niet als treffer als 'Q.PEAK DUO
// BLK G9' in de ene rij staat en '440' in een andere (bij een ander paneel).
function together(r, terms) {
  const inMeta = t => isNum(t) ? numIn(r.metaD, t) : (r.metaN.includes(t) || r.catN.includes(t));
  const rest = terms.filter(t => !inMeta(t));
  if (!rest.length) return true;
  return r.linesN.some((ln, i) => rest.every(t => ln.includes(t)) &&
    rest.every(t => !isNum(t) || numIn(digitsJoined(r.lines[i]), t)));
}

// Regels uit de PDF die de zoekopdracht bevatten: eerst de hele zin, anders de meeste losse termen.
function hitLines(r, terms) {
  const phrase = terms.join('');
  const useful = terms.filter(t => t.length >= 2 || terms.length === 1);
  const out = [];
  r.linesN.forEach((ln, i) => {
    let s = ln.includes(phrase) ? 100 : 0;
    for (const t of useful) if (ln.includes(t)) s += t.length;
    if (s) out.push({ i, s });
  });
  out.sort((a, b) => b.s - a.s || a.i - b.i);
  const best = out.length ? out[0].s : 0;
  // Bij losse termen alleen de beste regels tonen, niet elke regel met '3' erin
  return out.filter(h => h.s >= Math.min(best, 100) || h.s >= best * 0.6).sort((a, b) => a.i - b.i);
}

function pageOf(r, i) {
  let p = 1;
  for (let k = 0; k < r.pages.length; k++) if (r.pages[k] <= i) p = k + 1;
  return p;
}

// Markeer termen in de originele tekst, ongeacht spaties/streepjes ertussen
function highlight(text, terms) {
  const pats = [...terms].sort((a, b) => b.length - a.length).filter(t => t.length >= 2 || terms.length === 1)
    .map(t => [...t].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]*'));
  if (!pats.length) return esc(text);
  const re = new RegExp(pats.join('|'), 'gi');
  const flat = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const same = flat.length === text.length;   // alleen markeren als posities kloppen
  let html = '', last = 0, m;
  if (!same) return esc(text);
  while ((m = re.exec(flat))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    html += esc(text.slice(last, m.index)) + '<mark>' + esc(text.slice(m.index, m.index + m[0].length)) + '</mark>';
    last = m.index + m[0].length;
  }
  return html + esc(text.slice(last));
}

// ---------- Rekenpaneel ----------
function calcPanel(r) {
  const st = calcState.get(r.id) || {};
  const classes = ['WLE', 'WHE', 'ULE', 'UHE'].filter(c => r.wp[c]);
  st.cls = classes.includes(st.cls) ? st.cls : (classes.includes(lastCalc.cls) ? lastCalc.cls : classes[0]);
  const variants = r.wp[st.cls];
  st.v = Math.min(st.v || 0, variants.length - 1);
  const variant = variants[st.v];
  const his = variant.blocks.map(b => b.hi);
  st.hi = his.includes(st.hi) ? st.hi : (his.includes(lastCalc.hi) ? lastCalc.hi : null);
  st.q = st.q || '';
  calcState.set(r.id, st);

  const el = document.createElement('div');
  el.className = 'calc';
  el.innerHTML = `
    <div class="calc-h">Interpoleren <span>NTA 8800 bijlage Q · lineair tussen de tabelwaarden voor de warmtebehoefte</span></div>
    <div class="calc-grid">
      <div class="fld"><span class="lbl">Klasse</span>
        <div class="seg">${classes.map(c => `<button type="button" data-cls="${c}" class="${c === st.cls ? 'on' : ''}" title="${esc(CLASS_INFO[c])}">${c}</button>`).join('')}</div>
        <span class="help">${esc(CLASS_INFO[st.cls])}</span></div>
      <label class="fld"><span class="lbl">Aanvoertemperatuur</span>
        <select data-hi><option value="">Kies θsup…</option>${variant.blocks.map(b => `<option value="${b.hi}" ${b.hi === st.hi ? 'selected' : ''}>${tempLabel(b)}</option>`).join('')}</select></label>
      <label class="fld"><span class="lbl">Warmtebehoefte QH;dis;nren [kWh/jaar]</span>
        <input data-q inputmode="decimal" autocomplete="off" placeholder="bv. 12.500" value="${esc(st.q)}"></label>
    </div>
    ${variants.length > 1 ? `<div class="variants"><span class="lbl">Variant — deze verklaring heeft ${variants.length} tabellen voor ${st.cls}</span>
      ${variants.map((v, i) => `<label class="var"><input type="radio" name="v-${r.id}" value="${i}" ${i === st.v ? 'checked' : ''}>
        <span><b>${esc(v.label || 'Tabel')}</b> · blz ${v.page} — ${esc(v.ctx)}</span></label>`).join('')}</div>` : ''}
    <div class="calc-out"></div>`;

  const out = el.querySelector('.calc-out');
  const show = () => {
    const q = parseNL(st.q);
    if (st.hi == null || !st.q) {
      out.innerHTML = `<div class="calc-hint">Kies klasse en aanvoertemperatuur en vul de warmtebehoefte in.</div>`;
      return;
    }
    const res = interpolate(variant, st.hi, q);
    clearTimeout(st.trackTimer);
    if (res.error) { out.innerHTML = `<div class="calc-err">${esc(res.error)}</div>`; return; }
    st.trackTimer = setTimeout(() => track('calc', { q: baseNr(r.nr), n: Math.round(q), meta: { cls: st.cls, hi: st.hi } }), 2000);
    const b = res.block, k = res.k;
    const val = (name, sym, v, d, unit) => `<div class="res"><span class="sym">${sym}</span><span class="nm">${name}</span>
      <span class="v">${v == null ? 'forfaitair' : fmtNum(v, d)}${unit && v != null ? ` <small>${unit}</small>` : ''}</span>
      ${v == null ? '' : `<button type="button" class="copy" data-copy="${fmtNum(v, d)}">Kopieer</button>`}</div>`;
    const cell = (arr, i, d) => arr ? (arr[i] == null ? '–' : fmtNum(arr[i], d)) : 'forf.';
    out.innerHTML =
      val('opwekkingsrendement (COP)', 'ηH;gen;hp;si', res.e, 3) +
      val('energiefractie', 'FH;gen;si,gpref', res.forf ? null : res.f, 3) +
      val('hulpenergie', 'WH;aux', res.w, 1, 'kWh/jaar') +
      `<div class="calc-src">${res.t === 0 || res.t === 1
        ? `Precies de tabelkolom ${fmtNum(res.t === 0 ? res.c0 : res.c1, 0)} kWh/jaar — geen interpolatie nodig.`
        : `Tussen ${fmtNum(res.c0, 0)} en ${fmtNum(res.c1, 0)} kWh/jaar (${fmtNum(res.t * 100, 1)}% ertussen).`}
        <table><tr><th>kWh/jaar</th><th>${fmtNum(res.c0, 0)}</th><th>${fmtNum(res.c1, 0)}</th></tr>
          <tr><td>η</td><td>${cell(b.e, k, 3)}</td><td>${cell(b.e, k + 1, 3)}</td></tr>
          <tr><td>F</td><td>${cell(b.f, k, 3)}</td><td>${cell(b.f, k + 1, 3)}</td></tr>
          <tr><td>WH;aux</td><td>${cell(b.w, k, 0)}</td><td>${cell(b.w, k + 1, 0)}</td></tr></table>
        Bron: ${esc(variant.label || 'tabel')} ${st.cls}, ${tempLabel(b)} — <a href="${esc(r.pdf)}#page=${variant.page}" target="_blank" rel="noopener">controleer in de PDF, blz ${variant.page} ↗</a></div>`;
    out.querySelectorAll('.copy').forEach(c => c.onclick = async () => {
      const ok = await copyText(c.dataset.copy);
      c.textContent = ok ? 'Gekopieerd ✓' : 'Mislukt';
      setTimeout(() => { c.textContent = 'Kopieer'; }, 1500);
    });
  };

  el.querySelectorAll('[data-cls]').forEach(b => b.onclick = () => {
    st.cls = lastCalc.cls = b.dataset.cls; st.v = 0;
    el.replaceWith(calcPanel(r));
  });
  el.querySelector('[data-hi]').onchange = e => { st.hi = lastCalc.hi = e.target.value ? +e.target.value : null; show(); };
  el.querySelector('[data-q]').oninput = e => { st.q = e.target.value; show(); };
  el.querySelectorAll(`input[name="v-${r.id}"]`).forEach(i => i.onchange = () => { st.v = +i.value; el.replaceWith(calcPanel(r)); });
  show();
  return el;
}

// ---------- Combinaties: uit welke toestellen bestaat de verklaring? ----------
// r.combo = [[toestel, ...], ...] (alternatieven uit de titel, zie scripts/combos.py)
// Zoektermen die iets zeggen over het toestel: ≥3 tekens, of korter mét cijfer ('17' in 'WPL 17 ACS')
const comboTerms = terms => {
  const ts = terms.filter(t => t.length >= 3 || (t.length >= 2 && /\d/.test(t)));
  return ts.length ? ts : terms;
};

function comboInfo(r, terms) {
  if (!r.combo) return null;
  const ts = comboTerms(terms);
  let best = null;
  for (const alt of r.combo) {
    const compsN = alt.map(norm);
    const allN = compsN.join('~');
    const matched = compsN.map(c => ts.some(t => c.includes(t)));
    const missing = ts.filter(t => !allN.includes(t));
    const inTitle = matched.some(Boolean) && !missing.length;
    // Een typenummer dat alleen in de PDF staat (WH-UD09JE5) hoort bij het hoofdtoestel (het eerste).
    // Een losse term als '17' die niet in de titel staat kan juist bij een ánder toestel horen (WPL 09):
    // dan is de combinatie onzeker en komt hij onderaan.
    const typeLike = t => t.length >= 5 && /\d/.test(t) && /[a-z]/.test(t);
    const unsure = missing.some(t => !typeLike(t));
    if (!inTitle) matched[0] = true;
    const others = matched.filter(x => !x).length;
    const rank = (inTitle ? 0 : unsure ? 2 : 1);
    if (!best || rank < best.rank || (rank === best.rank && others < best.others)) {
      best = { alt, matched, others, inTitle, unsure: !inTitle && unsure, rank };
    }
  }
  return best;
}

const groupOf = ci => (!ci || ci.unsure ? 'rest' : ci.others);
const groupLabel = (others, multi) => others === 0
  ? (multi ? 'Precies deze combinatie' : 'Alleen dit toestel')
  : `Met ${others} ${others === 1 ? 'ander toestel' : 'andere toestellen'}`;

// ---------- Weergave ----------
function card(r, terms, ci) {
  const t = TYPE_SHORT[r.type] || r.type;
  const hits = terms.length ? hitLines(r, terms) : [];
  const el = document.createElement('article');
  el.className = 'card' + (r.st.valid ? '' : ' dim');

  const lineage = [];
  if (r.pred) lineage.push(`Voorganger: <a data-nr="${esc(r.pred)}">${esc(r.pred)}</a>`);
  if (r.next.length && r.st.valid) lineage.push(`Opvolger: ${r.next.map(n => `<a data-nr="${esc(n)}">${esc(n)}</a>`).join(', ')}`);

  // Vervallen/verlopen met opvolger: opvallend tonen waar je naartoe moet
  let succ = '';
  if (!r.st.valid && r.next.length) {
    succ = `<div class="succ">` + successors(r).map(s => s.r
      ? `<div>↪ Vervangen door <a data-nr="${esc(s.r.nr)}">${esc(baseNr(s.r.nr))}</a>
           <span class="badge b-${s.r.st.key}">${esc(s.r.st.label)}</span>
           <span class="succ-t">${esc(s.r.title)}</span>
           ${s.via.length ? `<span class="succ-via">via ${s.via.map(v => esc(baseNr(v.nr))).join(' → ')}</span>` : ''}</div>`
      : `<div>↪ Vervangen door ${esc(s.label)}</div>`).join('') + `</div>`;
  }

  el.innerHTML = `
    <div class="row1">
      <span class="nr">${highlight(r.nr, terms)}</span>
      <button class="copy" type="button" data-copy="${esc(baseNr(r.nr))}" title="BCRG-nummer kopiëren">Kopieer</button>
      <span class="badge b-${t.toLowerCase()}">${esc(r.type)}</span>
      <span class="badge b-${r.st.key}">${esc(r.st.label)}</span>
      <span class="spacer"></span>
      ${r.wp ? `<button type="button" class="btn btn-calc">Interpoleren</button>` : ''}
      <a class="btn" href="${esc(r.pdf)}" target="_blank" rel="noopener">Open PDF ↗</a>
    </div>
    <div class="title">${highlight(r.title, terms)}</div>
    <div class="sub"><span class="mfr">${highlight(r.mfr, terms)}</span> · ${esc(r.cats.join(', '))}${r.from ? ` · sinds ${fmtDate(r.from)}` : ''}</div>
    ${r.desc ? `<div class="desc">${highlight(r.desc, terms)}</div>` : ''}
    ${ci && ci.alt.length > 1 ? `<div class="combo"><span class="lbl">Combinatie</span>${ci.alt.map((c, i) => ci.matched[i]
      ? `<span class="cmp me">${highlight(c, terms)}</span>`
      : `<button type="button" class="cmp add" data-add="${esc(c)}" title="Zoek op deze combinatie">+ ${esc(c)}</button>`).join('')}
      ${ci.inTitle ? '' : '<span class="combo-note">gezocht type staat in de PDF, niet in de titel</span>'}</div>` : ''}
    ${succ}
    ${lineage.length ? `<div class="lineage">${lineage.join(' · ')}</div>` : ''}
    ${!r.wp && r.wpWhy ? `<div class="nocalc">Interpoleren niet beschikbaar: ${esc(r.wpWhy)} — gebruik de PDF.</div>` : ''}
  `;

  if (r.wp) {
    const btn = el.querySelector('.btn-calc');
    const slot = document.createElement('div');
    el.append(slot);
    const toggle = open => {
      const st = calcState.get(r.id) || {};
      st.open = open; calcState.set(r.id, st);
      btn.classList.toggle('on', open);
      btn.textContent = open ? 'Sluit rekenhulp' : 'Interpoleren';
      slot.replaceChildren(...(open ? [calcPanel(r)] : []));
    };
    btn.onclick = () => toggle(!(calcState.get(r.id) || {}).open);
    if ((calcState.get(r.id) || {}).open) toggle(true);
  }

  if (hits.length) {
    const box = document.createElement('div');
    box.className = 'hits';
    const row = h => {
      const p = pageOf(r, h.i);
      return `<div class="hit"><a class="pg" href="${esc(r.pdf)}#page=${p}" target="_blank" rel="noopener">blz ${p}</a><span class="tx">${highlight(r.lines[h.i], terms)}</span></div>`;
    };
    box.innerHTML = `<div class="hits-h">Gevonden in de PDF · ${hits.length} ${hits.length === 1 ? 'regel' : 'regels'}${r.ocr ? ' · gescande PDF, tekst via OCR' : ''}</div>` +
      hits.slice(0, HITS_SHOWN).map(row).join('');
    if (hits.length > HITS_SHOWN) {
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = `Toon alle ${hits.length} regels`;
      more.onclick = () => { more.insertAdjacentHTML('beforebegin', hits.slice(HITS_SHOWN).map(row).join('')); more.remove(); };
      box.append(more);
    }
    el.append(box);
  }
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    set({ q: `${state.q.trim()} ${b.dataset.add}` }, true);
    track('combo', { q: state.q });
  });
  el.querySelectorAll('[data-nr]').forEach(a => a.onclick = () => {
    const target = findNr(a.dataset.nr);
    set({ q: baseNr(a.dataset.nr), cat: null, type: null, onlyValid: state.onlyValid && !!target && target.st.valid }, true);
  });
  const copy = el.querySelector('.copy');
  copy.onclick = async () => {
    const ok = await copyText(copy.dataset.copy);
    copy.textContent = ok ? 'Gekopieerd ✓' : 'Kopiëren mislukt';
    copy.classList.toggle('done', ok);
    setTimeout(() => { copy.textContent = 'Kopieer'; copy.classList.remove('done'); }, 1600);
  };
  return el;
}

function render() {
  const { terms, matches: all } = search(state.q);
  const looseOnly = all.filter(m => !m.strict).length;
  const matches = state.loose ? all : all.filter(m => m.strict);
  renderFilters(matches);
  let list = matches.filter(m => pass(m.r));
  const res = $('#results');
  res.replaceChildren();

  if (!terms.length || terms.join('').length < 2) {
    $('#summary').innerHTML = '';
    const rec = recent.get();
    const chips = arr => arr.map(e => `<button class="chip" data-ex="${esc(e)}">${esc(e)}</button>`).join('');
    res.innerHTML = `<div class="empty"><h2>Waar zoek je naar?</h2>
      Typenummer, merk, productnaam, fabrikant of BCRG-nummer. Alle ${R.length.toLocaleString('nl')} verklaringen uit alle categorieën, inclusief de inhoud van de PDF's.
      ${rec.length ? `<div class="recent"><span>Laatst gezocht</span>${chips(rec)}<button class="more" id="clear-recent">wissen</button></div>` : ''}
      <div class="examples">${rec.length ? '<span>Voorbeelden</span>' : ''}${chips(['WH-UD09JE5', 'JKM475N', 'Brink Flair', 'Vasco Boost', 'Nefit', 'Isover'])}</div></div>`;
    res.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => set({ q: b.dataset.ex }, true));
    const cr = $('#clear-recent');
    if (cr) cr.onclick = () => { recent.save([]); render(); };
    return;
  }

  // Geen geldige treffers maar wel vervallen/verlopen: die dan tóch tonen (met opvolger), filter blijft aan
  const q = esc(state.q.trim());
  let invalidHidden = state.onlyValid ? matches.filter(m => pass(m.r, 'valid') && !m.r.st.valid).length : 0;
  const fallback = !list.length && invalidHidden > 0;
  if (fallback) list = matches.filter(m => pass(m.r, 'valid'));
  let hidden = matches.length - list.length - (fallback ? 0 : invalidHidden);
  // Precies een BCRG-nummer gezocht? Die verklaring altijd bovenaan, ook als een filter hem zou verbergen
  const exact = byNr.get(terms.join(''));
  const exactM = exact && matches.find(m => m.r === exact);
  if (exactM && !list.includes(exactM)) {
    list = [exactM, ...list];
    if (pass(exact, 'valid') && !exact.st.valid) invalidHidden--; else hidden--;
  }

  const n = (k, one, many) => `${k.toLocaleString('nl')} ${k === 1 ? one : many}`;
  $('#summary').innerHTML = fallback
    ? `<div class="notice"><strong>Geen geldige verklaring voor “${q}”.</strong> Wel ${n(list.length, 'vervallen of verlopen verklaring', 'vervallen of verlopen verklaringen')} — hieronder, met de opvolger als BCRG die aangeeft.</div>`
    : list.length
      ? `<strong>${list.length.toLocaleString('nl')}</strong> ${list.length === 1 ? 'verklaring' : 'verklaringen'} voor “${q}”` +
        ` · ${list.filter(m => m.r.st.valid).length.toLocaleString('nl')} geldig` +
        (invalidHidden ? ` · <button class="more" id="show-invalid">+ ${n(invalidHidden, 'vervallen/verlopen', 'vervallen/verlopen')} tonen</button>` : '') +
        (hidden ? ` · ${hidden} verborgen door filters` : '')
      : hidden
        ? `<strong>Niets gevonden met de huidige filters</strong> — wel ${n(hidden, 'verklaring', 'verklaringen')} voor “${q}” als je de filters uitzet.`
        : looseOnly ? '' : `Niets gevonden voor “${q}”. Probeer een korter stuk van het typenummer.`;
  // Woorden wel gevonden, maar niet bij elkaar (bv. type in de ene tabelrij, Wp in een andere)
  if (looseOnly && !state.loose) {
    $('#summary').insertAdjacentHTML('beforeend', !matches.length
      ? `<div class="notice"><strong>Geen verklaring waarin “${q}” bij elkaar staat.</strong> Wel ${n(looseOnly, 'verklaring', 'verklaringen')} waarin de woorden los van elkaar voorkomen (bv. het type in de ene tabelrij en het vermogen in een andere) — waarschijnlijk niet hetzelfde product. <button class="more" id="show-loose">Toch tonen</button></div>`
      : ` · <button class="more" id="show-loose">+ ${n(looseOnly, 'losse treffer', 'losse treffers')} tonen</button>`);
    $('#show-loose').onclick = () => set({ loose: true });
  } else if (state.loose && looseOnly) {
    $('#summary').insertAdjacentHTML('beforeend', ` · <span class="loose-note">inclusief ${n(looseOnly, 'losse treffer', 'losse treffers')} (woorden niet bij elkaar)</span> <button class="more" id="hide-loose">verbergen</button>`);
    $('#hide-loose').onclick = () => set({ loose: false });
  }
  const si = $('#show-invalid');
  if (si) si.onclick = () => set({ onlyValid: false });

  if (!list.length && hidden) {
    const b = document.createElement('button');
    b.className = 'btn clearfilters';
    b.textContent = `Filters uitzetten en ${hidden} ${hidden === 1 ? 'resultaat' : 'resultaten'} tonen`;
    b.onclick = () => set({ cat: null, type: null, onlyValid: false, calc: false });
    res.append(b);
  }
  // Typenummer gezocht bij toestellen? Eerst 'alleen dit toestel', dan combinaties met steeds meer andere toestellen
  const cis = new Map(list.map(m => [m.r, exactM ? null : comboInfo(m.r, terms)]));
  const grouped = list.filter(m => cis.get(m.r)).length >= 2;
  if (grouped) {
    const key = m => groupOf(cis.get(m.r)) === 'rest' ? Infinity : groupOf(cis.get(m.r));
    list = list.map((m, i) => ({ m, i })).sort((a, b) => key(a.m) - key(b.m)
      || (cis.get(b.m.r)?.inTitle ? 1 : 0) - (cis.get(a.m.r)?.inTitle ? 1 : 0)
      || a.i - b.i).map(x => x.m);
  }
  const multi = comboTerms(terms).length > 1
    && list.some(m => (cis.get(m.r)?.matched.filter(Boolean).length || 0) > 1);
  let lastGroup;
  const looseSet = new Set(all.filter(m => !m.strict).map(m => m.r));
  for (const m of list.slice(0, state.shown)) {
    if (grouped) {
      const g = groupOf(cis.get(m.r));
      if (g !== lastGroup) {
        const count = list.filter(x => groupOf(cis.get(x.r)) === g).length;
        const h = document.createElement('h3');
        h.className = 'group-h';
        h.innerHTML = `${g === 'rest' ? 'Niet alle zoektermen in de titel' : groupLabel(g, multi)} <span>${count}</span>`;
        res.append(h);
        lastGroup = g;
      }
    }
    const c = card(m.r, terms, grouped ? cis.get(m.r) : null);
    if (looseSet.has(m.r)) {
      c.classList.add('loose');
      c.insertAdjacentHTML('afterbegin', '<div class="loose-tag">Losse treffer: de zoekwoorden staan niet bij elkaar in deze verklaring</div>');
    }
    res.append(c);
  }
  if (list.length > state.shown) {
    const b = document.createElement('button');
    b.className = 'chip loadmore';
    b.textContent = `Meer tonen (${(list.length - state.shown).toLocaleString('nl')} over)`;
    b.onclick = () => set({ shown: state.shown + PAGE });
    res.append(b);
  }
}

// ---------- State + URL ----------
function set(patch, updateInput) {
  if ('q' in patch || 'cat' in patch || 'type' in patch || 'onlyValid' in patch || 'calc' in patch) state.shown = PAGE;
  if ('q' in patch && !('loose' in patch) && patch.q !== state.q) state.loose = false;
  Object.assign(state, patch);
  if (updateInput) { $('#q').value = state.q; window.scrollTo({ top: 0 }); }
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.cat) p.set('cat', state.cat);
  if (state.type) p.set('soort', TYPE_SHORT[state.type]);
  if (!state.onlyValid) p.set('alle', '1');
  if (state.calc) p.set('reken', '1');
  history.replaceState(null, '', p.toString() ? '#' + p : location.pathname + location.search);
  render();
  // Onthouden als 'laatst gezocht' zodra je even stopt met typen en er iets gevonden is
  clearTimeout(recentTimer);
  if ('q' in patch) recentTimer = setTimeout(() => {
    const n = search(state.q).matches.length;
    if (n) remember(state.q);
    if (norm(state.q).length >= 2) track('search', { q: state.q.trim(), n });
  }, 1500);
}
let recentTimer;

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || '';
  state.cat = CATS.includes(p.get('cat')) ? p.get('cat') : null;
  state.type = TYPES.find(t => TYPE_SHORT[t] === p.get('soort')) || null;
  state.onlyValid = p.get('alle') !== '1';
  state.calc = p.get('reken') === '1';
  state.shown = PAGE;
  $('#q').value = state.q;
}
readHash();
window.addEventListener('hashchange', () => { readHash(); render(); });

let timer;
$('#q').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => set({ q: e.target.value }), 120); });
$('#clear').onclick = () => { set({ q: '' }, true); $('#q').focus(); };
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); $('#q').select(); }
  if (e.key === 'Escape' && document.activeElement === $('#q')) set({ q: '' }, true);
  if (e.key === 'Enter' && document.activeElement === $('#q')) {
    clearTimeout(timer);
    set({ q: $('#q').value });
    if (search(state.q).matches.length) remember(state.q);
    $('#q').blur();   // telefoon: toetsenbord weg, resultaten in beeld
  }
});

// =====================================================================================================
// Opnamerapport screenen: PDF wordt in de browser gelezen (eigen kopie van pdf.js), niets verlaat het toestel.
// Per 'Merk, type, installatiejaar' (en isolatie / bekende merken bij 'Type toestel') zoeken we
// kandidaat-verklaringen met een zachte vergelijking: zeldzame woorden en aaneengesloten typenummers
// wegen zwaar, losse cijfers/eenheden ('3', '310wp') identificeren niets.
// =====================================================================================================
// pdf.js 3.11.174 zit in de eigen map (vendor/pdfjs, SRI-gecontroleerd tegen cdnjs): geen derde partij bij het screenen
const PDFJS = 'vendor/pdfjs/';
const SCREEN_STOP = new Set(('binnen buiten unit binnenunit buitenunit toestel installatiejaar lengte pijp m graden matig ' +
  'sterk niet zwak geventileerd onbekend type merk en of met de het een x noord oost zuid west zuidoost zuidwest ' +
  'noordoost noordwest dak plat hellend jaar ca circa nvt n.v.t').split(' '));
const SCREEN_LABELS = new Set(['ventilatiesysteem', 'subsysteem', '2e opwekker', 'type toestel', 'merk, type, installatiejaar',
  'distributiemedium', 'type opwekker', 'zonne-energiesysteem', 'koeling', 'afgiftesysteem', 'regeling', 'ventilatoren',
  'tweede tapwatersysteem aanwezig?', 'binnen de thermische zone?', 'type warmtepomp', 'bron warmtepomp', 'daktype',
  'isolatie/spouw dak', 'rieten dak?', 'gaskeur (maak een duidelijke foto van gaskeur)', 'cw-klasse', 'verwarming',
  'ventilatie', 'zonne-energie', 'aantal tapwatersystemen', 'type installatie (tapwatersysteem 1)', 'koelsysteem']);
const SCREEN_SECTIONS = { 'ventilatie': 'Ventilatie', 'verwarming': 'Ruimteverwarming', 'aantal tapwatersystemen': 'Tapwater',
  'tweede tapwatersysteem aanwezig?': 'Tapwater', 'koeling': 'Ruimtekoeling', 'zonne-energie': 'PV-cellen' };
const SECTION_NL = { 'Ventilatie': 'Ventilatie', 'Ruimteverwarming': 'Verwarming', 'Tapwater': 'Tapwater',
  'Ruimtekoeling': 'Koeling', 'PV-cellen': 'Zonne-energie', 'Bouwkundig': 'Isolatie' };
// Merken die in BCRG voorkomen (eerste woord fabrikant), om 'Type toestel: Quooker Combi' te herkennen
const BRANDS = new Set(R.map(r => norm((r.mfr.split(/[\s/,]+/)[0]) || '')).filter(b => b.length >= 4));

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((ok, fail) => {
    const sc = Object.assign(document.createElement('script'), { src: PDFJS + 'pdf.min.js' });
    sc.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(pdfjsLib); };
    sc.onerror = () => fail(new Error('pdf.js kon niet geladen worden (vendor/pdfjs ontbreekt?)'));
    document.head.append(sc);
  });
}

// Tekstregels per pagina, in leesvolgorde (items op dezelfde hoogte = één regel)
async function pdfLines(buf) {
  const pdf = await (await loadPdfJs()).getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const items = (await (await pdf.getPage(i)).getTextContent()).items.filter(it => it.str.trim());
    const rows = [];
    for (const it of items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
      const y = it.transform[5];
      const row = rows.find(r => Math.abs(r.y - y) < 3);
      if (row) row.items.push(it); else rows.push({ y, items: [it] });
    }
    pages.push(rows.map(r => r.items.sort((a, b) => a.transform[4] - b.transform[4]).map(it => it.str).join(' ')
      .normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean));
  }
  return pages;
}

function parseReport(pages) {
  const header = pages[0][0] || '';                       // bv. '6224BA_42': staat bovenaan elke pagina
  const lines = pages.flat().filter(l => l !== header && !/^(Label-UP|info@label-up|Page \d+\/\d+)/i.test(l));
  const after = label => { const i = lines.findIndex(l => l.toLowerCase() === label); return i >= 0 ? lines[i + 1] : ''; };
  const loc = lines.indexOf('LOCATION');
  const info = {
    name: header,
    date: after('created on'),
    address: loc >= 0 ? lines.slice(loc + 1, loc + 3).join(', ') : '',
    adviseur: after('adviseur'),
    type: after('inspectietype'),
  };
  const entries = [];
  let sec = null, kind = null, tapSys = 0, tapSame = false;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (SCREEN_SECTIONS[low]) sec = SCREEN_SECTIONS[low];
    if (low === 'aantal tapwatersystemen') tapSys = 1;
    if (low === 'tweede tapwatersysteem aanwezig?') tapSys = 2;
    if (low === 'tapwater hetzelfde als de verwarming?') tapSame = /^(yes|ja)$/i.test(lines[i + 1] || '');
    if (['type opwekker', 'type toestel', 'zonne-energiesysteem', 'type warmtepomp'].includes(low)) kind = lines[i + 1] || null;
    const isMerk = low === 'merk, type, installatiejaar';
    const isIso = low === 'type isolatie (indien bekend)';
    const isBrandToestel = low === 'type toestel' && lines[i + 1] && BRANDS.has(norm(lines[i + 1].split(' ')[0]));
    if (!isMerk && !isIso && !isBrandToestel) continue;
    const val = [];
    for (const v of lines.slice(i + 1, i + 5)) {
      if (SCREEN_LABELS.has(v.toLowerCase()) || v.endsWith('?')) break;
      val.push(v);
      if (isBrandToestel) break;
    }
    if (val.length) entries.push({ sec: isIso ? 'Bouwkundig' : sec, kind: isIso ? 'Isolatie' : kind, raw: val.join(' / '),
      tapSys: sec === 'Tapwater' ? tapSys : 0 });
  }

  // 'Tapwater hetzelfde als de verwarming? Yes' en bij tapwatersysteem 1 geen bruikbaar merk/type ingevuld
  // (leeg, of iets als 'Cv'): dan is de opwekker van de verwarming ook de tapwateropwekker.
  const heat = entries.filter(e => e.sec === 'Ruimteverwarming');
  const tap1 = entries.filter(e => e.sec === 'Tapwater' && e.tapSys === 1);
  if (tapSame && heat.length && !tap1.some(e => !vagueRaw(e.raw))) {
    const at = tap1.length ? entries.indexOf(tap1[0]) : entries.lastIndexOf(heat[heat.length - 1]) + 1;
    const derived = heat.map(h => ({ sec: 'Tapwater', kind: 'zelfde opwekker als verwarming', raw: h.raw, tapSys: 1,
      derived: tap1.length ? `in het rapport staat bij tapwater alleen "${tap1.map(e => e.raw).join(', ')}"` : 'bij tapwater is geen merk/type ingevuld' }));
    for (const e of tap1) entries.splice(entries.indexOf(e), 1);
    entries.splice(Math.min(at, entries.length), 0, ...derived);
  }
  return { info, entries };
}

// Te weinig om op te zoeken? (geen identificerende woorden, of alleen heel algemene zoals 'Cv')
function vagueRaw(raw) {
  const strong = [...new Set(screenTokens(raw).map(norm).filter(t => t && !weakToken(t)))];
  return !strong.length || Math.max(...strong.map(t => Math.log(R.length / (1 + docFreq(t))))) < 2.5;
}

// Woorden uit vrije invoer: jaartallen, '12x', '35 graden', '2.0m' en vulwoorden eruit
function screenTokens(raw) {
  const t = raw.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b\d+(\.\d+)?\s*m\b/gi, ' ')
    .replace(/\b\d+\s*x\b/gi, ' ').replace(/\b\d+\s*graden\b/gi, ' ');
  return t.split(/[\s,;/()]+/).filter(w => w && !SCREEN_STOP.has(w.toLowerCase()) && norm(w).length >= 1);
}
// Identificeert iets? Losse getallen en eenheden ('300wp', '4kw', '24') niet.
const weakToken = t => /^\d{1,3}$/.test(t) || /^\d+(wp|w|kw|kwh|l|liter|mm|cm)$/.test(t) || t.length < 2;
const typeLike = t => t.length >= 4 && /\d/.test(t) && /[a-z]/.test(t) && !weakToken(t);

const dfCache = new Map();
const docFreq = t => {
  if (!dfCache.has(t)) dfCache.set(t, R.reduce((n, r) => n + (r.metaN.includes(t) || r.textN.includes(t) ? 1 : 0), 0));
  return dfCache.get(t);
};

function screenEntry(e) {
  const words = screenTokens(e.raw);
  const tn = words.map(norm).filter(Boolean);
  const strong = [...new Set(tn.filter(t => !weakToken(t)))];
  const units = [...new Set(tn.filter(t => weakToken(t) && /\d+[a-z]+$/.test(t)))];
  if (!strong.length) return { words, verdict: 'vaag', cands: [] };
  const idf = Object.fromEntries(strong.map(t => [t, Math.log(R.length / (1 + docFreq(t)))]));
  if (Math.max(...Object.values(idf)) < 2.5) return { words, verdict: 'vaag', cands: [] };   // alleen algemene woorden ('Cv')
  const total = strong.reduce((a, t) => a + idf[t], 0);
  const cands = [];
  for (const r of R) {
    let got = 0;
    const hit = {};
    for (const t of strong) {
      if (r.metaN.includes(t)) { got += idf[t]; hit[t] = 'titel'; }
      else if (r.textN.includes(t)) { got += idf[t] * 0.6; hit[t] = 'pdf'; }
    }
    if (!got) continue;
    // Aaneengesloten stukken ('hrc 24/cw4' -> 'hrc24cw4') wegen extra: dat is een echt typenummer
    let bonus = 0;
    for (let n = tn.length; n >= 2 && !bonus; n--) {
      for (let s = 0; s + n <= tn.length; s++) {
        const g = tn.slice(s, s + n).join('');
        const w = tn.slice(s, s + n).filter(t => idf[t]).reduce((a, t) => a + idf[t], 0);
        if (g.length >= 5 && r.metaN.includes(g)) bonus = Math.max(bonus, w * 0.5);
        else if (g.length >= 5 && r.textN.includes(g)) bonus = Math.max(bonus, w * 0.25);
      }
    }
    const cov = got / total;
    // Gevonden ongeacht waar (titel of PDF): daarop beoordelen we de match
    const found = strong.filter(t => hit[t]).reduce((a, t) => a + idf[t], 0) / total;
    // Eenheden als '300wp' identificeren niets, maar zijn wel een nuttige controle
    for (const t of units) hit[t] = r.metaN.includes(t) ? 'titel' : r.textN.includes(t) ? 'pdf' : undefined;
    const unitBonus = units.filter(t => hit[t]).length * 0.05;
    cands.push({ r, cov, found, hit, score: cov + bonus / total + unitBonus + (r.mainCats.includes(e.sec) ? 0.15 : 0) + (r.st.valid ? 0.05 : 0) });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 4).filter(c => c.found >= 0.45);
  const best = top[0];
  const allTypes = best && strong.filter(typeLike).every(t => best.hit[t]);
  // 'Sterk': alles gevonden én meer dan alleen een merknaam (≥2 woorden of een typenummer)
  const specific = strong.length >= 2 || strong.some(typeLike);
  const verdict = !best ? 'geen' : best.found >= 0.95 && allTypes && specific ? 'sterk' : 'mogelijk';
  return { words, strong, units, verdict, cands: top };
}

// Status op de opnamedatum (kan afwijken van vandaag)
function statusOn(r, day) {
  if (!day) return null;
  if (r.from && r.from > day) return 'nog niet geldig';
  if (r.rev && r.rev <= day) return 'ingetrokken';
  if (r.disc && r.disc <= day) return 'vervallen';
  if (r.exp && r.exp <= day) return 'verlopen';
  return 'geldig';
}
const isoDate = s => {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s + ' 12:00');
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

const VERDICT = {
  sterk: ['ok', 'Sterke match'], mogelijk: ['warn', 'Mogelijke match — controleer'],
  geen: ['bad', 'Geen verklaring gevonden'], vaag: ['neutral', 'Te weinig merk/type om te zoeken'],
};

function renderScreen(reports) {
  const box = $('#screen-out');
  box.replaceChildren();
  for (const rep of reports) {
    const day = isoDate(rep.info.date);
    const el = document.createElement('section');
    el.className = 'rep';
    if (rep.error) {
      el.innerHTML = `<div class="rep-h"><b>${esc(rep.file)}</b></div><div class="calc-err">${esc(rep.error)}</div>`;
      box.append(el); continue;
    }
    el.innerHTML = `<div class="rep-h"><b>${esc(rep.info.address || rep.file)}</b>
      <span>${esc([rep.info.type && `${rep.info.type}opname`, day && `opname ${fmtDate(day)}`, rep.info.adviseur].filter(Boolean).join(' · '))}</span></div>
      ${rep.entries.length ? '' : '<div class="calc-hint">Geen merk/type-velden gevonden in dit rapport.</div>'}`;
    for (const e of rep.entries) {
      const res = screenEntry(e);
      let [vk, vl] = VERDICT[res.verdict];
      // Goede match, maar de beste verklaring was niet geldig op de opnamedatum? Dat moet direct opvallen.
      const best = res.cands[0];
      if (res.verdict === 'sterk' && (statusOn(best.r, day) || (best.r.st.valid ? 'geldig' : 'niet')) !== 'geldig') {
        [vk, vl] = ['warn', 'Sterke match — maar die verklaring was niet geldig op de opnamedatum'];
      }
      const q = res.words.join(' ');
      const item = document.createElement('div');
      item.className = 'ent';
      item.innerHTML = `
        <div class="ent-h"><span class="lbl">${esc(SECTION_NL[e.sec] || e.sec || 'Overig')}${e.kind ? ' · ' + esc(e.kind) : ''}</span>
          <span class="badge b-${vk}">${vl}</span></div>
        <div class="ent-raw">${esc(e.raw)}</div>
        ${e.derived ? `<div class="ent-note">Afgeleid: “Tapwater hetzelfde als de verwarming? Yes” en ${esc(e.derived)}.</div>` : ''}
        <div class="ent-cands">${res.cands.map(c => {
          const on = statusOn(c.r, day);
          const onTxt = on && (on === 'geldig') !== c.r.st.valid ? `<span class="badge b-${on === 'geldig' ? 'ok' : 'bad'}">op opnamedatum: ${on}</span>` : '';
          return `<div class="cand">
            <a class="nr" data-go="${esc(baseNr(c.r.nr))}">${esc(baseNr(c.r.nr))}</a>
            <span class="badge b-${c.r.st.key}">${esc(c.r.st.label)}</span>${onTxt}
            <span class="cand-t">${esc(c.r.title)}</span>
            <span class="cand-m">${[...res.strong, ...res.units].map(t => `<i class="${c.hit[t] ? 'y' : 'n'}" title="${c.hit[t] ? 'gevonden in ' + c.hit[t] : 'niet gevonden'}">${c.hit[t] ? '✓' : '✗'} ${esc(t)}</i>`).join('')}</span>
            <a class="pdf" href="${esc(c.r.pdf)}" target="_blank" rel="noopener">PDF ↗</a></div>`;
        }).join('')}</div>
        <div class="ent-q"><input value="${esc(q)}" aria-label="Zoekopdracht aanpassen"><button type="button" class="btn">Zoek</button></div>`;
      const inp = item.querySelector('.ent-q input');
      const go = v => { closeScreen(); set({ q: v, onlyValid: false, cat: null, type: null, calc: false }, true); };
      item.querySelector('.ent-q button').onclick = () => go(inp.value);
      inp.onkeydown = ev => { if (ev.key === 'Enter') go(inp.value); };
      item.querySelectorAll('[data-go]').forEach(a => a.onclick = () => { track('screen_open', { q: a.dataset.go }); go(a.dataset.go); });
      el.append(item);
    }
    box.append(el);
  }
}

async function screenFiles(files) {
  const status = $('#screen-status');
  const reports = [];
  for (const f of files) {
    status.textContent = `Bezig met ${f.name}…`;
    try {
      if (!/\.pdf$/i.test(f.name)) throw new Error('Alleen PDF-bestanden.');
      const { info, entries } = parseReport(await pdfLines(await f.arrayBuffer()));
      reports.push({ file: f.name, info, entries });
    } catch (err) {
      reports.push({ file: f.name, error: 'Kon dit bestand niet lezen: ' + err.message });
    }
  }
  status.textContent = `${reports.length} ${reports.length === 1 ? 'rapport' : 'rapporten'} gescreend — de rapporten zelf zijn in je browser gelezen en niet verstuurd.`;
  renderScreen(reports);
  // Alleen aantallen: geen adressen, geen rapportinhoud
  const v = [...document.querySelectorAll('#screen-out .ent-h .badge')].map(b => b.textContent);
  track('screen', { n: reports.length, meta: {
    toestellen: v.length, sterk: v.filter(x => x.startsWith('Sterke')).length, mogelijk: v.filter(x => x.startsWith('Mogelijke')).length,
    geen: v.filter(x => x.startsWith('Geen')).length, fouten: reports.filter(r => r.error).length } });
}

function openScreen() { document.body.classList.add('screening'); $('#screen').hidden = false; window.scrollTo({ top: 0 }); }
function closeScreen() { document.body.classList.remove('screening'); $('#screen').hidden = true; }
$('#open-screen').onclick = openScreen;
$('#close-screen').onclick = closeScreen;
$('#screen-file').onchange = e => e.target.files.length && screenFiles([...e.target.files]);
const drop = $('#screen-drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files.length && screenFiles([...e.dataTransfer.files]));

// Klikken op een resultaat (PDF, pagina, kopiëren) = deze zoekopdracht was nuttig → direct onthouden
$('#results').addEventListener('click', e => {
  if (!e.target.closest('.card a[href], .card .copy')) return;
  remember(state.q);
  const nr = e.target.closest('.card')?.querySelector('.nr')?.textContent.split(/[ (]/)[0];
  if (e.target.closest('.hit .pg')) track('pdf_page', { q: nr });
  else if (e.target.closest('a[href]')) track('pdf', { q: nr });
  else if (e.target.closest('.row1 .copy')) track('copy', { q: nr });
});
render();
