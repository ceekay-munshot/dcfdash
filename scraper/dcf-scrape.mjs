// Single-company DCF scraper for valueinvesting.io.
//
// v1: plain fetch() + cheerio, NO login, NO browser. The DCF data is server-
// rendered into an inline <script> as `window.most` (a flat field dictionary)
// plus identity globals. A SINGLE fetch of the free `dcf-growth-exit-5y` page
// carries the entire DCF family (growth-exit & ebitda-exit, 5y & 10y) because
// they share one projection and differ only in terminal method / exit year —
// so the gated 10y/ebitda pages (HTTP 403) are redundant.
//
// Usage:
//   node scraper/dcf-scrape.mjs RELIANCE.NS TCS.NS            # live fetch -> public/data/dcf/<T>.json
//   node scraper/dcf-scrape.mjs --html sample.html --ticker RELIANCE.NS   # offline parse
//   import { scrapeTicker, parseDcfHtml } from './dcf-scrape.mjs'

import * as cheerio from 'cheerio';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export const BASE = 'https://valueinvesting.io';
export const PRIMARY_VARIANT = 'dcf-growth-exit-5y';
export const SCHEMA_VERSION = '1.0.0';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- number helpers (normalize ₹/lakh-crore-free millions, %, negatives) ----------
export function cleanNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === '' || s === '-' || /^n\/?a$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } // (1,234) -> negative
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  s = s.replace(/[,₹$€£\s]/g, '').replace(/x$/i, '').replace(/%$/, '');
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}
// percent string -> decimal ratio ("22%" -> 0.22, "13.8%" -> 0.138)
export function pct(v) {
  if (v == null || v === '') return null;
  const hadPct = String(v).includes('%');
  const n = cleanNum(v);
  if (n == null) return null;
  return hadPct ? n / 100 : n;
}

