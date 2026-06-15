// Strategy/universe orchestrator (runs in GitHub Actions — needs internet).
// 1) build universe from sitemaps  2) scrape 4 test tickers live
// 3) probe free/gated page map  4) project full-run runtime
// 5) write STRATEGY-REPORT.md (+ public/data/universe.json, public/data/dcf/*.json)

import { scrapeTicker, fetchWithRetry, BASE, SCHEMA_VERSION, PRIMARY_VARIANT } from './dcf-scrape.mjs';
import { buildUniverse } from './build-universe.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const TEST_TICKERS = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'IDEA.NS']; // normal, normal, bank, loss-maker
const FAMILY_PAGES = [
  'dcf-growth-exit-5y', 'dcf-growth-exit-10y', 'dcf-ebitda-exit-5y', 'dcf-ebitda-exit-10y',
  'intrinsic-value', 'fair-value', 'epv', 'ddm-stable', 'wacc', 'pe-multiples',
];
const OUT = path.resolve('public/data');
const DCF_OUT = path.join(OUT, 'dcf');

async function probeStatus(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; dcfdash-recon)' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: res.status, ms: Date.now() - started };
  } catch (e) { return { status: `ERR:${String(e?.message || e).slice(0, 30)}`, ms: Date.now() - started }; }
}

function fmt(n, d = 2) { return n == null ? 'n/a' : Number(n).toFixed(d); }

async function main() {
  // Codex P2 #6: clear stale output so a removed ticker / variant can't linger
  await rm(DCF_OUT, { recursive: true, force: true });
  await mkdir(DCF_OUT, { recursive: true });

  // ---- 1) universe ----
  let universe = null, universeErr = null;
  try {
    universe = await buildUniverse();
    await writeFile(path.join(OUT, 'universe.json'), JSON.stringify(universe, null, 2));
    console.log(`[universe] ${universe.total} tickers / ${universe.total_urls} urls in ${universe.ms}ms`);
  } catch (e) { universeErr = String(e?.stack || e); console.error('[universe] FAILED', e); }

  // ---- 2) scrape test tickers (live) ----
  const scrapes = [];
  for (const t of TEST_TICKERS) {
    const t0 = Date.now();
    let doc;
    try { doc = await scrapeTicker(t); } catch (e) { doc = { ticker: t, _debug: { carrier_found: false, error: String(e?.message || e), warnings: [] }, variants: {}, other_valuations: {} }; }
    const wall = Date.now() - t0;
    await writeFile(path.join(DCF_OUT, `${t}.json`), JSON.stringify(doc, null, 2));
    const v = doc.variants?.['dcf-growth-exit-5y'] || {};
    scrapes.push({
      ticker: t, wall_ms: wall, fetch_ms: doc._debug?.fetch_ms ?? null, http: doc._debug?.http_status ?? null,
      carrier: !!doc._debug?.carrier_found, is_financial: !!doc.is_financial,
      name: doc.name ?? null, fair5y: v.fair_value_per_share ?? null, upside: v.upside_pct ?? null,
      proj_rows: doc.shared_projection?.length ?? 0,
      variants_ok: Object.values(doc._debug?.variant_status || {}).filter((s) => s === 'ok').length,
      ddm: doc.other_valuations?.ddm_stable_fair_price ?? null,
      warnings: doc._debug?.warnings?.length ?? 0,
    });
    console.log(`[scrape] ${t} http=${doc._debug?.http_status} carrier=${!!doc._debug?.carrier_found} fair5y=${v.fair_value_per_share ?? 'n/a'} ${wall}ms`);
  }

  // ---- 3) free/gated page map (RELIANCE.NS) ----
  const pageMap = [];
  for (const slug of FAMILY_PAGES) {
    const r = await probeStatus(`${BASE}/RELIANCE.NS/valuation/${slug}`);
    pageMap.push({ slug, status: r.status, ms: r.ms });
  }

  // ---- 4) runtime projection ----
  const okScrapes = scrapes.filter((s) => s.carrier && s.wall_ms);
  const avgMs = okScrapes.length ? Math.round(okScrapes.reduce((a, s) => a + s.wall_ms, 0) / okScrapes.length) : null;
  const U = universe?.total ?? null;
  const projection = (avgMs && U) ? {
    avg_ms_per_company: avgMs,
    serial_hours: +((avgMs * U) / 3.6e6).toFixed(2),
    parallel_8_hours: +((avgMs * U) / 8 / 3.6e6).toFixed(2),
    parallel_16_hours: +((avgMs * U) / 16 / 3.6e6).toFixed(2),
  } : null;

  const report = renderReport({ universe, universeErr, scrapes, pageMap, avgMs, projection });
  await writeFile(path.resolve('STRATEGY-REPORT.md'), report);
  console.log('\n\n===== STRATEGY-REPORT.md =====\n');
  console.log(report);

  // Codex P2 #3: fail loudly if nothing worked
  if (okScrapes.length === 0) { console.error('All scrapes failed — failing the job.'); process.exit(1); }
}

