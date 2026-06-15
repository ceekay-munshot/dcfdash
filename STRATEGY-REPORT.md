# valueinvesting.io DCF — Scraper & Universe Strategy (Prompt 2)

- Generated: `2026-06-15T07:23:05.061Z` on GitHub Actions `Linux`, Node `v22.22.3`
- Scraper: `scraper/dcf-scrape.mjs` (plain `fetch()` + cheerio, no browser, no login), schema `1.0.0`
- Test tickers: `RELIANCE.NS`, `TCS.NS`, `HDFCBANK.NS`, `IDEA.NS` (normal, normal, bank, loss-maker)

## TL;DR

- **Data carrier: embedded JSON in an inline `<script>` (`window.most`)** — robust field dictionary, NOT brittle DOM scraping. We parse the blob.
- **One fetch per company** returns the **entire DCF family** (growth-exit & ebitda-exit × 5y/10y) + EPV/DDM/multiples. The "gated" 10y/ebitda *pages* (403) are redundant — their data is in the free 5y page's blob.
- **Universe: 8391 tickers** from 2 sitemap(s) — but **0 are Indian (.NS/.BO)**. The public sitemap is global **ex-India**; India needs an alternate enumeration source (see Q3). ⚠️ blocker for the India-focused universe.
- **Projected full run: ~0.02 h @ 8-way (0.17 h serial), avg 73 ms/company** → comfortably weekly.

## Q1 — Data carrier

The DCF data is **server-rendered into an inline `<script type="text/javascript">`** that assigns globals. The key carrier is `window.most` — an array of `{value_field, value_numerical, value_text}` rows (a flat field dictionary). Scalars (e.g. `fair_price_5`, `selected_wacc`, `beta`, `marketCapitalization`) are in `value_numerical`; structured tables (`excel_dict`, `terminal_to_json`, `rev_to_json`, `wacc_to_json`, `top_part`) are JSON in `value_text` (sometimes double-encoded — the parser recursively de-stringifies).
- ❌ Not `__NEXT_DATA__` / `__NUXT__` / Next-RSC / `<script type=application/json>` (the recon checked those on the *rendered* DOM and found none).
- ✅ A plain `fetch()` of the raw HTML contains the full blob — no JS execution needed. **Verdict: parse the blob (robust).** Fallback selectors are unnecessary but failure is flagged (`_debug.carrier_found=false`).

## Q2 — Free vs gated

Page-level HTTP status (anonymous, `RELIANCE.NS`):

| variant page | status |
| --- | --- |
| `dcf-growth-exit-5y` | 200 |
| `dcf-growth-exit-10y` | 403 |
| `dcf-ebitda-exit-5y` | 403 |
| `dcf-ebitda-exit-10y` | 403 |
| `intrinsic-value` | 200 |
| `fair-value` | 200 |
| `epv` | 403 |
| `ddm-stable` | 403 |
| `wacc` | 200 |
| `pe-multiples` | 200 |

**Key nuance:** even where the dedicated *page* is `403`, the **data is still delivered in the free `dcf-growth-exit-5y` page** (`fair_price_5/10`, `fair_price_dcf_ebitda_5/10`, the shared projection, and per-variant bridges `R_end_*`). So v1 can deliver **all four DCF variants** anonymously despite the page gating. EPV/DDM fair values come along too. Confirmed against the offline samples (RELIANCE 5y=694.05, 10y=928.40, ebitda5=827.72, ebitda10=1018.61).

## Q3 — Universe enumeration

- **Total tickers: 8391** (from 67099 sitemap URLs, 8563 distinct path segments).
- Sitemaps: `sitemap1.xml` (46364), `sitemap2.xml` (20735)
- By exchange suffix: `{"L":1914,"ST":586,"PA":693,"(none/US)":3417,"TO":742,"SW":238,"CN":785,"A":6,"B":5,"OL":3,"AX":1,"DE":1}`
- Sample: `1SN.L`, `24STOR.ST`, `2CRSI.PA`, `2CUREX.ST`, `2MX.PA`, `3IN.L`, `3KR.ST`, `4BB.L`, `4C.ST`, `4GBL.L`, `7DIG.L`, `888.L`
- Non-ticker segments skipped (sample): `forgot`, `ideas`, `APR.UN.TO`, `AW.UN.TO`, `BEI.UN.TO`, `BPF.UN.TO`, `BTB.UN.TO`, `CAR.UN.TO`, `CHE.UN.TO`, `CIQ.UN.TO`, `CSH.UN.TO`, `CUF.UN.TO`
- Written to `public/data/universe.json`. **Names** are not in sitemaps → backfilled from each scraped doc's `name` during the full run (Prompt 3); the 4 test docs already carry names.

