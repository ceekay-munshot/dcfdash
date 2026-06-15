// Build the INDIAN ticker universe for valueinvesting.io.
//
// VI's sitemap is global ex-India, and VI exposes no static ticker list / open
// search API (probed). The authoritative source that loads from a GitHub runner
// is the official NSE equity master list. Cascade: NSE archive CSV -> GitHub
// mirror -> embedded seed. Map SYMBOL -> SYMBOL.NS, then PROBE each with the
// reader and keep the ones VI actually covers (window.most present).
//
// Output: public/data/universe.json = { ..., tickers: [{ticker,name,exchange,sector}] }
//
// Env: UNIVERSE_CONCURRENCY (default 5), UNIVERSE_DELAY_MS (default 120),
//      UNIVERSE_LIMIT (probe only first N candidates; default all),
//      UNIVERSE_SERIES (CSV series to keep; default "EQ,BE,SM").

import { parseDcfHtml, fetchWithRetry, BASE, PRIMARY_VARIANT } from './dcf-scrape.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NSE_HEADERS = { referer: 'https://www.nseindia.com/', accept: 'text/csv,application/csv,*/*', 'accept-language': 'en-US,en;q=0.9' };
const LIST_SOURCES = [
  { name: 'NSE archives EQUITY_L', url: 'https://archives.nseindia.com/content/equities/EQUITY_L.csv', headers: NSE_HEADERS, kind: 'nse_csv' },
  { name: 'NSE nsearchives EQUITY_L', url: 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', headers: NSE_HEADERS, kind: 'nse_csv' },
];
// last-resort seed (only if every list source fails) — large/mid NSE names
const SEED = 'RELIANCE TCS HDFCBANK INFY ICICIBANK HINDUNILVR ITC SBIN BHARTIARTL KOTAKBANK LT BAJFINANCE AXISBANK ASIANPAINT MARUTI HCLTECH SUNPHARMA TITAN ULTRACEMCO WIPRO NESTLEIND ONGC NTPC POWERGRID TATAMOTORS TATASTEEL ADANIENT COALINDIA JSWSTEEL GRASIM IDEA BPCL HINDPETRO IOC'.split(' ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

function parseNseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toUpperCase());
  const iSym = header.indexOf('SYMBOL');
  const iName = header.findIndex((h) => h.startsWith('NAME OF COMPANY'));
  const iSeries = header.indexOf('SERIES');
  if (iSym === -1) return [];
  const keepSeries = new Set((process.env.UNIVERSE_SERIES || 'EQ,BE,SM').split(',').map((s) => s.trim().toUpperCase()));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const sym = (c[iSym] || '').trim();
    const series = iSeries >= 0 ? (c[iSeries] || '').trim().toUpperCase() : 'EQ';
    if (!sym) continue;
    if (iSeries >= 0 && !keepSeries.has(series)) continue;
    rows.push({ ticker: `${sym}.NS`, name: iName >= 0 ? (c[iName] || '').trim() : null, exchange: 'NSE' });
  }
  return rows;
}

async function loadCandidates() {
  const attempts = [];
  for (const src of LIST_SOURCES) {
    try {
      const r = await fetchWithRetry(src.url, { tries: 3, timeoutMs: 25000, headers: src.headers });
      if (r.status === 200 && r.body && /SYMBOL/i.test(r.body)) {
        const rows = parseNseCsv(r.body);
        attempts.push({ name: src.name, status: r.status, rows: rows.length });
        if (rows.length > 100) return { source: src.name, candidates: rows, attempts };
      } else {
        attempts.push({ name: src.name, status: r.status, rows: 0 });
      }
    } catch (e) {
      attempts.push({ name: src.name, error: String(e?.message || e) });
    }
  }
  // seed fallback
  attempts.push({ name: 'embedded seed', rows: SEED.length });
  return { source: 'embedded seed (list sources failed)', candidates: SEED.map((s) => ({ ticker: `${s}.NS`, name: null, exchange: 'NSE' })), attempts };
}

