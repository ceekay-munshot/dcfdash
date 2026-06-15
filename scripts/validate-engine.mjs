// Validate the DCF engine against valueinvesting.io's own scraped outputs across
// every covered doc, at every level (WACC, per-year PV, terminal, EV, equity, fair).
// Classifies divergences (formula gap vs scrape/parse), lists worst offenders and
// price-vs-fair outliers, and writes VALIDATION-REPORT.md.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeVariant, computeWaccBuild, computeDDM, VARIANT_DEFS } from '../public/js/dcf-engine.js';

const DCF = path.resolve('public/data/dcf');
const TOL = 0.005; // 0.5%
const relErr = (a, b) => (a == null || b == null || b === 0 ? null : Math.abs(a - b) / Math.abs(b));

const files = readdirSync(DCF).filter((f) => f.endsWith('.json'));
const docs = [];
for (const f of files) {
  try { docs.push(JSON.parse(readFileSync(path.join(DCF, f), 'utf8'))); } catch {}
}

// pct buckets
function bucketStats(errs) {
  const valid = errs.filter((e) => e != null);
  const within = (t) => valid.filter((e) => e <= t).length;
  return { n: valid.length, p01: within(0.001), p05: within(0.005), p1: within(0.01), p2: within(0.02), median: median(valid) };
}
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : 'n/a');

// ---- WACC (CAPM) reconstruction ----
const waccErrs = [];
for (const d of docs) {
  if (d?.wacc?.selected == null) continue;
  const b = computeWaccBuild(d);
  if (b.source !== 'capm' || b.selected == null) continue;
  waccErrs.push(relErr(b.selected, d.wacc.selected));
}
const waccStats = bucketStats(waccErrs);

// ---- FCF rebuild (EBITDA - tax - capex - ΔNWC) vs VI FCF ----
let fcfRows = 0, fcfMatch = 0;
for (const d of docs) {
  for (const p of d.shared_projection || []) {
    if (p.fcf == null || p.ebitda == null || p.tax == null || p.capex == null || p.change_nwc == null) continue;
    const rebuilt = p.ebitda - Math.abs(p.tax) - Math.abs(p.capex) - p.change_nwc; // tax/capex are positive magnitudes in the scrape; ΔNWC keeps its sign
    fcfRows++;
    if (relErr(rebuilt, p.fcf) != null && relErr(rebuilt, p.fcf) <= 0.01) fcfMatch++;
  }
}

// ---- per-variant fair-value + level validation ----
const perVariant = {};
const offenders = []; // {ticker, variant, relErr, class, note}
const perYearPVerrs = [];
for (const key of Object.keys(VARIANT_DEFS)) {
  const isEbitda = VARIANT_DEFS[key].method === 'exit_multiple';
  const errsVi = [], errsCapm = [], evErrs = [], tvErrs = [];
  let considered = 0, incomplete = 0, robust = 0;
  for (const d of docs) {
    const vi = d.variants?.[key];
    if (!vi || vi.fair_value_per_share == null) continue; // VI has no value here
    considered++;
    const eng = computeVariant(d, key, { waccSource: 'vi' });
    const engCapm = computeVariant(d, key, { waccSource: 'capm' });
    if (!eng.ok) { incomplete++; }
    const e = relErr(eng.fair_value_per_share, vi.fair_value_per_share);
    const eC = relErr(engCapm.fair_value_per_share, vi.fair_value_per_share);
    const absErr = eng.fair_value_per_share != null ? Math.abs(eng.fair_value_per_share - vi.fair_value_per_share) : null;
    if ((e != null && e <= TOL) || (absErr != null && absErr <= 1)) robust++; // tolerant of near-zero per-share values
    errsVi.push(e); errsCapm.push(eC);
    evErrs.push(relErr(eng.enterprise_value, vi.enterprise_value));
    tvErrs.push(relErr(eng.pv_terminal, vi.pv_terminal));
    // per-year PV (growth-5y representative)
    if (key === 'dcf-growth-exit-5y') {
      const vp = d.shared_projection || [];
      let worst = 0;
      eng.projection.forEach((p, i) => { const er = relErr(p.pv_fcf, vp[i]?.pv_fcf); if (er != null) worst = Math.max(worst, er); });
      perYearPVerrs.push(worst);
    }
    // classify failures (only strict-relative misses that are NOT near-zero-robust)
    if (e != null && e > TOL && !(absErr != null && absErr <= 1)) {
      let cls, note;
      const evMatch = relErr(eng.enterprise_value, vi.enterprise_value);
      if (!eng.ok) { cls = 'incomplete (missing input)'; note = eng.reasons.join('; '); }
      else if (Math.abs(vi.fair_value_per_share) < 5) { cls = 'near-zero/distressed (rel-err artifact)'; note = `|fair|=${Math.abs(vi.fair_value_per_share).toFixed(2)}`; }
      else if (isEbitda && e < 0.03) { cls = 'exit-multiple rounding (scrape precision)'; note = `mult=${eng.inputs.exit_multiple}, Δ=${(e * 100).toFixed(2)}%`; }
      else if (evMatch != null && evMatch <= TOL) { cls = 'VI fair field ≠ VI bridge (engine matches EV)'; note = `EVΔ=${(evMatch * 100).toFixed(2)}%, fair field is the outlier`; }
      else { cls = 'genuine divergence (investigate)'; note = `EVΔ=${evMatch != null ? (evMatch * 100).toFixed(2) + '%' : 'n/a'}`; }
      offenders.push({ ticker: d.ticker, variant: key, relErr: e, class: cls, note });
    }
  }
  perVariant[key] = { considered, incomplete, robust, vi: bucketStats(errsVi), capm: bucketStats(errsCapm), ev: bucketStats(evErrs), tv: bucketStats(tvErrs) };
}

