// Build the INDIAN candidate universe for valueinvesting.io from the official
// NSE equity master list. NO coverage-probe — coverage is a byproduct of the
// single gentle batch scrape (halves request load + 429 exposure). Cascade the
// list source (NSE archive -> nsearchives -> embedded seed) and report which won.
//
// Output: public/data/universe.json = { ..., tickers: [{ticker,name,exchange}] }

import { fetchWithRetry } from './dcf-scrape.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NSE_HEADERS = { referer: 'https://www.nseindia.com/', accept: 'text/csv,application/csv,*/*', 'accept-language': 'en-US,en;q=0.9' };
const LIST_SOURCES = [
  { name: 'NSE archives EQUITY_L', url: 'https://archives.nseindia.com/content/equities/EQUITY_L.csv', headers: NSE_HEADERS },
  { name: 'NSE nsearchives EQUITY_L', url: 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', headers: NSE_HEADERS },
];
// last-resort seed (only if every list source fails) — large/mid NSE names
const SEED = 'RELIANCE TCS HDFCBANK INFY ICICIBANK HINDUNILVR ITC SBIN BHARTIARTL KOTAKBANK LT BAJFINANCE AXISBANK ASIANPAINT MARUTI HCLTECH SUNPHARMA TITAN ULTRACEMCO WIPRO NESTLEIND ONGC NTPC POWERGRID TATAMOTORS TATASTEEL ADANIENT COALINDIA JSWSTEEL GRASIM IDEA BPCL HINDPETRO IOC'.split(' ');
const MIN_VALID = 1000; // below this we assume a broken/seed list and fail (Codex #2)

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
      const r = await fetchWithRetry(src.url, { tries: 4, timeoutMs: 25000, headers: src.headers });
      if (r.status === 200 && r.body && /SYMBOL/i.test(r.body)) {
        const rows = parseNseCsv(r.body);
        attempts.push({ name: src.name, status: r.status, rows: rows.length });
        if (rows.length > 100) return { source: src.name, seed: false, candidates: rows, attempts };
      } else {
        attempts.push({ name: src.name, status: r.status, rows: 0 });
      }
    } catch (e) {
      attempts.push({ name: src.name, error: String(e?.message || e) });
    }
  }
  attempts.push({ name: 'embedded seed', rows: SEED.length });
  return { source: 'embedded seed (NSE sources failed)', seed: true, candidates: SEED.map((s) => ({ ticker: `${s}.NS`, name: null, exchange: 'NSE' })), attempts };
}

export async function buildUniverse() {
  const t0 = Date.now();
  const { source, seed, candidates, attempts } = await loadCandidates();
  // dedupe by ticker, sort
  const map = new Map();
  for (const c of candidates) if (!map.has(c.ticker)) map.set(c.ticker, c);
  const tickers = [...map.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const byExchange = {};
  for (const t of tickers) byExchange[t.exchange] = (byExchange[t.exchange] || 0) + 1;
  return {
    generated_at: new Date().toISOString(),
    list_source: source,
    seed_fallback_used: seed,
    list_attempts: attempts,
    total: tickers.length,
    by_exchange: byExchange,
    note: 'Candidate list (no coverage-probe). Coverage is determined by the batch scrape; see dcf-metadata.json.',
    ms: Date.now() - t0,
    tickers,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const u = await buildUniverse();
  const outDir = path.resolve('public/data');
  await mkdir(outDir, { recursive: true });
  // Codex #2: never publish a seed-only / broken universe
  if (u.seed_fallback_used || u.total < MIN_VALID) {
    console.error(`[universe] FAIL: source=${u.list_source} total=${u.total} (< ${MIN_VALID} or seed). Not writing universe.json.`);
    console.error(`[universe] attempts: ${JSON.stringify(u.list_attempts)}`);
    process.exit(1);
  }
  await writeFile(path.join(outDir, 'universe.json'), JSON.stringify(u, null, 2));
  console.log(`[universe] ${u.total} candidate .NS tickers from ${u.list_source} in ${(u.ms / 1000).toFixed(1)}s`);
}
