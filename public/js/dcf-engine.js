// DCF engine — pure, dependency-free. Reproduces valueinvesting.io's valuation
// math from a scraped company doc (public/data/dcf/<TICKER>.json). Importable in
// the browser (what-if) and in Node (validation, Excel export).
//
// Methodology (reverse-engineered + validated against VI's own intermediates):
//   WACC: CAPM coe = rf + beta*ERP + risk_adj; after-tax cod = cod*(1-tax);
//         weights from D/E; computed at the build's low & high; SELECTED = midpoint.
//   DCF:  explicit FCF discounted MID-YEAR (timing 0.5,1.5,…); a NORMALIZED terminal
//         FCF/EBITDA (from the typical_* row, not the last projected year);
//         growth-exit TV = termFCF*(1+g)/(WACC-g); ebitda-exit TV = termEBITDA*mult;
//         PV(TV) discounted at the FULL exit year. EV = ΣPV(FCF)+PV(TV);
//         equity = EV - net_debt; fair = equity / shares; upside = fair/price - 1.

export const VARIANT_DEFS = {
  'dcf-growth-exit-5y': { horizon: 5, method: 'perpetuity_growth', typical: 'typical_5' },
  'dcf-growth-exit-10y': { horizon: 10, method: 'perpetuity_growth', typical: 'typical_10' },
  'dcf-ebitda-exit-5y': { horizon: 5, method: 'exit_multiple', typical: 'typical_ebitda_5' },
  'dcf-ebitda-exit-10y': { horizon: 10, method: 'exit_multiple', typical: 'typical_ebitda_10' },
};

export function cleanNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === '' || s === '-' || /^n\/?a$/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[(),%x₹$€£\s]/g, '').replace(/^-/, '');
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

// CAPM WACC build at low & high; selected = midpoint (VI's convention).
export function computeWaccBuild(doc) {
  const b = doc?.wacc?.build;
  if (!b) return { selected: doc?.wacc?.selected ?? null, source: 'scraped-only' };
  const side = (k) => {
    const rf = b.long_term_bond_rate?.[k];
    const beta = b.adjusted_beta?.[k];
    const erp = b.equity_risk_premium?.[k];
    const add = b.additional_risk_adjustment?.[k] ?? 0;
    const cod = b.cost_of_debt?.[k];
    const tax = b.tax_rate?.[k];
    const de = b.debt_equity_ratio?.[k];
    if ([rf, beta, erp, cod, tax, de].some((x) => x == null)) return null;
    const cost_of_equity = rf + beta * erp + add;
    const cost_of_debt_after_tax = cod * (1 - tax);
    const we = 1 / (1 + de);
    const wd = de / (1 + de);
    const wacc = we * cost_of_equity + wd * cost_of_debt_after_tax;
    return { rf, beta, erp, add, cost_of_equity, cost_of_debt: cod, cost_of_debt_after_tax, weight_equity: we, weight_debt: wd, tax, wacc };
  };
  const low = side('low');
  const high = side('high');
  const selected = low && high ? (low.wacc + high.wacc) / 2 : (doc?.wacc?.selected ?? null);
  return { low, high, selected, source: 'capm' };
}

// Which WACC to discount with: 'vi' (scraped selected, most precise) or 'capm' (recomputed).
function pickWacc(doc, source) {
  if (source === 'capm') {
    const b = computeWaccBuild(doc);
    return b.selected ?? doc?.wacc?.selected ?? null;
  }
  return doc?.wacc?.selected ?? computeWaccBuild(doc).selected ?? null;
}