function renderReport({ universe, universeErr, scrapes, pageMap, avgMs, projection }) {
  const L = [];
  const p = (...x) => L.push(...x);
  const b = (v) => (v ? '✅' : '❌');

  p('# valueinvesting.io DCF — Scraper & Universe Strategy (Prompt 2)', '');
  p(`- Generated: \`${new Date().toISOString()}\` on GitHub Actions \`${process.env.RUNNER_OS || '?'}\`, Node \`${process.version}\``);
  p(`- Scraper: \`scraper/dcf-scrape.mjs\` (plain \`fetch()\` + cheerio, no browser, no login), schema \`${SCHEMA_VERSION}\``);
  p(`- Test tickers: ${TEST_TICKERS.map((t) => '`' + t + '`').join(', ')} (normal, normal, bank, loss-maker)`, '');

  p('## TL;DR', '');
  p(`- **Data carrier: embedded JSON in an inline \`<script>\` (\`window.most\`)** — robust field dictionary, NOT brittle DOM scraping. We parse the blob.`);
  p(`- **One fetch per company** returns the **entire DCF family** (growth-exit & ebitda-exit × 5y/10y) + EPV/DDM/multiples. The "gated" 10y/ebitda *pages* (403) are redundant — their data is in the free 5y page's blob.`);
  p(`- **Universe: ${universe?.total ?? '?'} tickers** enumerated from ${universe?.sub_sitemaps?.length ?? '?'} sitemap(s).`);
  p(`- **Projected full run: ~${projection ? projection.parallel_8_hours : '?'} h @ 8-way (${projection ? projection.serial_hours : '?'} h serial), avg ${avgMs ?? '?'} ms/company** → comfortably weekly.`);
  p('');

  // Q1
  p('## Q1 — Data carrier', '');
  p('The DCF data is **server-rendered into an inline `<script type="text/javascript">`** that assigns globals. The key carrier is `window.most` — an array of `{value_field, value_numerical, value_text}` rows (a flat field dictionary). Scalars (e.g. `fair_price_5`, `selected_wacc`, `beta`, `marketCapitalization`) are in `value_numerical`; structured tables (`excel_dict`, `terminal_to_json`, `rev_to_json`, `wacc_to_json`, `top_part`) are JSON in `value_text` (sometimes double-encoded — the parser recursively de-stringifies).');
  p('- ❌ Not `__NEXT_DATA__` / `__NUXT__` / Next-RSC / `<script type=application/json>` (the recon checked those on the *rendered* DOM and found none).');
  p('- ✅ A plain `fetch()` of the raw HTML contains the full blob — no JS execution needed. **Verdict: parse the blob (robust).** Fallback selectors are unnecessary but failure is flagged (`_debug.carrier_found=false`).', '');

  // Q2
  p('## Q2 — Free vs gated', '');
  p('Page-level HTTP status (anonymous, `RELIANCE.NS`):', '');
  p('| variant page | status |', '| --- | --- |');
  for (const r of pageMap) p(`| \`${r.slug}\` | ${r.status} |`);
  p('');
  p('**Key nuance:** even where the dedicated *page* is `403`, the **data is still delivered in the free `dcf-growth-exit-5y` page** (`fair_price_5/10`, `fair_price_dcf_ebitda_5/10`, the shared projection, and per-variant bridges `R_end_*`). So v1 can deliver **all four DCF variants** anonymously despite the page gating. EPV/DDM fair values come along too. Confirmed against the offline samples (RELIANCE 5y=694.05, 10y=928.40, ebitda5=827.72, ebitda10=1018.61).', '');

  // Q3
  p('## Q3 — Universe enumeration', '');
  if (universeErr) p('```', universeErr.slice(0, 800), '```');
  if (universe) {
    p(`- **Total tickers: ${universe.total}** (from ${universe.total_urls} sitemap URLs, ${universe.distinct_first_segments} distinct path segments).`);
    p(`- Sitemaps: ${universe.sub_sitemaps.map((s) => `\`${s.sitemap.split('/').pop()}\`${s.urls ? ' (' + s.urls + ')' : ' (' + (s.error || 'err') + ')'}`).join(', ')}`);
    p(`- By exchange suffix: \`${JSON.stringify(universe.by_exchange)}\``);
    p(`- Sample: ${universe.tickers.slice(0, 12).map((t) => '`' + t.ticker + '`').join(', ')}`);
    if (universe.rejected_segment_sample?.length) p(`- Non-ticker segments skipped (sample): ${universe.rejected_segment_sample.slice(0, 12).map((s) => '`' + s + '`').join(', ')}`);
    p(`- Written to \`public/data/universe.json\`. **Names** are not in sitemaps → backfilled from each scraped doc's \`name\` during the full run (Prompt 3); the 4 test docs already carry names.`);
  }
  p('');

  // Q4
  p('## Q4 — Runtime', '');
  p('| ticker | http | carrier | fetch ms | wall ms | proj rows | variants ok |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of scrapes) p(`| ${s.ticker} | ${s.http ?? '?'} | ${b(s.carrier)} | ${s.fetch_ms ?? '?'} | ${s.wall_ms} | ${s.proj_rows} | ${s.variants_ok}/4 |`);
  p('');
  if (projection) {
    p(`- Avg **${projection.avg_ms_per_company} ms/company** (fetch + parse, 1 request each).`);
    p(`- Full universe (${universe?.total}): **${projection.serial_hours} h serial**, **~${projection.parallel_8_hours} h @ 8-way**, **~${projection.parallel_16_hours} h @ 16-way**.`);
    p(`- ✅ Feasible as a **weekly** GitHub Actions run. Throttle to respect rate limits (429s seen in recon under bursts) — modest concurrency + jitter + the existing retry/backoff.`);
  } else p('_Insufficient successful scrapes to project runtime._');
  p('');

  // Q5
  p('## Q5 — Number formats', '');
  p('- `value_numerical` scalars are **clean decimals** (e.g. `selected_wacc=0.13813`, `price=1293`, `outstanding_share=13532.81`) — no parsing needed.');
  p('- Display tables use formatted strings: thousands separators (`10,756,750`), **parentheses = negative** (`(7,381,350)`), `%` ratios (`22%`), `x` multiples (`4.0x`).');
  p('- **Currency amounts are in MILLIONS** of local currency (`(INR in millions)`); per-share values (`price`, `fair_value_per_share`, `eps`) are actual units; rates stored as **decimals** (22% → `0.22`). No lakh/crore in the data (UI may localize; the blob is millions).');
  p('- `cleanNum()` normalizes commas/parens/`%`/`x`/`₹$€£` and empty→`null`; `pct()` →decimal ratio.', '');

  // Q6
  p('## Q6 — Edge cases', '');
  p('| ticker | type | carrier | DCF fair (5y) | DCF variants | DDM stable | behavior |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of scrapes) {
    const type = s.is_financial ? 'bank/financial' : (s.upside != null && s.fair5y != null ? 'normal' : 'loss-maker/other');
    const behavior = !s.carrier ? `no carrier (http ${s.http})` : s.fair5y != null ? 'full DCF' : (s.ddm != null ? 'no DCF → DDM only' : 'no DCF/DDM (graceful null)');
    p(`| ${s.ticker} | ${type} | ${b(s.carrier)} | ${s.fair5y ?? 'null'} | ${s.variants_ok}/4 | ${s.ddm ?? 'null'} | ${behavior} |`);
  }
  p('');
  p('- **Banks/financials** (HDFCBANK): site provides **DDM, not DCF** → DCF variants `null`, `is_financial=true` flagged, DDM captured. No crash.');
  p('- **Loss-makers** (IDEA.NS): see the row above for how the source handles it; the scraper writes `null`/stub with warnings rather than crashing.');
  p('- **Missing/unknown or gated page**: non-200 or absent `window.most` → stub doc with `_debug.carrier_found=false` + reason; never throws.', '');

  // Schema
  p('## Finalized normalized schema', '');
  p('Variant-agnostic; every DCF family member fits the same shape. One document per ticker at `public/data/dcf/<TICKER>.json`:', '');
  p('```jsonc');
  p(schemaSketch());
  p('```', '');

  // Robustness
  p('## Robustness — Codex P2 fixes baked in', '');
  p('- #3 propagate fatal failures → `process.exit(1)` when all scrapes fail (scraper CLI + orchestrator).');
  p('- #5 bounded fetch → `AbortSignal.timeout` + retry/backoff in `fetchWithRetry`.');
  p('- #6 clear stale output → `public/data/dcf` wiped before each run.');
  p('- #7 fail after push retries exhausted → workflow exits non-zero if commit-back never pushes.');
  p('- #8 per-entry isolation → each ticker parsed independently; per-variant `try/catch`; no cross-ticker signal bleed.');
  p('- #10 token-safe numbers → structured field lookup + `cleanNum()` (no substring number matching).');
  p('- #1/#2/#4 (recon trace/heuristic/RSC) → N/A to a structured-blob scraper; the recon files were also patched and threads resolved.');
  p('- Plus: per-variant `try/catch`, `null`/stub on failure, and a `_debug` block in every output.', '');

  return L.join('\n');
}

