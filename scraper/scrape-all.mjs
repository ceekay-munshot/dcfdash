// Resumable batch runner: scrape every ticker in public/data/universe.json into
// public/data/dcf/<TICKER>.json, and write a run summary to dcf-metadata.json.
//
// Resumable / chunkable via env:
//   START_AT (default 0), MAX_COMPANIES (default all),
//   CONCURRENCY (default 4), DELAY_MS (default 200, polite jitter to avoid 429s).
//
// Resilience: per-company isolation, fetch retry+backoff+timeout (in the reader),
// keep the previous good file + mark it stale on failure (never overwrite good
// data with a stub), skip-and-log no-DCF names, full _debug in every doc.

import { scrapeTicker, emptyDoc } from './dcf-scrape.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('public/data');
const DCF = path.join(OUT, 'dcf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

async function pool(items, n, fn) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  }));
}

async function main() {
  const universe = await readJson(path.join(OUT, 'universe.json'));
  if (!universe || !Array.isArray(universe.tickers) || !universe.tickers.length) {
    console.error('public/data/universe.json missing or empty — run build-universe.mjs first');
    process.exit(1);
  }
  const START_AT = Number(process.env.START_AT || 0);
  const MAX = Number(process.env.MAX_COMPANIES || Infinity);
  const CONC = Number(process.env.CONCURRENCY || 4);
  const DELAY = Number(process.env.DELAY_MS || 200);
  const all = universe.tickers;
  const slice = all.slice(START_AT, isFinite(MAX) ? START_AT + MAX : undefined);
  await mkdir(DCF, { recursive: true });
  console.log(`[batch] universe=${all.length} slice=[${START_AT}..${START_AT + slice.length}) conc=${CONC} delay=${DELAY}ms`);

  const counts = { attempted: 0, succeeded: 0, no_dcf: 0, failed: 0, stale_kept: 0 };
  const failures = [];
  const noDcf = [];
  let done = 0;
  const t0 = Date.now();

  await pool(slice, CONC, async (entry) => {
    await sleep(jitter(DELAY));
    counts.attempted++;
    const t = entry.ticker;
    const file = path.join(DCF, `${t}.json`);
    let doc = null, err = null;
    try { doc = await scrapeTicker(t); } catch (e) { err = String(e?.message || e); }

    if (doc && doc._debug?.carrier_found) {
      doc.name = doc.name || entry.name || null;
      doc.sector = doc.sector || entry.sector || null;
      const hasDcf = Object.values(doc._debug.variant_status || {}).some((s) => s === 'ok');
      await writeFile(file, JSON.stringify(doc, null, 2));
      if (hasDcf) counts.succeeded++;
      else { counts.no_dcf++; noDcf.push(t); }
    } else {
      const reason = err || doc?._debug?.error || doc?._debug?.warnings?.[0] || 'no carrier';
      const prev = await readJson(file);
      if (prev && prev._debug?.carrier_found) {
        // keep previous good data; mark stale rather than clobbering with a stub
        prev._debug.stale = true;
        prev._debug.stale_reason = reason;
        prev._debug.stale_at = new Date().toISOString();
        await writeFile(file, JSON.stringify(prev, null, 2));
        counts.stale_kept++;
      } else {
        await writeFile(file, JSON.stringify(doc || emptyDoc({ ticker: t }, [reason]), null, 2));
      }
      counts.failed++;
      failures.push({ ticker: t, reason });
    }
    if (++done % 100 === 0) console.log(`[batch] ${done}/${slice.length} ok=${counts.succeeded} no_dcf=${counts.no_dcf} fail=${counts.failed} stale=${counts.stale_kept}`);
  });

  const ms = Date.now() - t0;
  const meta = {
    generated_at: new Date().toISOString(),
    universe_total: all.length,
    start_at: START_AT,
    slice: slice.length,
    next_cursor: START_AT + slice.length < all.length ? START_AT + slice.length : null,
    ...counts,
    avg_ms_per_company: counts.attempted ? Math.round(ms / counts.attempted) : null,
    duration_s: +(ms / 1000).toFixed(1),
    failures: failures.slice(0, 100),
    no_dcf_sample: noDcf.slice(0, 50),
  };
  await writeFile(path.join(OUT, 'dcf-metadata.json'), JSON.stringify(meta, null, 2));
  console.log(`[batch] DONE attempted=${counts.attempted} ok=${counts.succeeded} no_dcf=${counts.no_dcf} failed=${counts.failed} stale_kept=${counts.stale_kept} in ${meta.duration_s}s (avg ${meta.avg_ms_per_company}ms)`);
  if (meta.next_cursor != null) console.log(`[batch] resume next chunk with START_AT=${meta.next_cursor}`);

  // fail loudly only if nothing at all succeeded
  if (counts.attempted > 0 && counts.succeeded + counts.no_dcf === 0) {
    console.error('All attempted scrapes failed.');
    process.exit(1);
  }
}

await main();