// ---------- blob extraction ----------
// balanced reader: returns the raw JS value substring starting at first non-space at pos
function readValue(str, pos) {
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  const ch = str[pos];
  if (ch === '{' || ch === '[') {
    const open = ch, close = ch === '{' ? '}' : ']';
    let depth = 0, inStr = false, q = '', esc = false, i = pos;
    for (; i < str.length; i++) {
      const c = str[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; }
      else if (c === '"' || c === "'") { inStr = true; q = c; }
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { i++; break; } }
    }
    return { raw: str.slice(pos, i), kind: 'json' };
  }
  if (ch === '"' || ch === "'") {
    const q = ch; let i = pos + 1, esc = false;
    for (; i < str.length; i++) { const c = str[i]; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) { i++; break; } }
    return { raw: str.slice(pos, i), kind: 'string' };
  }
  let i = pos; while (i < str.length && str[i] !== ';' && str[i] !== '\n') i++;
  return { raw: str.slice(pos, i).trim(), kind: 'bare' };
}
// recursively JSON.parse string values that are themselves JSON (the site double-encodes)
function deepJsonify(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) {
      try { return deepJsonify(JSON.parse(t)); } catch { return v; }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(deepJsonify);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepJsonify(v[k]); return o; }
  return v;
}
export function getWindowVar(scriptText, name) {
  const re = new RegExp('window\\.' + name + '\\s*=\\s*');
  const m = re.exec(scriptText);
  if (!m) return undefined;
  const v = readValue(scriptText, m.index + m[0].length);
  try {
    if (v.kind === 'string') {
      const inner = JSON.parse(v.raw); // -> string (or value)
      if (typeof inner === 'string') { try { return deepJsonify(JSON.parse(inner)); } catch { return inner; } }
      return deepJsonify(inner);
    }
    if (v.kind === 'json') return deepJsonify(JSON.parse(v.raw));
    const t = v.raw.replace(/^['"]|['"]$/g, '');
    return t === 'null' ? null : isNaN(Number(t)) ? t : Number(t);
  } catch { return undefined; }
}

function fieldMap(arr) {
  const m = {};
  if (Array.isArray(arr)) for (const r of arr) if (r && r.value_field != null && !(r.value_field in m)) m[r.value_field] = r;
  return m;
}

// ---------- variant definitions ----------
const VARIANTS = [
  { slug: 'dcf-growth-exit-5y', horizon: 5, method: 'perpetuity_growth', end: 'R_end_5', fair: 'fair_price_5', top: 'dcf_5y_growth_top_part', term: 'typical_5', gatedPage: false },
  { slug: 'dcf-growth-exit-10y', horizon: 10, method: 'perpetuity_growth', end: 'R_end_10', fair: 'fair_price_10', top: 'dcf_10y_growth_top_part', term: 'typical_10', gatedPage: true },
  { slug: 'dcf-ebitda-exit-5y', horizon: 5, method: 'exit_multiple', end: 'R_end_ebitda_5', fair: 'fair_price_dcf_ebitda_5', top: 'dcf_5y_ebitda_top_part', term: 'typical_ebitda_5', gatedPage: true },
  { slug: 'dcf-ebitda-exit-10y', horizon: 10, method: 'exit_multiple', end: 'R_end_ebitda_10', fair: 'fair_price_dcf_ebitda_10', top: 'dcf_10y_ebitda_top_part', term: 'typical_ebitda_10', gatedPage: true },
];

// summary_table -> {ranges}; rows R2..R5 are [label, "low - high", "selected"]
function parseSummary(top) {
  if (!top || !top.summary_table) return null;
  const t = top.summary_table;
  const split = (cell) => {
    if (cell == null) return null;
    const parts = String(cell).split(' - ');
    return parts.length === 2 ? { low: pct(parts[0]) ?? cleanNum(parts[0]), high: pct(parts[1]) ?? cleanNum(parts[1]) } : null;
  };
  return {
    squares: top.top_squares || null, // [upside%, price, fair]
    wacc_range: split(t.R2?.[1]), wacc_selected: pct(t.R2?.[2]),
    growth_range: split(t.R3?.[1]), growth_selected: pct(t.R3?.[2]),
    fair_price_range: split(t.R4?.[1]), fair_price_selected: cleanNum(t.R4?.[2]),
    upside_range: split(t.R5?.[1]), upside_selected: pct(t.R5?.[2]),
  };
}

function parseBridge(end) {
  const v = (r) => cleanNum(end?.[r]?.[1]);
  const p2 = (r) => pct(end?.[r]?.[2]);
  return {
    enterprise_value: v('R16'),
    pv_projection: v('R17'), pv_projection_pct: p2('R17'),
    pv_terminal: v('R18'), pv_terminal_pct: p2('R18'),
    net_debt: v('R19'),
    equity_value: v('R20'),
    shares_outstanding: v('R21'),
    fair_value_per_share: v('R22'),
  };
}

// ---------- core parser (pure; testable offline) ----------
// Full normalized skeleton — shared by success docs and failure stubs so every
// public/data/dcf/<T>.json has an identical shape (Codex P2 #3).
export function emptyDoc(ctx = {}, warnings = [], htmlLen = 0) {
  return {
    schema_version: SCHEMA_VERSION,
    scraped_at: new Date().toISOString(),
    ticker: ctx.ticker || null,
    name: null, exchange: null, currency: null, country: null, sector: null, industry: null, as_of: null,
    price_current: null, shares_outstanding: null, net_debt: null, market_cap: null,
    revenue_ttm: null, net_income_ttm: null, ebitda_current: null, eps_ttm: null, beta: null,
    is_financial: false,
    wacc: null,
    shared_projection: [],
    assumptions_raw: null,
    model_tables: {},
    variants: {},
    other_valuations: {},
    source: { carrier: null, url: ctx.url || null, fetched_via: ctx.fetched_via || null, raw_ref: ctx.raw_ref || null },
    _debug: { html_bytes: htmlLen, carrier_found: false, field_count: 0, warnings, variant_status: {}, fetch_ms: ctx.fetch_ms ?? null, http_status: ctx.http_status ?? null },
  };
}

export function parseDcfHtml(html, ctx = {}) {
  const warnings = [];
  const doc = emptyDoc(ctx, warnings, html ? html.length : 0);

  const $ = cheerio.load(html || '');
  // locate the inline carrier script (the one defining window.most)
  let carrier = null;
  $('script').each((_, el) => {
    if (carrier) return;
    const t = $(el).html() || '';
    if (t.includes('window.most') && t.includes('value_field')) carrier = t;
  });
  if (!carrier) {
    warnings.push('carrier script (window.most) not found — page may be gated, a challenge, or markup changed');
    // gating / login hints
    const bodyText = $('body').text().slice(0, 4000);
    doc._debug.gated_hint = /sign in|log ?in|subscribe|upgrade|members? only/i.test(bodyText);
    return doc;
  }
  doc.source.carrier = 'inline_script:window.most';

  const most = getWindowVar(carrier, 'most');
  const m = fieldMap(most);
  doc._debug.field_count = Object.keys(m).length;
  // Codex r4 #1: a window.most script with 0 parsed fields means the markup/format
  // changed — treat as a failure, not a valid empty doc, so a run fails loudly.
  if (doc._debug.field_count === 0) {
    warnings.push('carrier script present but 0 fields parsed (markup may have changed)');
    return doc; // carrier_found stays false
  }
  doc._debug.carrier_found = true;
  const fNum = (f) => (m[f] ? cleanNum(m[f].value_numerical) : null);
  const fTxt = (f) => (m[f] ? m[f].value_text : null);
  // value_text is pre-parsed by deepJsonify when it's JSON; accept object or string
  const fJson = (f) => { const t = fTxt(f); if (t == null) return null; if (typeof t === 'object') return t; try { return JSON.parse(t); } catch { warnings.push(`bad JSON in field ${f}`); return null; } };

  const ed = fJson('excel_dict') || {};
  doc.assumptions_raw = ed;

  // identity / market
  doc.ticker = getWindowVar(carrier, 'Ticker') || doc.ticker;
  doc.name = fTxt('name') || getWindowVar(carrier, 'Company_Name') || null;
  doc.exchange = fTxt('exchange') || null;
  doc.currency = fTxt('currency') || getWindowVar(carrier, 'Price_Currency') || null;
  doc.country = fTxt('country') || null;
  doc.sector = fTxt('gind') || getWindowVar(carrier, 'Sector') || null;
  doc.industry = fTxt('industry_sector') || null;
  doc.as_of = ed.current_reporting_period || ed.current_FY_end || null;
  doc.price_current = fNum('price');
  doc.shares_outstanding = fNum('outstanding_share');
  doc.net_debt = fNum('netDebtInterim');
  doc.market_cap = fNum('marketCapitalization');
  doc.revenue_ttm = fNum('revenueTTM');
  doc.net_income_ttm = fNum('netIncomeCommonTTM');
  doc.ebitda_current = fNum('current_ebitda');
  doc.eps_ttm = fNum('eps');
  doc.beta = fNum('beta');
  doc.is_financial = fNum('finance_sector_yes') === 1 || fNum('is_special_bank') === 1 || fNum('insurance_yes') === 1;
  if (doc.is_financial) warnings.push('financial/bank company — DCF may be N/A or unreliable on the source');

  // WACC build (from wacc_to_json display table + excel_dict)
  const W = fJson('wacc_to_json');
  if (W) {
    const rng = (r) => ({ low: pct(W[r]?.[1]), high: pct(W[r]?.[2]) });
    const rngN = (r) => ({ low: cleanNum(W[r]?.[1]), high: cleanNum(W[r]?.[2]) });
    doc.wacc = {
      selected: fNum('selected_wacc') ?? pct(W.R10?.[1]),
      after_tax_range: rng('R9'),
      build: {
        long_term_bond_rate: rng('R2'),
        equity_risk_premium: rng('R3'),
        adjusted_beta: rngN('R4'),
        additional_risk_adjustment: rng('R0'),
        cost_of_equity: rng('R5'),
        tax_rate: rng('R6'),
        debt_equity_ratio: rngN('R7'),
        cost_of_debt: rng('R8'),
      },
      cost_of_equity_selected: fNum('coe') ?? fNum('avg_coe'),
      cost_of_debt_selected: fNum('avg_cod'),
      beta: fNum('beta'),
      market_risk_premium: fNum('market_risk_premium'),
    };
  }
  const wacc = doc.wacc?.selected ?? null;

  // raw display tables (kept verbatim for the future Excel/engine step)
  for (const [k, f] of Object.entries({ revenue: 'rev_to_json', capex: 'capex_to_json', da: 'DA_to_json', working_capital: 'working_cap_to_json', terminal: 'terminal_to_json', wacc: 'wacc_to_json', eps: 'eps_arr' })) {
    const j = fJson(f);
    if (j != null) doc.model_tables[k] = j;
  }

  // shared FCF build from terminal_to_json (R1..R15), revenue aligned from rev_to_json
  const T = fJson('terminal_to_json');
  const REV = fJson('rev_to_json');
  const revByYear = {};
  if (REV?.R2 && REV?.R3) for (let j = 1; j < REV.R2.length; j++) { const y = parseInt(String(REV.R2[j]).split('-').pop()); if (y > 1900) revByYear[y] = cleanNum(REV.R3[j]); }
  const taxRate = ed.tax_rate_dcf ?? null;
  if (T?.R1) {
    for (let j = 1; j < T.R1.length; j++) {
      const y = parseInt(String(T.R1[j]).replace(/[^0-9]/g, ''));
      if (!(y > 1900)) continue;
      const da = cleanNum(T.R4?.[j]);
      const ebitda = cleanNum(T.R5?.[j]);
      const fcf = cleanNum(T.R9?.[j]);
      const timing = cleanNum(T.R14?.[j]);
      const pv = cleanNum(T.R15?.[j]);
      const ebit = ebitda != null && da != null ? +(ebitda - da).toFixed(3) : null;
      doc.shared_projection.push({
        year: y,
        revenue: revByYear[y] ?? null,
        pretax_profit: cleanNum(T.R2?.[j]),
        net_interest: cleanNum(T.R3?.[j]),
        da,
        ebitda,
        ebit,
        nopat: ebit != null && taxRate != null ? +(ebit * (1 - taxRate)).toFixed(3) : null,
        tax: cleanNum(T.R6?.[j]),
        capex: cleanNum(T.R7?.[j]),
        change_nwc: cleanNum(T.R8?.[j]),
        fcf,
        timing,
        discount_factor: timing != null && wacc != null ? +(1 / Math.pow(1 + wacc, timing)).toFixed(6) : fcf ? +(pv / fcf).toFixed(6) : null,
        pv_fcf: pv,
      });
    }
  } else warnings.push('terminal_to_json missing — no shared projection');

  const topPart = fJson('top_part') || {};
  const termRoot = T || {};

  // per-variant assembly (isolated try/catch each)
  for (const def of VARIANTS) {
    try {
      const bridge = parseBridge(termRoot[def.end]);
      const summary = parseSummary(topPart[def.top]);
      const fairFromField = fNum(def.fair);
      const termRow = termRoot[def.term]; // typical_* : [...,exitYear, pvTerminal]
      // Codex P2 #2: a summary shell alone (banks) is NOT a usable DCF — require a real fair value.
      const populated = fairFromField != null || bridge.fair_value_per_share != null;
      const variant = {
        gated_page: def.gatedPage, // dedicated page is 403, but data present here
        data_available: populated,
        horizon_years: def.horizon,
        terminal: {
          method: def.method,
          perp_growth: def.method === 'perpetuity_growth' ? (ed.avg_long_growth ?? null) : null,
          perp_growth_range: def.method === 'perpetuity_growth' && Array.isArray(ed.long_grow_arr) ? { low: ed.long_grow_arr[0], high: ed.long_grow_arr[1] } : null,
          exit_multiple: def.method === 'exit_multiple' ? cleanNum(termRoot.R10?.[1]) ?? fNum('avg_trailing_ev_ebitda') : null,
          exit_year: Array.isArray(termRow) ? cleanNum(termRow[termRow.length - 2]) : def.horizon,
          terminal_value_pv: Array.isArray(termRow) ? cleanNum(termRow[termRow.length - 1]) : (bridge.pv_terminal ?? null),
        },
        wacc_selected: summary?.wacc_selected ?? wacc,
        ...bridge,
        fair_value_per_share: fairFromField ?? bridge.fair_value_per_share ?? null,
        fair_value_bridge_rounded: bridge.fair_value_per_share ?? null,
        upside_pct: doc.price_current && (fairFromField ?? bridge.fair_value_per_share) != null ? +(((fairFromField ?? bridge.fair_value_per_share) / doc.price_current) - 1).toFixed(4) : (summary?.upside_selected ?? null),
        sensitivity: {
          fair_price_range: summary?.fair_price_range ?? null,
          wacc_range: summary?.wacc_range ?? null,
          // Codex #6: for ebitda-exit, summary row3 is the EXIT-MULTIPLE range, not growth.
          growth_range: def.method === 'exit_multiple' ? null : (summary?.growth_range ?? null),
          exit_multiple_range: def.method === 'exit_multiple' ? (summary?.growth_range ?? null) : null,
          terminal_value_grid: termRoot.R11?.[1] ?? null,
        },
        summary_squares: summary?.squares ?? null,
      };
      doc.variants[def.slug] = variant;
      doc._debug.variant_status[def.slug] = populated ? 'ok' : 'no-data';
    } catch (e) {
      doc.variants[def.slug] = { error: String(e?.message || e), data_available: false };
      doc._debug.variant_status[def.slug] = 'error';
      warnings.push(`variant ${def.slug}: ${e?.message || e}`);
    }
  }

  // other (non-DCF) valuations — captured opportunistically, single fetch
  doc.other_valuations = {
    epv_fair_price: fNum('avg_epv_fair_price'),
    ddm_stable_fair_price: fNum('avg_ddm_fair_price_stable'),
    ddm_multi_fair_price: fNum('ddm_fair_price_multi'),
    peter_lynch_fair_price: fNum('peter_lynch_fair_price'),
    trailing_pe: fNum('trailing_pe'),
    forward_pe: fNum('forward_pe'),
    trailing_ev_ebitda: fNum('avg_trailing_ev_ebitda'),
  };

  // relative valuation — VI gives the peer set as ticker lists (the per-peer
  // multiples are looked up client-side from each peer's own doc). Plus the
  // subject's own multiples & forward EBITDA for the EV/EBITDA cross-check.
  const asTickers = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);
  doc.relative = {
    peers_pe: asTickers(fTxt('peers_pe')),
    peers_ev: asTickers(fTxt('peers_ev')),
    forward_pe: fNum('forward_pe'),
    trailing_pe: fNum('trailing_pe'),
    forward_ev_ebitda: fNum('forward_ev_ebitda'),
    trailing_ev_ebitda: fNum('avg_trailing_ev_ebitda'),
    forward_ebitda: fNum('forward_ebitda'),
    current_ebitda: fNum('current_ebitda'),
  };

  // sanity: does our primary fair value match the headline?
  const primary = doc.variants['dcf-growth-exit-5y'];
  if (primary?.fair_value_per_share == null) warnings.push('primary growth-exit-5y fair value missing');

  return doc;
}

// ---------- fetch w/ retry + backoff + timeout, honoring Retry-After (429) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseRetryAfter(h) {
  if (!h) return null;
  const s = Number(h);
  if (isFinite(s)) return Math.min(Math.max(s, 0) * 1000, 60000);
  const d = Date.parse(h);
  if (!isNaN(d)) return Math.min(Math.max(d - Date.now(), 0), 60000);
  return null;
}
export async function fetchWithRetry(url, { tries = 6, timeoutMs = 25000, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': CHROME_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = parseRetryAfter(res.headers.get('retry-after'));
        await res.text().catch(() => {}); // drain socket
        if (i < tries - 1) { await sleep(ra != null ? ra + 250 : Math.min(2000 * 2 ** i, 30000)); continue; }
        return { status: res.status, body: '', ms: Date.now() - started, headers: Object.fromEntries(res.headers.entries()) };
      }
      const body = await res.text();
      return { status: res.status, body, ms: Date.now() - started, headers: Object.fromEntries(res.headers.entries()) };
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(Math.min(2000 * 2 ** i, 30000));
    }
  }
  throw lastErr;
}