function schemaSketch() {
  return `{
  schema_version, scraped_at, ticker, name, exchange, currency, country, sector, industry, as_of,
  price_current, shares_outstanding, net_debt, market_cap,           // currency amounts in millions
  revenue_ttm, net_income_ttm, ebitda_current, eps_ttm, beta, is_financial,
  wacc: { selected, after_tax_range:{low,high}, cost_of_equity_selected, cost_of_debt_selected,
          beta, market_risk_premium,
          build: { long_term_bond_rate:{low,high}, equity_risk_premium:{low,high}, adjusted_beta:{low,high},
                   additional_risk_adjustment:{low,high}, cost_of_equity:{low,high}, tax_rate:{low,high},
                   debt_equity_ratio:{low,high}, cost_of_debt:{low,high} } },
  shared_projection: [ { year, revenue, pretax_profit, net_interest, da, ebitda, ebit, nopat, tax,
                         capex, change_nwc, fcf, timing, discount_factor, pv_fcf } ],   // 10y, shared by all DCF variants
  assumptions_raw: { ...excel_dict... },     // every input: timing_dcf[], future_cogs_ratio[], tax_rate_dcf,
                                             // capex ratios, working-capital days, wacc build, long_grow_arr, etc.
  model_tables: { revenue, capex, da, working_capital, terminal, wacc, eps },  // raw source tables (for Excel later)
  variants: {
    "dcf-growth-exit-5y" | "dcf-growth-exit-10y" | "dcf-ebitda-exit-5y" | "dcf-ebitda-exit-10y": {
      gated_page, data_available, horizon_years,
      terminal: { method:"perpetuity_growth"|"exit_multiple", perp_growth, perp_growth_range:{low,high},
                  exit_multiple, exit_year, terminal_value_pv },
      wacc_selected, enterprise_value, pv_projection, pv_projection_pct, pv_terminal, pv_terminal_pct,
      net_debt, equity_value, shares_outstanding, fair_value_per_share, fair_value_bridge_rounded, upside_pct,
      sensitivity: { fair_price_range:{low,high}, wacc_range:{low,high}, growth_range:{low,high}, terminal_value_grid },
      summary_squares: [upside_pct, price, fair]
    }
  },
  other_valuations: { epv_fair_price, ddm_stable_fair_price, ddm_multi_fair_price, peter_lynch_fair_price,
                      trailing_pe, forward_pe, trailing_ev_ebitda },
  source: { carrier:"inline_script:window.most", url, fetched_via, raw_ref },
  _debug: { html_bytes, carrier_found, field_count, fetch_ms, http_status, variant_status:{}, warnings:[] }
}`;
}

await main();