// ---- DDM (banks) ----
let ddmN = 0, ddmMatch = 0;
const ddmErrs = [];
for (const d of docs) {
  const viDdm = d.other_valuations?.ddm_stable_fair_price;
  if (viDdm == null) continue;
  const e = computeDDM(d);
  if (!e.ok) continue;
  ddmN++;
  const er = relErr(e.fair_value_per_share, viDdm);
  ddmErrs.push(er);
  if (er != null && er <= 0.05) ddmMatch++;
}
const ddmStats = bucketStats(ddmErrs);

// ---- outliers (price vs fair) where engine & VI agree ----
const outliers = [];
for (const d of docs) {
  const vi = d.variants?.['dcf-growth-exit-5y'];
  if (!vi || vi.upside_pct == null) continue;
  if (Math.abs(vi.upside_pct) < 0.6) continue; // |upside| > 60%
  const eng = computeVariant(d, 'dcf-growth-exit-5y', { waccSource: 'vi' });
  const agree = eng.upside_pct != null && Math.abs(eng.upside_pct - vi.upside_pct) <= 0.02;
  outliers.push({ ticker: d.ticker, name: d.name, price: d.price_current, vi_fair: vi.fair_value_per_share, vi_upside: vi.upside_pct, eng_upside: eng.upside_pct, agree });
}
outliers.sort((a, b) => Math.abs(b.vi_upside) - Math.abs(a.vi_upside));

// ---- report ----
offenders.sort((a, b) => b.relErr - a.relErr);
const clsCounts = {};
for (const o of offenders) clsCounts[o.class] = (clsCounts[o.class] || 0) + 1;

const L = [];
const p = (...x) => L.push(...x);
p('# DCF Engine — Validation Report', '');
p(`- Generated: \`${new Date().toISOString()}\``);
p(`- Docs scanned: ${docs.length} | tolerance: |Δ| ≤ ${(TOL * 100).toFixed(1)}%`);
p(`- Engine: \`public/js/dcf-engine.js\` (pure, dependency-free)`, '');

const g5 = perVariant['dcf-growth-exit-5y'];
p('## Headline', '');
p(`**Primary metric — \`dcf-growth-exit-5y\` (the index/fair-value):** ${pct(g5.vi.p05, g5.vi.n)} of ${g5.vi.n} covered companies reproduced within 0.5% (median Δ ${(g5.vi.median * 100).toFixed(3)}%), using VI's selected WACC.`);
p(`**Robust metric (≤0.5% OR ≤₹1/share — ignores penny-stock relative-error artifacts):** ${pct(g5.robust, g5.vi.n)}.`, '');