export async function scrapeTicker(ticker, { variant = PRIMARY_VARIANT } = {}) {
  const url = `${BASE}/${ticker}/valuation/${variant}`;
  let resp;
  try {
    resp = await fetchWithRetry(url);
  } catch (e) {
    return parseStub(ticker, url, `fetch failed: ${String(e?.message || e)}`);
  }
  if (resp.status !== 200) {
    const stub = parseStub(ticker, url, `HTTP ${resp.status}`);
    stub._debug.http_status = resp.status;
    return stub;
  }
  return parseDcfHtml(resp.body, { ticker, url, fetched_via: 'fetch', raw_ref: url, fetch_ms: resp.ms, http_status: resp.status });
}

function parseStub(ticker, url, reason) {
  const doc = emptyDoc({ ticker, url, fetched_via: 'fetch', raw_ref: url }, [reason], 0);
  doc._debug.error = reason;
  return doc;
}

// ---------- CLI ----------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const outDir = path.resolve('public/data/dcf');
  await mkdir(outDir, { recursive: true });
  let failures = 0;

  const htmlIdx = args.indexOf('--html');
  if (htmlIdx !== -1) {
    // offline mode: --html <file> --ticker <T> [--out <file>]
    const file = args[htmlIdx + 1];
    const ticker = args[args.indexOf('--ticker') + 1] || path.basename(path.dirname(file));
    const html = await readFile(file, 'utf8');
    const doc = parseDcfHtml(html, { ticker, url: `offline:${file}`, fetched_via: 'offline', raw_ref: file });
    const outIdx = args.indexOf('--out');
    const out = outIdx !== -1 ? args[outIdx + 1] : path.join(outDir, `${ticker}.json`);
    await writeFile(out, JSON.stringify(doc, null, 2));
    const p = doc.variants['dcf-growth-exit-5y'];
    console.log(`[offline] ${ticker} -> ${out} | carrier=${doc._debug.carrier_found} fields=${doc._debug.field_count} fair5y=${p?.fair_value_per_share} upside=${p?.upside_pct} warnings=${doc._debug.warnings.length}`);
  } else {
    const tickers = args.filter((a) => !a.startsWith('--'));
    for (const t of tickers) {
      const doc = await scrapeTicker(t);
      await writeFile(path.join(outDir, `${t}.json`), JSON.stringify(doc, null, 2));
      const p = doc.variants?.['dcf-growth-exit-5y'];
      const ok = doc._debug.carrier_found;
      if (!ok) failures++;
      console.log(`[scrape] ${t} -> public/data/dcf/${t}.json | http=${doc._debug.http_status ?? '?'} carrier=${ok} fair5y=${p?.fair_value_per_share ?? 'n/a'} upside=${p?.upside_pct ?? 'n/a'} ${doc._debug.fetch_ms ? doc._debug.fetch_ms + 'ms' : ''}`);
    }
    if (failures && tickers.length && failures === tickers.length) {
      console.error(`All ${failures} scrapes failed.`);
      process.exit(1); // Codex P2 #3: fail loudly when nothing succeeded
    }
  }
}
