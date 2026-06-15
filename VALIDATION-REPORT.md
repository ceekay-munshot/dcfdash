# DCF Engine — Validation Report

- Generated: `2026-06-15T09:52:17.587Z`
- Docs scanned: 2353 | tolerance: |Δ| ≤ 0.5%
- Engine: `public/js/dcf-engine.js` (pure, dependency-free)

## Headline

**Primary metric — `dcf-growth-exit-5y` (the index/fair-value):** 94.2% of 2002 covered companies reproduced within 0.5% (median Δ 0.009%), using VI's selected WACC.
**Robust metric (≤0.5% OR ≤₹1/share — ignores penny-stock relative-error artifacts):** 99.2%.

## Per-variant fair-value match

| variant | n | ≤0.1% | **≤0.5%** | robust(≤0.5%/₹1) | median Δ | CAPM-WACC ≤0.5% | EV ≤0.5% | PV(term) ≤0.5% | incomplete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dcf-growth-exit-5y` | 2002 | 83.9% | **94.2%** | 99.2% | 0.009% | 73.9% | 95.3% | 94.3% | 5 |
| `dcf-growth-exit-10y` | 2002 | 89.9% | **96.3%** | 99.3% | 0.004% | 73.5% | 96.9% | 95.2% | 5 |
| `dcf-ebitda-exit-5y` | 1983 | 47.2% | **78.1%** | 84.2% | 0.157% | 74.6% | 89.3% | 79.6% | 17 |
| `dcf-ebitda-exit-10y` | 1983 | 49.0% | **84.5%** | 88.7% | 0.121% | 73.3% | 94.7% | 79.2% | 17 |

## Level-by-level reconstruction

- **WACC (CAPM rebuild → selected):** 95.5% within 0.5% (median Δ 0.154%) across 2067 docs. Residual is display-rounding of the build inputs (rf/beta/ERP shown to 1 decimal).
- **Per-year FCF rebuild (EBITDA − tax − capex − ΔNWC):** 90.4% of 20050 projected years within 1%.
- **Per-year PV(FCF) (growth-5y):** 79.3% of docs have all years within 0.5%.

## Divergence classification (fair Δ > 0.5%)

Total divergent (variant×doc): 570

| class | count | meaning |
| --- | --- | --- |
| VI fair field ≠ VI bridge (engine matches EV) | 261 | engine reproduces VI's enterprise value exactly, but VI's scalar fair_price field disagrees with VI's own EV→equity→share bridge — a VI data quirk; the engine matches the bridge |
| exit-multiple rounding (scrape precision) | 188 | ebitda-exit TV uses the exit multiple, scraped rounded to 1 decimal (e.g. 4.0x vs the implied ~4.05) — NOT an engine formula gap; the implied multiple reconstructs the TV exactly |
| genuine divergence (investigate) | 119 | engine's EV materially differs from VI's — the only bucket that may indicate a real engine/scrape issue |
| near-zero/distressed (rel-err artifact) | 2 | distressed company with |fair| < ₹5 — a tiny absolute diff is a large relative error; not a formula gap (passes the robust metric) |

### Worst offenders (top 15)

| ticker | variant | Δ | class | note |
| --- | --- | --- | --- | --- |
| HUBTOWN.NS | `ebitda-exit-10y` | 11748.17% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| TBOTEK.NS | `ebitda-exit-10y` | 1056.78% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.20%, fair field is the outlier |
| HUBTOWN.NS | `ebitda-exit-5y` | 1042.95% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| JPOLYINVST.NS | `ebitda-exit-10y` | 304.66% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.01%, fair field is the outlier |
| LICHSGFIN.NS | `ebitda-exit-10y` | 227.64% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| LICHSGFIN.NS | `ebitda-exit-5y` | 222.61% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| SUNDARMFIN.NS | `ebitda-exit-10y` | 200.37% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.15%, fair field is the outlier |
| SUNDARMFIN.NS | `ebitda-exit-5y` | 177.80% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.19%, fair field is the outlier |
| WILLAMAGOR.NS | `ebitda-exit-10y` | 158.20% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| TARC.NS | `ebitda-exit-10y` | 134.07% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| TBOTEK.NS | `ebitda-exit-5y` | 125.26% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.19%, fair field is the outlier |
| NEXTMEDIA.NS | `growth-exit-5y` | 119.28% | genuine divergence (investigate) | EVΔ=111.52% |
| KOLTEPATIL.NS | `ebitda-exit-10y` | 116.65% | genuine divergence (investigate) | EVΔ=0.61% |
| WILLAMAGOR.NS | `ebitda-exit-5y` | 107.96% | VI fair field ≠ VI bridge (engine matches EV) | EVΔ=0.00%, fair field is the outlier |
| ROLLT.NS | `ebitda-exit-10y` | 100.02% | genuine divergence (investigate) | EVΔ=19.68% |

## Price-vs-fair outliers (|upside| > 60%, growth-5y)

759 outliers; engine & VI **agree** on 730 (→ VI's genuine numbers, present faithfully), **disagree** on 29 (→ engine/scrape to investigate).

| ticker | price | VI fair | VI upside | eng upside | agree? |
| --- | --- | --- | --- | --- | --- |
| RATNAVEER.NS | 164.31 | -401003.78 | -244153.2% | -244153.4% | ✅ |
| HUBTOWN.NS | 185.93 | -136589.02 | -73562.6% | -73562.7% | ✅ |
| ALLCARGO.NS | 8.9 | -4761.47 | -53599.6% | -53599.6% | ✅ |
| WILLAMAGOR.NS | 25.56 | -11096.62 | -43514.0% | -43508.2% | ❌ |
| MINDACORP.NS | 637.2 | -255835.73 | -40250.0% | -40250.0% | ✅ |
| MADHUCON.NS | 5.59 | -2064.10 | -37024.9% | -37027.9% | ❌ |
| RCOM.NS | 0.93 | -184.47 | -19935.7% | -19935.5% | ✅ |
| TARC.NS | 126.5 | -19031.01 | -15144.3% | -15144.3% | ✅ |
| BLBLIMITED.NS | 16.35 | -2167.62 | -13357.6% | -13357.4% | ✅ |
| VLEGOV.NS | 13.5 | -1543.29 | -11531.8% | -11531.6% | ✅ |
| PREMIER.NS | 3.01 | -327.65 | -10985.4% | -12651.2% | ❌ |
| ABAN.NS | 15.35 | -1414.24 | -9313.3% | -9314.5% | ✅ |
| MAXESTATES.NS | 431.75 | -39256.10 | -9192.3% | -9192.3% | ✅ |
| SVPGLOB.NS | 3.7 | -240.82 | -6608.8% | -6608.2% | ✅ |
| GVKPIL.NS | 2.87 | -186.58 | -6601.0% | -6601.1% | ✅ |

## DDM (banks/financials)

Best-effort (VI's per-year DDM table is not in the current scrape): 1.8% of 2063 banks within 5% of VI's `ddm_stable` (median Δ 140.5%). Full DDM validation needs a scraper field addition (deferred).