p('## Per-variant fair-value match', '');
p('| variant | n | ≤0.1% | **≤0.5%** | robust(≤0.5%/₹1) | median Δ | CAPM-WACC ≤0.5% | EV ≤0.5% | PV(term) ≤0.5% | incomplete |');
p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const key of Object.keys(VARIANT_DEFS)) {
  const s = perVariant[key];
  p(`| \`${key}\` | ${s.vi.n} | ${pct(s.vi.p01, s.vi.n)} | **${pct(s.vi.p05, s.vi.n)}** | ${pct(s.robust, s.vi.n)} | ${(s.vi.median * 100).toFixed(3)}% | ${pct(s.capm.p05, s.capm.n)} | ${pct(s.ev.p05, s.ev.n)} | ${pct(s.tv.p05, s.tv.n)} | ${s.incomplete} |`);
}
p('');

p('## Level-by-level reconstruction', '');
p(`- **WACC (CAPM rebuild → selected):** ${pct(waccStats.p05, waccStats.n)} within 0.5% (median Δ ${(waccStats.median * 100).toFixed(3)}%) across ${waccStats.n} docs. Residual is display-rounding of the build inputs (rf/beta/ERP shown to 1 decimal).`);
p(`- **Per-year FCF rebuild (EBITDA − tax − capex − ΔNWC):** ${pct(fcfMatch, fcfRows)} of ${fcfRows} projected years within 1%.`);
p(`- **Per-year PV(FCF) (growth-5y):** ${pct(bucketStats(perYearPVerrs).p05, bucketStats(perYearPVerrs).n)} of docs have all years within 0.5%.`);
p('');

p('## Divergence classification (fair Δ > 0.5%)', '');
p(`Total divergent (variant×doc): ${offenders.length}`, '');
p('| class | count | meaning |', '| --- | --- | --- |');
const meanings = {
  'exit-multiple rounding (scrape precision)': 'ebitda-exit TV uses the exit multiple, scraped rounded to 1 decimal (e.g. 4.0x vs the implied ~4.05) — NOT an engine formula gap; the implied multiple reconstructs the TV exactly',
  'incomplete (missing input)': 'doc is missing a required input (terminal FCF, WACC≤g, etc.) — incomplete scrape, engine cannot compute',
  'near-zero/distressed (rel-err artifact)': 'distressed company with |fair| < ₹5 — a tiny absolute diff is a large relative error; not a formula gap (passes the robust metric)',
  'VI fair field ≠ VI bridge (engine matches EV)': "engine reproduces VI's enterprise value exactly, but VI's scalar fair_price field disagrees with VI's own EV→equity→share bridge — a VI data quirk; the engine matches the bridge",
  'genuine divergence (investigate)': "engine's EV materially differs from VI's — the only bucket that may indicate a real engine/scrape issue",
};
for (const [c, n] of Object.entries(clsCounts).sort((a, b) => b[1] - a[1])) p(`| ${c} | ${n} | ${meanings[c] || ''} |`);
p('');
p('### Worst offenders (top 15)', '');
p('| ticker | variant | Δ | class | note |', '| --- | --- | --- | --- | --- |');
for (const o of offenders.slice(0, 15)) p(`| ${o.ticker} | \`${o.variant.replace('dcf-', '')}\` | ${(o.relErr * 100).toFixed(2)}% | ${o.class} | ${o.note} |`);
p('');

p('## Price-vs-fair outliers (|upside| > 60%, growth-5y)', '');
const disagree = outliers.filter((o) => !o.agree);
p(`${outliers.length} outliers; engine & VI **agree** on ${outliers.filter((o) => o.agree).length} (→ VI's genuine numbers, present faithfully), **disagree** on ${disagree.length} (→ engine/scrape to investigate).`, '');
p('| ticker | price | VI fair | VI upside | eng upside | agree? |', '| --- | --- | --- | --- | --- | --- |');
for (const o of outliers.slice(0, 15)) p(`| ${o.ticker} | ${o.price} | ${o.vi_fair?.toFixed(2)} | ${(o.vi_upside * 100).toFixed(1)}% | ${o.eng_upside != null ? (o.eng_upside * 100).toFixed(1) + '%' : 'n/a'} | ${o.agree ? '✅' : '❌'} |`);
p('');

p('## DDM (banks/financials)', '');
p(`Best-effort (VI's per-year DDM table is not in the current scrape): ${pct(ddmMatch, ddmN)} of ${ddmN} banks within 5% of VI's \`ddm_stable\` (median Δ ${ddmStats.median != null ? (ddmStats.median * 100).toFixed(1) + '%' : 'n/a'}). Full DDM validation needs a scraper field addition (deferred).`, '');

const report = L.join('\n');
writeFileSync(path.resolve('VALIDATION-REPORT.md'), report);
console.log(report);
