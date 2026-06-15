# DCF Engine — Formula Spec

The exact per-cell formulas `public/js/dcf-engine.js` uses to reproduce
valueinvesting.io's valuation from a scraped doc. Prompt 9 (Excel) translates
these directly into live spreadsheet formulas. Validated against VI's own
intermediates (see `VALIDATION-REPORT.md`): growth-exit median Δ **0.009%**.

## Units & sign conventions
- Currency amounts are in **millions** of the local currency (e.g. INR mn); per-share
  values (`price`, `fair_value`) and ratios are native. `shares_outstanding` is in
  **millions of shares**, so `equity_mn / shares_mn = price per share`.
- In the scraped projection tables, **Tax and Capex are positive magnitudes**;
  **ΔNWC keeps its sign** (a negative ΔNWC = working-capital release = cash inflow).
- Rates (WACC, growth, cost of equity/debt, tax) are decimals (e.g. `0.138`).

## 1. WACC build (CAPM)
Computed at the build's **low** and **high**; the **selected = midpoint (mean)**.

```
cost_of_equity      = risk_free + beta · ERP + additional_risk_adjustment
cost_of_debt_after_tax = cost_of_debt · (1 − tax_rate)
w_equity = 1 / (1 + D/E)          w_debt = (D/E) / (1 + D/E)
WACC     = w_equity · cost_of_equity + w_debt · cost_of_debt_after_tax

WACC_selected = (WACC_low + WACC_high) / 2
```
Inputs per side from `doc.wacc.build`: `long_term_bond_rate`, `adjusted_beta`,
`equity_risk_premium`, `additional_risk_adjustment`, `cost_of_debt`, `tax_rate`,
`debt_equity_ratio` (each `{low, high}`). The DCF discounts with VI's precise
`doc.wacc.selected` when present (the recomputed midpoint matches it within
display-rounding of the inputs).

## 2. Explicit projection — discount factors & PV (MID-YEAR)
For each projected year `t = 1..N` (N = horizon, 5 or 10), with `FCF_t` from
`doc.shared_projection[t].fcf` and mid-year timing `τ_t = t − 0.5` (i.e. 0.5, 1.5, …):

```
DF_t   = (1 + WACC)^(−τ_t)
PV_t   = FCF_t · DF_t
ΣPV    = Σ_{t=1..N} PV_t
```
FCF itself reconciles as `FCF_t = EBITDA_t − Tax_t − Capex_t − ΔNWC_t`
(Tax/Capex as positive magnitudes).

## 3. Terminal value (NORMALIZED terminal year, discounted at the FULL exit year)
VI uses a **normalized** terminal cash flow (steady-state), taken from the
`typical_*` row in `doc.model_tables.terminal` — **not** the last projected year:
`typical_*[4] = terminal EBITDA`, `typical_*[8] = terminal FCF`, `typical_*[9] = exit year`.

```
Growth-exit  (perpetuity_growth):
    TV = terminal_FCF · (1 + g) / (WACC − g)          g = doc.assumptions_raw.avg_long_growth

EBITDA-exit  (exit_multiple):
    TV = terminal_EBITDA · exit_multiple              exit_multiple from doc.variants[key].terminal

PV_terminal  = TV / (1 + WACC)^(exit_year)            # full year (NOT mid-year)
```
Note: the scrape rounds `exit_multiple` to 1 decimal, which is the only source of
material error in the ebitda-exit variants; the implied (unrounded) multiple
reconstructs the terminal exactly. Growth-exit needs no multiple → matches tightest.
Guard: if `WACC − g ≤ 0` the perpetuity is undefined (distressed names) — flag, don't compute.

## 4. Bridge: EV → equity → fair value → upside
```
EnterpriseValue   = ΣPV + PV_terminal
EquityValue       = EnterpriseValue − net_debt          net_debt = doc.net_debt
FairValuePerShare = EquityValue / shares_outstanding
Upside%           = FairValuePerShare / price_current − 1
```

## 5. Variant map
| key | horizon | terminal method | typical_* row |
| --- | --- | --- | --- |
| `dcf-growth-exit-5y`  | 5  | perpetuity_growth | `typical_5` |
| `dcf-growth-exit-10y` | 10 | perpetuity_growth | `typical_10` |
| `dcf-ebitda-exit-5y`  | 5  | exit_multiple     | `typical_ebitda_5` |
| `dcf-ebitda-exit-10y` | 10 | exit_multiple     | `typical_ebitda_10` |

The 5y and 10y variants share the same 10-year FCF series; they differ only in how
many explicit years are summed (`N`) and the exit year of the terminal.

## 6. DDM (banks/financials) — APPROXIMATE / DEFERRED
VI's per-year DDM table is **not** in the current scrape, so the engine's DDM is a
best-effort final-value approximation (discount `ddm_future_net_inc` at cost of
equity with a Gordon terminal) and does **not** reproduce VI's `ddm_stable`. Full DDM
support needs one scraper field addition (the `ddm_stable_to_json` table) — deferred.

## 7. Known residual sources (NOT formula gaps)
- **Display rounding:** projection/terminal values are scraped rounded to integer
  millions and the exit multiple to 1 decimal → sub-percent residuals on most names.
- **Penny stocks:** |fair| < ₹5 → tiny absolute diffs read as large relative errors.
- **VI scalar vs bridge:** for some distressed names VI's published `fair_price_*`
  scalar disagrees with VI's own EV→equity→share bridge; the engine matches the bridge.
- **WACC − g → 0:** distressed names with growth near WACC make the Gordon terminal
  explode; VI applies special handling (the "genuine divergence" bucket).