async function probeOne(c, delayMs) {
  if (delayMs) await sleep(jitter(delayMs));
  const url = `${BASE}/${c.ticker}/valuation/${PRIMARY_VARIANT}`;
  try {
    const r = await fetchWithRetry(url, { tries: 3, timeoutMs: 20000 });
    if (r.status !== 200) return { ...c, covered: false, reason: `http ${r.status}` };
    const doc = parseDcfHtml(r.body, { ticker: c.ticker });
    if (!doc._debug.carrier_found) return { ...c, covered: false, reason: 'no carrier' };
    const hasDcf = !!doc.variants?.['dcf-growth-exit-5y']?.data_available;
    return { ticker: c.ticker, name: doc.name || c.name, exchange: c.exchange, sector: doc.sector || null, is_financial: !!doc.is_financial, has_dcf: hasDcf, covered: true };
  } catch (e) {
    return { ...c, covered: false, reason: String(e?.message || e) };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function buildUniverse() {
  const t0 = Date.now();
  const concurrency = Number(process.env.UNIVERSE_CONCURRENCY || 5);
  const delayMs = Number(process.env.UNIVERSE_DELAY_MS || 120);
  const limit = Number(process.env.UNIVERSE_LIMIT || Infinity);

  const { source, candidates, attempts } = await loadCandidates();
  if (!candidates.length) throw new Error('no candidate tickers from any list source');
  const probeSet = isFinite(limit) ? candidates.slice(0, limit) : candidates;
  console.log(`[universe] list source: ${source} | candidates: ${candidates.length} | probing: ${probeSet.length} (conc=${concurrency}, delay=${delayMs}ms)`);

  let done = 0;
  let coveredCount = 0;
  const results = await pool(probeSet, concurrency, async (c) => {
    const r = await probeOne(c, delayMs);
    done++;
    if (r?.covered) coveredCount++;
    if (done % 250 === 0) console.log(`[universe] probed ${done}/${probeSet.length} (covered so far: ${coveredCount})`);
    return r;
  });

  const covered = results.filter((r) => r?.covered).map((r) => ({ ticker: r.ticker, name: r.name, exchange: r.exchange, sector: r.sector || null }));
  covered.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const dropped = results.filter((r) => r && !r.covered);

  const byExchange = {};
  for (const t of covered) byExchange[t.exchange] = (byExchange[t.exchange] || 0) + 1;
  const dropReasons = {};
  for (const d of dropped) { const k = (d.reason || 'unknown').replace(/\d+/g, 'N'); dropReasons[k] = (dropReasons[k] || 0) + 1; }

  const total = covered.length;
  const sanityOk = total >= 1200 && total <= 3000;

  return {
    generated_at: new Date().toISOString(),
    list_source: source,
    list_attempts: attempts,
    candidate_count: candidates.length,
    probed: probeSet.length,
    total,
    by_exchange: byExchange,
    drop_reasons: dropReasons,
    sanity: { expected_range: '1500-2500', ok: sanityOk, note: sanityOk ? 'within expected range' : 'OUTSIDE expected range — investigate' },
    ms: Date.now() - t0,
    tickers: covered,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const u = await buildUniverse();
  const outDir = path.resolve('public/data');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'universe.json'), JSON.stringify(u, null, 2));
  console.log(`[universe] DONE: ${u.total} covered Indian tickers (from ${u.candidate_count} ${u.list_source} candidates) in ${(u.ms / 1000).toFixed(1)}s`);
  console.log(`[universe] by_exchange=${JSON.stringify(u.by_exchange)} sanity=${u.sanity.ok ? 'OK' : 'CHECK'} drop_reasons=${JSON.stringify(u.drop_reasons)}`);
  if (u.total === 0) { console.error('Universe empty — failing.'); process.exit(1); }
}