// Compute one DCF variant. opts.waccSource: 'vi' (default) | 'capm'.
export function computeVariant(doc, variantKey, opts = {}) {
  const def = VARIANT_DEFS[variantKey];
  if (!def) return { error: `unknown variant ${variantKey}` };
  const wacc = pickWacc(doc, opts.waccSource || 'vi');
  const out = { variant: variantKey, method: def.method, horizon: def.horizon, wacc, ok: false, reasons: [] };
  if (wacc == null) { out.reasons.push('no WACC'); return out; }

  const proj = (doc.shared_projection || []).slice(0, def.horizon);
  if (proj.length < def.horizon) out.reasons.push(`only ${proj.length}/${def.horizon} projection years`);
  const projection = proj.map((p) => {
    const df = Math.pow(1 + wacc, -p.timing);
    return { year: p.year, fcf: p.fcf, timing: p.timing, discount_factor: df, pv_fcf: p.fcf != null ? p.fcf * df : null };
  });
  const sum_pv_fcf = projection.reduce((a, p) => a + (p.pv_fcf || 0), 0);

  // normalized terminal from the typical_* row: [..,EBITDA(4),..,FCF(8),exitYear(9),pvTerminal(10)]
  const typ = doc?.model_tables?.terminal?.[def.typical];
  const term_ebitda = cleanNum(typ?.[4]);
  const term_fcf = cleanNum(typ?.[8]);
  const exit_year = cleanNum(typ?.[9]) ?? def.horizon;
  const g = doc?.assumptions_raw?.avg_long_growth ?? null;
  const exit_multiple = doc?.variants?.[variantKey]?.terminal?.exit_multiple ?? null;

  let terminal_value = null;
  if (def.method === 'perpetuity_growth') {
    if (term_fcf == null) out.reasons.push('no terminal FCF');
    else if (g == null) out.reasons.push('no long-term growth');
    else if (wacc - g <= 0) out.reasons.push('WACC <= g (perpetuity undefined)');
    else terminal_value = (term_fcf * (1 + g)) / (wacc - g);
  } else {
    if (term_ebitda == null) out.reasons.push('no terminal EBITDA');
    else if (exit_multiple == null) out.reasons.push('no exit multiple');
    else terminal_value = term_ebitda * exit_multiple;
  }
  const pv_terminal = terminal_value != null ? terminal_value / Math.pow(1 + wacc, exit_year) : null;
  const enterprise_value = pv_terminal != null ? sum_pv_fcf + pv_terminal : null;
  const net_debt = doc?.net_debt ?? null;
  const equity_value = enterprise_value != null && net_debt != null ? enterprise_value - net_debt : null;
  const shares = doc?.shares_outstanding ?? null;
  const fair_value_per_share = equity_value != null && shares ? equity_value / shares : null;
  const price = doc?.price_current ?? null;
  const upside_pct = fair_value_per_share != null && price ? fair_value_per_share / price - 1 : null;

  out.ok = fair_value_per_share != null && out.reasons.length === 0;
  return {
    ...out,
    inputs: { term_fcf, term_ebitda, exit_year, growth: g, exit_multiple, net_debt, shares, price },
    projection,
    sum_pv_fcf,
    terminal_value,
    pv_terminal,
    enterprise_value,
    equity_value,
    fair_value_per_share,
    upside_pct,
  };
}

// Best-effort DDM for banks/financials. NOTE: VI's per-year DDM table is not in the
// current scrape, so this is a final-value approximation: discount the forward net
// income stream at cost of equity with a Gordon terminal (full-payout proxy).
export function computeDDM(doc) {
  const ed = doc?.assumptions_raw || {};
  const ni = ed.ddm_future_net_inc;
  const coe = ed.coe ?? doc?.wacc?.cost_of_equity_selected ?? null;
  const g = ed.avg_long_growth ?? null;
  const shares = doc?.shares_outstanding ?? null;
  const out = { ok: false, reasons: [], cost_of_equity: coe, growth: g };
  if (!Array.isArray(ni) || !ni.length) { out.reasons.push('no ddm_future_net_inc'); return out; }
  if (coe == null) { out.reasons.push('no cost of equity'); return out; }
  if (g == null || coe - g <= 0) { out.reasons.push('no usable growth'); return out; }
  if (!shares) { out.reasons.push('no shares'); return out; }
  let pv = 0;
  ni.forEach((x, i) => { pv += x / Math.pow(1 + coe, i + 1); });
  const terminal = (ni[ni.length - 1] * (1 + g)) / (coe - g);
  const pv_terminal = terminal / Math.pow(1 + coe, ni.length);
  const equity_value = pv + pv_terminal;
  const fair = equity_value / shares;
  return {
    ...out, ok: true, sum_pv: pv, terminal_value: terminal, pv_terminal,
    equity_value, fair_value_per_share: fair,
    upside_pct: doc?.price_current ? fair / doc.price_current - 1 : null,
  };
}

export function computeAll(doc, opts = {}) {
  const variants = {};
  for (const key of Object.keys(VARIANT_DEFS)) variants[key] = computeVariant(doc, key, opts);
  return { ticker: doc?.ticker ?? null, wacc_build: computeWaccBuild(doc), variants, ddm: computeDDM(doc) };
}
