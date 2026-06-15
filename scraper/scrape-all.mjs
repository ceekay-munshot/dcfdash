// Resumable, polite batch runner. Reads public/data/universe.json (candidate
// list), scrapes each ticker -> public/data/dcf/<TICKER>.json (minified), and
// rebuilds public/data/index.json (covered-only, for frontend search) +
// public/data/dcf-metadata.json (real covered/no_dcf/failed) from a disk scan.
//
// Env: START_AT (0), MAX_COMPANIES (all), CONCURRENCY (2), DELAY_MS (500).
// Politeness targets ~3-4 req/s; the reader honors Retry-After on 429.

import { scrapeTicker, emptyDoc } from './dcf-scrape.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('public/data');
const DCF = path.join(OUT, 'dcf');
const PRIMARY = 'dcf-growth-exit-5y';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }
async function pool(items, n, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  }));
}

// Rebuild index.json + coverage stats from whatever docs are on disk (resume-safe).
async function buildIndexAndStats(universe) {
  const companies = [];
  let covered = 0, no_dcf = 0, failed = 0;
  for (const u of universe.tickers) {
    const doc = await readJson(path.join(DCF, `${u.ticker}.json`));
    if (!doc || !doc._debug?.carrier_found) { failed++; continue; }
    const v = doc.variants?.[PRIMARY];
    const fair = v?.fair_value_per_share ?? null;
    if (fair != null) {
      covered++;
      companies.push({
        ticker: doc.ticker || u.ticker,
        name: doc.name || u.name || null,
        exchange: doc.exchange || u.exchange || null,
        sector: doc.sector || null,
        currency: doc.currency || null,
        price: doc.price_current ?? null,
        fair_value: fair,
        upside_pct: v?.upside_pct ?? null,
      });
    } else {
      no_dcf++; // carrier present but no DCF (e.g., banks -> DDM); excluded from the DCF search index
    }
  }
  companies.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { companies, covered, no_dcf, failed };
}

async function main() {
  const universe = await readJson(path.join(OUT, 'universe.json'));
  if (!universe || !Array.isArray(universe.tickers) || !universe.tickers.length) {
    console.error('public/data/universe.json missing or empty — run build-universe.mjs first');
    process.exit(1);
  }
  const START_AT = Number(process.env.START_AT || 0);
  const MAX = Number(process.env.MAX_COMPANIES || Infinity);
  const CONC = Number(process.env.CONCURRENCY || 2);
  const DELAY = Number(process.env.DELAY_MS || 500);
  const all = universe.tickers;
  const slice = all.slice(START_AT, isFinite(MAX) ? START_AT + MAX : undefined);
  await mkdir(DCF, { recursive: true });
  console.log(`[batch] universe=${all.length} slice=[${START_AT}..${START_AT + slice.length}) conc=${CONC} delay=${DELAY}ms (~${(CONC / (0.1 + DELAY / 1000)).toFixed(1)} req/s)`);

  const run = { attempted: 0, succeeded: 0, no_dcf: 0, failed: 0, stale_kept: 0 };
  const failures = [];
  let done = 0;
  const t0 = Date.now();

  await pool(slice, CONC, async (entry) => {
    await sleep(jitter(DELAY));
    run.attempted++;
    const t = entry.ticker;
    const file = path.join(DCF, `${t}.json`);
    let doc = null, err = null;
    try { doc = await scrapeTicker(t); } catch (e) { err = String(e?.message || e); }

    if (doc && doc._debug?.carrier_found) {
      doc.name = doc.name || entry.name || null;
      doc.sector = doc.sector || entry.sector || null;
      const hasDcf = doc.variants?.[PRIMARY]?.fair_value_per_share != null;
      await writeFile(file, JSON.stringify(doc)); // minified (repo size)
      if (hasDcf) run.succeeded++; else { run.no_dcf++; }
    } else {
      const reason = err || doc?._debug?.error || doc?._debug?.warnings?.[0] || 'no carrier';
      const prev = await readJson(file);
      if (prev && prev._debug?.carrier_found) {
        prev._debug.stale = true; prev._debug.stale_reason = reason; prev._debug.stale_at = new Date().toISOString();
        await writeFile(file, JSON.stringify(prev));
        run.stale_kept++;
      } else {
        await writeFile(file, JSON.stringify(doc || emptyDoc({ ticker: t }, [reason])));
      }
      run.failed++;
      failures.push({ ticker: t, reason });
    }
    if (++done % 100 === 0) console.log(`[batch] ${done}/${slice.length} ok=${run.succeeded} no_dcf=${run.no_dcf} fail=${run.failed} stale=${run.stale_kept}`);
  });

  const ms = Date.now() - t0;
  // rebuild index + real coverage from disk
  const ds = await buildIndexAndStats(universe);
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify({ generated_at: new Date().toISOString(), count: ds.companies.length, companies: ds.companies }, null, 2));

  const meta = {
    generated_at: new Date().toISOString(),
    universe_total: all.length,
    attempted: run.attempted,
    covered: ds.covered,
    no_dcf: ds.no_dcf,
    failed: ds.failed,
    run: { start_at: START_AT, slice: slice.length, next_cursor: START_AT + slice.length < all.length ? START_AT + slice.length : null, ...run, duration_s: +(ms / 1000).toFixed(1), avg_ms_per_company: run.attempted ? Math.round(ms / run.attempted) : null },
    failures: failures.slice(0, 100),
  };
  await writeFile(path.join(OUT, 'dcf-metadata.json'), JSON.stringify(meta, null, 2));

  console.log(`[batch] run: attempted=${run.attempted} ok=${run.succeeded} no_dcf=${run.no_dcf} fail=${run.failed} stale=${run.stale_kept} in ${meta.run.duration_s}s (avg ${meta.run.avg_ms_per_company}ms)`);
  console.log(`[batch] dataset: covered=${ds.covered} no_dcf=${ds.no_dcf} failed/missing=${ds.failed} | index.json companies=${ds.companies.length}`);
  if (meta.run.next_cursor != null) console.log(`[batch] resume next chunk with START_AT=${meta.run.next_cursor}`);
  if (run.attempted > 0 && run.succeeded + run.no_dcf === 0) { console.error('All attempted scrapes failed (likely rate-limited).'); process.exit(1); }
}

await main();
