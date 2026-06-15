// One-shot CI probe to find a source for the INDIAN ticker universe.
// valueinvesting.io's sitemap is global ex-India, so we must find another source.
// Tests, in order, and REPORTS what each yields (no building yet):
//   A1. VI search/autocomplete + static prefetch assets (from typeahead.js/main.js)
//   A2. hidden India sitemaps
//   B.  NSE/BSE official lists + GitHub mirrors loading from the runner IP
// Echoes a compact report to the log + writes recon/universe-probe.json.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://valueinvesting.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function get(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return { ok: true, status: res.status, ms: Date.now() - t0, bytes: body.length, ct: res.headers.get('content-type') || '', body };
  } catch (e) { return { ok: false, error: String(e?.message || e), ms: Date.now() - t0 }; }
}

const reTk = /\b[A-Z0-9][A-Z0-9&._-]{0,14}\.(?:NS|BO)\b/g;
const indiaTokens = (s) => [...new Set((s.match(reTk) || []))];
const sample = (arr, n = 8) => arr.slice(0, n).join(', ');

const out = { generated_at: new Date().toISOString(), runner: process.env.RUNNER_OS || '?', A1_assets: [], A2_sitemaps: [], B_lists: [], notes: [] };
const log = (...a) => console.log(...a);

async function main() {
  log('===== UNIVERSE SOURCE PROBE =====');

  // ---- discover script assets from homepage ----
  const home = await get(BASE + '/');
  log(`home: ${home.status ?? home.error} (${home.bytes ?? 0}b)`);
  let scripts = [];
  if (home.ok) {
    scripts = [...new Set([...home.body.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]))];
    log(`scripts on home (${scripts.length}):`, sample(scripts.filter((s) => /typeahead|main|vendor|search|bundle/i.test(s)), 12));
    log(`home .NS/.BO tokens: ${indiaTokens(home.body).length}`, sample(indiaTokens(home.body)));
  }

  // ---- A1: read typeahead/main/search JS, hunt for the search URL it calls ----
  const jsCandidates = scripts.filter((s) => /typeahead|main|search|bundle|app/i.test(s)).map((s) => (s.startsWith('http') ? s : BASE + s));
  for (const extra of ['/static/js/typeahead.js']) if (!jsCandidates.some((u) => u.includes('typeahead'))) jsCandidates.push(BASE + extra);
  for (const js of jsCandidates.slice(0, 8)) {
    const r = await get(js);
    if (!r.ok) { log(`JS ${js}: ${r.error}`); continue; }
    // hunt for endpoint/url hints near search/typeahead/autocomplete config
    const urls = [...new Set([...r.body.matchAll(/["'`](\/[a-z0-9_\-/.]*(?:search|auto|ticker|symbol|complete|suggest|prefetch|wildcard)[a-z0-9_\-/.?=%]*)["'`]/gi)].map((m) => m[1]))];
    const kw = ['bloodhound', 'prefetch', 'remote', 'wildcard', 'typeahead', 'autocomplete', '/api/'].filter((k) => r.body.includes(k));
    log(`JS ${js.split('/').pop()} (${r.bytes}b): keywords=[${kw.join(',')}] urlHints=${sample(urls, 10)}`);
    out.notes.push({ js, kw, urlHints: urls.slice(0, 20) });
  }

  // ---- A1: battery of candidate search endpoints + static prefetch assets ----
  const apiCandidates = [
    '/api/search?q=reliance', '/api/v1/search?q=reliance', '/search?q=reliance', '/autocomplete?q=reliance',
    '/api/autocomplete?q=reliance', '/api/tickers?q=reliance', '/api/ticker/search?q=reliance', '/ticker-search?q=reliance',
    '/api/company/search?q=reliance', '/api/search/ticker?q=reliance', '/search/typeahead?q=reliance', '/api/suggest?q=reliance',
    '/typeahead?q=reliance', '/api/wildcard?q=reliance',
    '/static/data/tickers.json', '/static/js/tickers.json', '/static/data/all_tickers.json', '/static/tickers.json',
    '/tickers.json', '/static/data/search.json', '/static/data/companies.json',
  ];
  for (const c of apiCandidates) {
    const r = await get(BASE + c, { headers: { accept: 'application/json,*/*', 'x-requested-with': 'XMLHttpRequest' } });
    const toks = r.ok ? indiaTokens(r.body) : [];
    const hasReliance = r.ok && /reliance/i.test(r.body);
    const rec = { path: c, status: r.status ?? r.error, bytes: r.bytes ?? 0, ct: r.ct, india_tokens: toks.length, reliance: hasReliance, sample: sample(toks, 6), head: r.ok ? r.body.slice(0, 160).replace(/\s+/g, ' ') : null };
    out.A1_assets.push(rec);
    if (r.ok && (toks.length > 0 || hasReliance || (r.status === 200 && r.bytes > 0 && /json/i.test(r.ct)))) {
      log(`A1 HIT ${c}: ${r.status} ct=${r.ct} india=${toks.length} reliance=${hasReliance} | ${rec.head}`);
    }
  }

  // ---- A2: hidden India sitemaps ----
  for (const sm of ['/sitemap3.xml', '/sitemap-in.xml', '/sitemap-india.xml', '/sitemap_india.xml', '/sitemap-in-1.xml', '/sitemap-asia.xml', '/sitemap-NS.xml']) {
    const r = await get(BASE + sm);
    const toks = r.ok ? indiaTokens(r.body) : [];
    out.A2_sitemaps.push({ path: sm, status: r.status ?? r.error, bytes: r.bytes ?? 0, india_tokens: toks.length });
    log(`A2 ${sm}: ${r.status ?? r.error} india=${toks.length}`);
  }

  // ---- B: NSE/BSE list sources + GitHub mirrors (does it load from runner IP?) ----
  const listSources = [
    { name: 'NSE archives EQUITY_L', url: 'https://archives.nseindia.com/content/equities/EQUITY_L.csv', headers: { referer: 'https://www.nseindia.com/', accept: 'text/csv,*/*', 'accept-language': 'en-US,en;q=0.9' } },
    { name: 'NSE www1 EQUITY_L', url: 'https://www1.nseindia.com/content/equities/EQUITY_L.csv', headers: { referer: 'https://www.nseindia.com/' } },
    { name: 'BSE bhav/scrip (api)', url: 'https://api.bseindia.com/BseIndiaAPI/api/ListOfScripCSVDownload/w?segment=Equity&status=Active', headers: { referer: 'https://www.bseindia.com/' } },
    { name: 'GH mirror nse (rohitp934/.. guess)', url: 'https://raw.githubusercontent.com/rohitp934/nse-stock-symbols/main/EQUITY_L.csv' },
    { name: 'GH mirror nse (debarshee guess)', url: 'https://raw.githubusercontent.com/debarshee2004/nse_stock_list/main/EQUITY_L.csv' },
    { name: 'GH mirror nifty (datasets)', url: 'https://raw.githubusercontent.com/nemani/NSE-Stock-Symbols/master/EQUITY_L.csv' },
  ];
  for (const ls of listSources) {
    const r = await get(ls.url, { headers: ls.headers || {} });
    const lines = r.ok ? r.body.split('\n').length : 0;
    out.B_lists.push({ name: ls.name, url: ls.url, status: r.status ?? r.error, bytes: r.bytes ?? 0, lines, head: r.ok ? r.body.slice(0, 160).replace(/\s+/g, ' ') : null });
    log(`B ${ls.name}: ${r.status ?? r.error} lines=${lines} | ${r.ok ? r.body.slice(0, 90).replace(/\s+/g, ' ') : ''}`);
  }

  await mkdir(path.resolve('recon'), { recursive: true });
  await writeFile(path.resolve('recon/universe-probe.json'), JSON.stringify(out, null, 2));

  // summary
  const a1hit = out.A1_assets.filter((a) => a.india_tokens > 0 || a.reliance);
  const a2hit = out.A2_sitemaps.filter((a) => a.india_tokens > 0);
  const bhit = out.B_lists.filter((b) => b.status === 200 && b.lines > 100);
  log('\n===== SUMMARY =====');
  log(`A1 (VI search/assets) hits: ${a1hit.length} -> ${sample(a1hit.map((a) => a.path), 10)}`);
  log(`A2 (india sitemaps) hits: ${a2hit.length} -> ${sample(a2hit.map((a) => a.path), 6)}`);
  log(`B (lists loaded from runner): ${bhit.length} -> ${sample(bhit.map((b) => b.name), 6)}`);
}

await main();
