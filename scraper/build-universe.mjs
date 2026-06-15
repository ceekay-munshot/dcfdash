// Enumerate the full covered universe from valueinvesting.io sitemaps.
// sitemap.xml is a sitemap index -> sitemap1.xml, sitemap2.xml (and maybe more).
// Writes public/data/universe.json = { total, tickers:[{ticker,url}] }.
// Names are backfilled from scraped docs later (sitemaps carry URLs only).
//
// Usage: node scraper/build-universe.mjs   (live; needs internet — runs in CI)

import { fetchWithRetry } from './dcf-scrape.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SITEMAP_INDEX = 'https://valueinvesting.io/sitemap.xml';

const NON_TICKER = new Set([
  'docs', 'screener', 'stock-screener', 'watchlist', 'all-watchlists', 'charts', 'gurus',
  'filings', 'filings-search', 'discover', 'blog', 'about', 'pricing', 'api', 'login',
  'register', 'terms', 'privacy', 'sitemap', 'static', 'contact', 'compare', 'news',
  'markets', 'market', 'search', 'home', 'faq', 'help', 'careers', 'press', 'index',
]);

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);

// first path segment after the host, decoded
function firstSegment(u) {
  const m = u.match(/^https?:\/\/[^/]+\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

// Heuristic: a ticker is SYMBOL or SYMBOL.EXCHANGE (e.g. RELIANCE.NS, 500325.BO, 5020.T, AAPL)
function looksLikeTicker(seg) {
  if (!seg || NON_TICKER.has(seg.toLowerCase())) return false;
  if (seg.length > 20) return false;
  if (/\s/.test(seg)) return false;
  // with exchange suffix (has a dot) OR a bare alphanumeric symbol up to 7 chars
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,14}\.[A-Za-z]{1,4}$/.test(seg)) return true; // RELIANCE.NS, 5020.T
  if (/^[A-Z0-9]{1,7}$/.test(seg)) return true; // AAPL, MSFT (bare US)
  return false;
}

export async function buildUniverse({ limit = Infinity } = {}) {
  const t0 = Date.now();
  const idx = await fetchWithRetry(SITEMAP_INDEX);
  let subs = locs(idx.body).filter((u) => /\.xml(\?|$)/i.test(u) && u !== SITEMAP_INDEX);
  // if the index itself already lists company URLs (not nested sitemaps), treat it as a leaf
  const allUrls = [];
  const subStats = [];
  if (subs.length === 0) {
    allUrls.push(...locs(idx.body));
    subStats.push({ sitemap: SITEMAP_INDEX, urls: allUrls.length, ms: idx.ms });
  } else {
    for (const sm of subs) {
      try {
        const r = await fetchWithRetry(sm);
        const ls = locs(r.body);
        allUrls.push(...ls);
        subStats.push({ sitemap: sm, urls: ls.length, ms: r.ms });
      } catch (e) {
        subStats.push({ sitemap: sm, error: String(e?.message || e) });
      }
    }
  }

  const segCounts = new Map();
  for (const u of allUrls) {
    const seg = firstSegment(u);
    if (seg) segCounts.set(seg, (segCounts.get(seg) || 0) + 1);
  }
  const tickers = new Map();
  const rejectedSample = [];
  for (const [seg] of segCounts) {
    if (looksLikeTicker(seg)) {
      if (!tickers.has(seg)) tickers.set(seg, { ticker: seg, name: null, url: `https://valueinvesting.io/${seg}` });
    } else if (rejectedSample.length < 40 && !NON_TICKER.has(seg.toLowerCase())) {
      rejectedSample.push(seg);
    }
  }
  const list = [...tickers.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const exchanges = {};
  for (const t of list) { const ex = t.ticker.includes('.') ? t.ticker.split('.').pop() : '(none/US)'; exchanges[ex] = (exchanges[ex] || 0) + 1; }

  return {
    generated_at: new Date().toISOString(),
    source: SITEMAP_INDEX,
    sub_sitemaps: subStats,
    total_urls: allUrls.length,
    distinct_first_segments: segCounts.size,
    total: list.length,
    by_exchange: exchanges,
    rejected_segment_sample: rejectedSample,
    ms: Date.now() - t0,
    tickers: list.slice(0, limit),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const u = await buildUniverse();
  const outDir = path.resolve('public/data');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'universe.json'), JSON.stringify(u, null, 2));
  console.log(`universe: ${u.total} tickers from ${u.total_urls} URLs across ${u.sub_sitemaps.length} sitemap(s) in ${u.ms}ms`);
  console.log('by exchange:', JSON.stringify(u.by_exchange));
  if (u.total === 0) { console.error('No tickers enumerated — check sitemap structure.'); process.exit(1); }
}