> ⚠️ **CRITICAL for an India-focused product: the sitemap contains ZERO Indian (`.NS`/`.BO`) tickers.** Coverage is global *ex-India* (London/US/EU/Canada/China/…). Individual Indian pages work (all 4 test tickers 200), so India exists on the site but is **not in the public sitemap**. Options to enumerate the Indian universe in Prompt 3:
> 1. **typeahead data source** — the page loads `/static/js/typeahead.js`; inspect it for a static all-tickers JSON (may include India).
> 2. **NSE/BSE master list** — seed from the official NSE/BSE equity lists (CSV) and probe each on valueinvesting.io.
> 3. **peer-graph crawl** — each doc carries `peers` (e.g. RELIANCE→IOC.NS/BPCL.NS/HINDPETRO.NS); BFS from Indian seeds.
> 4. **hidden/region sitemaps** — probe `sitemap3.xml`, `sitemap-in.xml`, etc. not listed in the index.

## Q4 — Runtime

| ticker | http | carrier | fetch ms | wall ms | proj rows | variants ok |
| --- | --- | --- | --- | --- | --- | --- |
| RELIANCE.NS | 200 | ✅ | 42 | 84 | 10 | 4/4 |
| TCS.NS | 200 | ✅ | 39 | 60 | 10 | 4/4 |
| HDFCBANK.NS | 200 | ✅ | 86 | 98 | 0 | 4/4 |
| IDEA.NS | 200 | ✅ | 38 | 48 | 10 | 4/4 |

- Avg **73 ms/company** (fetch + parse, 1 request each).
- Full universe (8391): **0.17 h serial**, **~0.02 h @ 8-way**, **~0.01 h @ 16-way**.
- ✅ Feasible as a **weekly** GitHub Actions run. Throttle to respect rate limits (429s seen in recon under bursts) — modest concurrency + jitter + the existing retry/backoff.

## Q5 — Number formats

- `value_numerical` scalars are **clean decimals** (e.g. `selected_wacc=0.13813`, `price=1293`, `outstanding_share=13532.81`) — no parsing needed.
- Display tables use formatted strings: thousands separators (`10,756,750`), **parentheses = negative** (`(7,381,350)`), `%` ratios (`22%`), `x` multiples (`4.0x`).
- **Currency amounts are in MILLIONS** of local currency (`(INR in millions)`); per-share values (`price`, `fair_value_per_share`, `eps`) are actual units; rates stored as **decimals** (22% → `0.22`). No lakh/crore in the data (UI may localize; the blob is millions).
- `cleanNum()` normalizes commas/parens/`%`/`x`/`₹$€£` and empty→`null`; `pct()` →decimal ratio.

## Q6 — Edge cases

| ticker | type | carrier | DCF fair (5y) | DCF variants | DDM stable | behavior |
| --- | --- | --- | --- | --- | --- | --- |
| RELIANCE.NS | normal | ✅ | 694.04877 | 4/4 | 383.10965 | full DCF |
| TCS.NS | normal | ✅ | 1084.9232 | 4/4 | 979.29297 | full DCF |
| HDFCBANK.NS | bank/financial | ✅ | null | 4/4 | 336.07446 | no DCF → DDM only |
| IDEA.NS | normal | ✅ | 35.181587 | 4/4 | 13.04357 | full DCF |

- **Banks/financials** (HDFCBANK): site provides **DDM, not DCF** → DCF variants `null`, `is_financial=true` flagged, DDM captured. No crash.
- **Loss-makers** (IDEA.NS): see the row above for how the source handles it; the scraper writes `null`/stub with warnings rather than crashing.
- **Missing/unknown or gated page**: non-200 or absent `window.most` → stub doc with `_debug.carrier_found=false` + reason; never throws.

## Finalized normalized schema

Variant-agnostic; every DCF family member fits the same shape. One document per ticker at `public/data/dcf/<TICKER>.json`:

```jsonc
{
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
}
```

## Robustness — Codex P2 fixes baked in

- #3 propagate fatal failures → `process.exit(1)` when all scrapes fail (scraper CLI + orchestrator).
- #5 bounded fetch → `AbortSignal.timeout` + retry/backoff in `fetchWithRetry`.
- #6 clear stale output → `public/data/dcf` wiped before each run.
- #7 fail after push retries exhausted → workflow exits non-zero if commit-back never pushes.
- #8 per-entry isolation → each ticker parsed independently; per-variant `try/catch`; no cross-ticker signal bleed.
- #10 token-safe numbers → structured field lookup + `cleanNum()` (no substring number matching).
- #1/#2/#4 (recon trace-source / branch-order / RSC dump) → specific to the recon heuristic; N/A to a structured-blob scraper. The recon spike is superseded by this scraper for data extraction and its verdict was independently hand-verified, so these never affected it. Threads resolved with that disposition (recon spike not retrofitted).
- Plus: per-variant `try/catch`, `null`/stub on failure, and a `_debug` block in every output.
