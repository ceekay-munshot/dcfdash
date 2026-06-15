// valueinvesting.io DCF recon spike.
//
// Single job: determine HOW valueinvesting.io delivers its DCF data so we can
// choose between a live-fetch Worker and a batch Playwright scrape. This script
// is meant to run inside a GitHub Actions runner (open internet, same env as a
// future production scraper). It does NOT build a scraper, engine, or UI.
//
// For each ticker on the dcf-growth-exit-5y page it:
//   (a) probes a plain fetch() with a bare UA and with a browser UA (no browser)
//   (b) loads the page in headless Chromium, capturing every network request and
//       saving JSON response bodies
//   (c) detects & dumps embedded data blobs (__NEXT_DATA__, __NUXT__, RSC, JSON)
//   (d) traces the rendered fair-value numbers to an XHR JSON body vs the initial
//       server HTML / embedded blob
//   (e) saves a full-page screenshot
//   (f) probes /robots.txt, /sitemap.xml, a search/autocomplete API, the DCF
//       variant family, and ticker-format conventions
//
// Everything lands in recon/output/.

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://valueinvesting.io';
const TICKERS = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS'];
const PRIMARY_VARIANT = 'dcf-growth-exit-5y';
const OUT = path.resolve('recon/output');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Best-effort candidate DCF variant slugs. The authoritative list is harvested
// from the on-page navigation links; these just confirm/extend it via status.
const VARIANT_CANDIDATES = [
  'dcf-growth-exit-5y',
  'dcf-growth-exit-10y',
  'dcf-growth-exit',
  'dcf-perpetuity-growth-5y',
  'dcf-perpetuity-growth-10y',
  'dcf-perpetuity-growth',
  'dcf-simple',
  'dcf-2-stage',
  'dcf-three-stage',
  'reverse-dcf',
  'earnings-power-value',
  'ddm',
  'dividend-discount',
  'dcf',
];

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return String(s).replace(/[^a-z0-9.\-_]+/gi, '_').slice(0, 120) || 'x';
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

function truncate(buf, max = 3 * 1024 * 1024) {
  if (buf.length <= max) return buf;
  return Buffer.concat([
    buf.subarray(0, max),
    Buffer.from(`\n...[truncated ${buf.length - max} bytes]`),
  ]);
}

function extractNumbers(text) {
  // Pull number-like tokens (>= 2 digits, value >= 10) so we can trace where a
  // fair-value figure originates. Strips thousands separators.
  return [
    ...new Set(
      (text.match(/\d[\d,]*\.?\d*/g) || [])
        .map((s) => s.replace(/,/g, ''))
        .filter((s) => {
          const n = parseFloat(s);
          return isFinite(n) && Math.abs(n) >= 10 && s.replace('.', '').length >= 2;
        })
    ),
  ];
}

function summarizeFetch(f) {
  if (!f) return null;
  const { _buf, ...rest } = f; // drop the raw buffer from the JSON summary
  return rest;
}

// Plain fetch() with no browser. Returns status, key CF headers, challenge
// detection, first 1KB, and the raw buffer (stripped before serialization).
async function probeFetch(url, { ua } = {}) {
  const headers = {};
  if (ua) {
    headers['user-agent'] = ua;
    headers['accept'] =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
    headers['accept-language'] = 'en-US,en;q=0.9';
  }
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const h = Object.fromEntries(res.headers.entries());
    const bodyStr = buf.toString('utf8');
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url,
      ms: Date.now() - started,
      server: h['server'] || null,
      cfMitigated: h['cf-mitigated'] || null,
      cfRay: h['cf-ray'] || null,
      contentType: h['content-type'] || null,
      bodyBytes: buf.length,
      challengeDetected:
        /Just a moment|challenge-platform|cf_chl|_cf_chl_opt|Attention Required|Enable JavaScript and cookies/i.test(
          bodyStr
        ),
      first1kb: bodyStr.slice(0, 1024),
      _buf: buf,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - started };
  }
}

// ---------- per-ticker browser recon ----------
async function reconTicker(context, ticker, allEndpoints) {
  const url = `${BASE}/${ticker}/valuation/${PRIMARY_VARIANT}`;
  const dir = path.join(OUT, slug(ticker));
  await ensureDir(path.join(dir, 'json-bodies'));

  const page = await context.newPage();
  const captured = [];
  const bodyTasks = [];
  let jsonCount = 0;
  let docStatus = null;
  const JSON_BODY_CAP = 80;

  page.on('response', (response) => {
    const req = response.request();
    const rurl = response.url();
    const status = response.status();
    let ct = '';
    try {
      ct = response.headers()['content-type'] || '';
    } catch {}
    const rtype = req.resourceType();
    const meta = {
      ticker,
      url: rurl,
      method: req.method(),
      status,
      contentType: ct,
      resourceType: rtype,
      isJSON: false,
      bodyFile: null,
      bytes: null,
    };
    if (rtype === 'document' && rurl.startsWith(`${BASE}/${ticker}`)) docStatus = status;

    const looksJson =
      ct.includes('json') || /\/api\/|graphql|\.json(\?|$)/i.test(rurl);
    if (looksJson && req.method() !== 'OPTIONS' && jsonCount < JSON_BODY_CAP) {
      meta.isJSON = true;
      bodyTasks.push(
        (async () => {
          try {
            const body = await response.body();
            meta.bytes = body.length;
            let base;
            try {
              base = new URL(rurl).pathname.split('/').filter(Boolean).join('_');
            } catch {
              base = 'url';
            }
            const fname = `${String(++jsonCount).padStart(3, '0')}_${status}_${slug(
              base || 'root'
            )}.json`;
            await writeFile(path.join(dir, 'json-bodies', fname), truncate(body));
            meta.bodyFile = path.join('json-bodies', fname);
          } catch (e) {
            meta.bodyError = String((e && e.message) || e);
          }
        })()
      );
    }
    captured.push(meta);
  });

  let navStatus = null;
  let navError = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    navStatus = resp ? resp.status() : null;
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
  } catch (e) {
    navError = String((e && e.message) || e);
  }

  // let late XHR bodies settle
  await Promise.allSettled(bodyTasks);
  await page.waitForTimeout(500);
  await Promise.allSettled(bodyTasks);

  let html = '';
  try {
    html = await page.content();
  } catch {}
  await writeFile(path.join(dir, 'rendered.html'), truncate(Buffer.from(html)));

  const nextData = await page
    .$eval('#__NEXT_DATA__', (el) => el.textContent)
    .catch(() => null);
  const nuxt = await page
    .evaluate(() => {
      try {
        return typeof window.__NUXT__ !== 'undefined' ? JSON.stringify(window.__NUXT__) : null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  const appJsonScripts = await page
    .$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent))
    .catch(() => []);
  const hasNextF = /self\.__next_f|__next_f\.push/.test(html);
  const hasNuxtData = /window\.__NUXT__/.test(html);

  if (nextData)
    await writeFile(path.join(dir, 'embedded-__NEXT_DATA__.json'), truncate(Buffer.from(nextData)));
  if (nuxt)
    await writeFile(path.join(dir, 'embedded-__NUXT__.json'), truncate(Buffer.from(nuxt)));
  if (appJsonScripts.length)
    await writeFile(
      path.join(dir, 'embedded-application-json-scripts.json'),
      truncate(Buffer.from(JSON.stringify(appJsonScripts, null, 2)))
    );

  const pageText = await page
    .evaluate(() => (document.body ? document.body.innerText : ''))
    .catch(() => '');
  await writeFile(path.join(dir, 'page-text.txt'), Buffer.from(pageText));

  await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});

  // harvest valuation/DCF links from the DOM (authoritative variant routes)
  const links = await page
    .$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')))
    .catch(() => []);
  const valuationLinks = [
    ...new Set(
      (links || []).filter(
        (h) => h && /valuation|dcf|dividend-discount|earnings-power|ddm/i.test(h)
      )
    ),
  ];

  // paywall / auth signals
  const paywallRe =
    /\b(subscribe|subscription|upgrade to|premium|unlock|sign in to|log ?in to|members? only|paid plan|free trial|paywall|become a member|pro plan)\b/i;
  const paywallHits = [
    ...new Set(pageText.split('\n').map((l) => l.trim()).filter((l) => l && paywallRe.test(l))),
  ].slice(0, 25);

  // fair-value lines + numbers for tracing
  const fvLines = pageText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /(fair value|intrinsic value|dcf value|target price|upside|margin of safety|present value|enterprise value)/i.test(l))
    .slice(0, 40);
  const fvNumbers = extractNumbers(fvLines.join('\n')).slice(0, 40);

  await page.close().catch(() => {});
  allEndpoints.push(...captured);

  return {
    ticker,
    url,
    navStatus,
    navError,
    docStatus,
    endpointsCount: captured.length,
    jsonEndpoints: captured.filter((c) => c.isJSON),
    distinctHosts: [...new Set(captured.map((c) => {
      try { return new URL(c.url).host; } catch { return '?'; }
    }))],
    embedded: {
      hasNextData: !!nextData,
      hasNuxt: !!nuxt || hasNuxtData,
      hasNextF,
      appJsonScriptsCount: appJsonScripts.length,
    },
    valuationLinks,
    paywallHits,
    fvLines,
    fvNumbers,
    pageTextLen: pageText.length,
    renderedHtmlLen: html.length,
  };
}

// trace fair-value numbers across the artifacts we saved for a ticker
async function traceNumbers(dir, numbers) {
  const result = { numbersTested: numbers.length, inJsonXHR: [], inInitialHtml: [], inEmbeddedBlob: [] };
  let jsonText = '';
  try {
    const files = await readdir(path.join(dir, 'json-bodies'));
    for (const f of files) jsonText += '\n' + (await readFile(path.join(dir, 'json-bodies', f), 'utf8'));
  } catch {}
  let initialHtml = '';
  try {
    initialHtml = await readFile(path.join(dir, 'plain-fetch-browserUA.html'), 'utf8');
  } catch {}
  let embedded = '';
  for (const f of [
    'embedded-__NEXT_DATA__.json',
    'embedded-__NUXT__.json',
    'embedded-application-json-scripts.json',
  ]) {
    try {
      embedded += '\n' + (await readFile(path.join(dir, f), 'utf8'));
    } catch {}
  }
  for (const n of numbers) {
    if (jsonText.includes(n)) result.inJsonXHR.push(n);
    if (initialHtml.includes(n)) result.inInitialHtml.push(n);
    if (embedded.includes(n)) result.inEmbeddedBlob.push(n);
  }
  return result;
}

// ---------- infra probes ----------
async function probeInfra(context) {
  const out = {};
  for (const p of ['/robots.txt', '/sitemap.xml']) {
    try {
      const r = await context.request.get(`${BASE}${p}`, { timeout: 30000 });
      const body = await r.body();
      out[p] = {
        status: r.status(),
        bytes: body.length,
        contentType: r.headers()['content-type'] || null,
        head: body.toString('utf8').slice(0, 600),
      };
      await writeFile(path.join(OUT, slug(p.slice(1)) || 'root'), truncate(body, 2 * 1024 * 1024));
    } catch (e) {
      out[p] = { error: String((e && e.message) || e) };
    }
  }
  return out;
}

async function probeVariants(context, ticker) {
  const results = {};
  for (const v of VARIANT_CANDIDATES) {
    const u = `${BASE}/${ticker}/valuation/${v}`;
    try {
      const r = await context.request.get(u, { timeout: 30000, maxRedirects: 5 });
      results[v] = r.status();
    } catch (e) {
      results[v] = `ERR: ${String((e && e.message) || e)}`;
    }
  }
  return results;
}

async function probeTickerFormats(context) {
  const formats = ['RELIANCE.NS', 'RELIANCE.BO', 'RELIANCE', '500325.BO', 'TCS.BO', 'INFY.NS'];
  const out = {};
  for (const t of formats) {
    const u = `${BASE}/${t}/valuation/${PRIMARY_VARIANT}`;
    try {
      const r = await context.request.get(u, { timeout: 30000 });
      out[t] = r.status();
    } catch (e) {
      out[t] = `ERR: ${String((e && e.message) || e)}`;
    }
  }
  return out;
}

async function probeSearch(context) {
  const page = await context.newPage();
  const xhrs = [];
  page.on('response', (resp) => {
    const u = resp.url();
    let ct = '';
    try {
      ct = resp.headers()['content-type'] || '';
    } catch {}
    if (
      /search|autocomplete|suggest|typeahead|lookup|symbols?|tickers?|companies/i.test(u) &&
      /\/api\/|graphql|json/i.test(u + ct)
    ) {
      xhrs.push({ url: u, status: resp.status(), contentType: ct });
    }
  });
  let homeStatus = null;
  try {
    const r = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    homeStatus = r ? r.status() : null;
    await page.waitForTimeout(3000);
    const sel = [
      'input[type=search]',
      'input[placeholder*="earch" i]',
      'input[name*="search" i]',
      'input[aria-label*="search" i]',
      'input[type=text]',
      'input',
    ].join(',');
    const input = await page.$(sel);
    if (input) {
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.type('RELI', { delay: 140 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
  } catch {}
  await page.close().catch(() => {});
  return {
    homeStatus,
    searchEndpoints: [...new Map(xhrs.map((x) => [x.url, x])).values()],
  };
}

// ---------- report ----------
function b(v) {
  return v ? '✅ yes' : '❌ no';
}

function renderReport(r) {
  const L = [];
  const p = (...x) => L.push(...x);

  // compute summary flags
  let anyJson = false,
    dcfInXHR = false,
    dcfInHtmlOrBlob = false,
    headless200 = false,
    fetchBrowserUA200 = false,
    fetchBareUA200 = false,
    challenge = false,
    paywall = false;
  for (const t of TICKERS) {
    const tr = r.tickers[t] || {};
    if ((tr.jsonEndpoints || []).some((e) => e.status >= 200 && e.status < 300)) anyJson = true;
    if (tr.trace) {
      if ((tr.trace.inJsonXHR || []).length) dcfInXHR = true;
      if ((tr.trace.inInitialHtml || []).length || (tr.trace.inEmbeddedBlob || []).length)
        dcfInHtmlOrBlob = true;
    }
    if (tr.docStatus >= 200 && tr.docStatus < 300) headless200 = true;
    const fm = (r.fetchMatrix || {})[t] || {};
    if (fm.browserUA) {
      if (fm.browserUA.status >= 200 && fm.browserUA.status < 300 && !fm.browserUA.challengeDetected)
        fetchBrowserUA200 = true;
      if (fm.browserUA.challengeDetected) challenge = true;
    }
    if (fm.bareUA && fm.bareUA.status >= 200 && fm.bareUA.status < 300 && !fm.bareUA.challengeDetected)
      fetchBareUA200 = true;
    if ((tr.paywallHits || []).length) paywall = true;
  }

  // recommendation
  let rec, recWhy;
  if (anyJson && dcfInXHR && fetchBrowserUA200) {
    rec = 'LIVE WORKER (Cloudflare Worker calling the JSON API)';
    recWhy =
      'A JSON endpoint carries the DCF numbers and a plain fetch() from the runner returned 200 without a challenge.';
  } else if (!fetchBrowserUA200 && headless200) {
    rec = 'BATCH PLAYWRIGHT (GitHub Actions + headless Chromium)';
    recWhy =
      'Plain fetch() was blocked/challenged but headless Chromium rendered the page — a real browser is required.';
  } else if (dcfInHtmlOrBlob && !dcfInXHR) {
    rec = 'BATCH PLAYWRIGHT or HTML/blob parse';
    recWhy =
      'DCF numbers are server-rendered into the HTML / embedded blob rather than a clean XHR JSON API.';
  } else if (anyJson && dcfInXHR && !fetchBrowserUA200 && headless200) {
    rec = 'BATCH PLAYWRIGHT (API exists but is browser-gated)';
    recWhy =
      'A JSON API carries the data but plain fetch() is blocked; drive it through a real browser, or replay the XHR with full browser headers/cookies.';
  } else {
    rec = 'INCONCLUSIVE — see details below';
    recWhy = 'The automated trace was not decisive; inspect the saved bodies/HTML manually.';
  }

  p(`# valueinvesting.io DCF — Recon Spike Report`, '');
  p(`- Generated: \`${r.startedAt}\` → \`${r.finishedAt}\``);
  p(`- Runner: GitHub Actions \`${process.env.RUNNER_OS || '?'}\`, Node \`${r.env.node}\``);
  p(`- Base: ${r.base}`);
  p(`- Primary page tested: \`/{TICKER}/valuation/${r.primaryVariant}\``);
  p(`- Tickers: ${TICKERS.map((t) => '`' + t + '`').join(', ')}`);
  if (r.fatalError) p('', `> ⚠️ FATAL ERROR during run:`, '```', r.fatalError, '```');
  p('');

  p(`## TL;DR — Recommendation: ${rec}`, '');
  p(recWhy, '');
  p('| Signal | Result |', '| --- | --- |');
  p(`| JSON API endpoint(s) present | ${b(anyJson)} |`);
  p(`| DCF numbers traced to an XHR JSON body | ${b(dcfInXHR)} |`);
  p(`| DCF numbers in initial HTML / embedded blob | ${b(dcfInHtmlOrBlob)} |`);
  p(`| Plain \`fetch()\` (browser UA) returned 200 | ${b(fetchBrowserUA200)} |`);
  p(`| Plain \`fetch()\` (bare UA) returned 200 | ${b(fetchBareUA200)} |`);
  p(`| Headless Chromium rendered page (2xx) | ${b(headless200)} |`);
  p(`| Cloudflare / bot challenge seen on fetch | ${b(challenge)} |`);
  p(`| Paywall / login wording on page | ${b(paywall)} |`);
  p('');

  // Q2 — runner IP blocking / fetch matrix
  p(`## Q2 — Runner-IP blocking (fetch vs headless)`, '');
  p('| Ticker | fetch bareUA | fetch browserUA | headless doc status | notes |');
  p('| --- | --- | --- | --- | --- |');
  for (const t of TICKERS) {
    const fm = (r.fetchMatrix || {})[t] || {};
    const bare = fm.bareUA || {};
    const dressed = fm.browserUA || {};
    const tr = r.tickers[t] || {};
    const notes = [];
    if (dressed.cfRay || bare.cfRay) notes.push('cf-ray seen');
    if (dressed.challengeDetected || bare.challengeDetected) notes.push('challenge body');
    if (dressed.cfMitigated || bare.cfMitigated) notes.push('cf-mitigated=' + (dressed.cfMitigated || bare.cfMitigated));
    if (dressed.server) notes.push('server=' + dressed.server);
    p(
      `| ${t} | ${bare.status ?? bare.error ?? '-'} | ${dressed.status ?? dressed.error ?? '-'} | ${
        tr.docStatus ?? tr.navError ?? '-'
      } | ${notes.join('; ') || ''} |`
    );
  }
  p('');

  // Q1 — API vs HTML
  p(`## Q1 — API vs HTML (where does the DCF data live?)`, '');
  for (const t of TICKERS) {
    const tr = r.tickers[t] || {};
    p(`### ${t}`);
    if (tr.error) {
      p('', '```', tr.error, '```', '');
      continue;
    }
    p(`- Total network responses captured: **${tr.endpointsCount ?? '?'}**`);
    p(`- JSON-ish responses: **${(tr.jsonEndpoints || []).length}**`);
    p(
      `- Embedded blobs: __NEXT_DATA__ ${b(tr.embedded?.hasNextData)}, __NUXT__ ${b(
        tr.embedded?.hasNuxt
      )}, Next RSC (\`__next_f\`) ${b(tr.embedded?.hasNextF)}, \`<script type=application/json>\` × ${
        tr.embedded?.appJsonScriptsCount ?? 0
      }`
    );
    if (tr.trace) {
      p(
        `- Fair-value trace (${tr.trace.numbersTested} numbers): in XHR JSON → **${tr.trace.inJsonXHR.length}**, in initial server HTML → **${tr.trace.inInitialHtml.length}**, in embedded blob → **${tr.trace.inEmbeddedBlob.length}**`
      );
      if (tr.trace.inJsonXHR.length)
        p(`  - sample numbers found in XHR JSON: ${tr.trace.inJsonXHR.slice(0, 8).join(', ')}`);
    }
    const jsonEps = (tr.jsonEndpoints || []).slice(0, 25);
    if (jsonEps.length) {
      p('', '| method | status | bytes | content-type | url | saved |', '| --- | --- | --- | --- | --- | --- |');
      for (const e of jsonEps) {
        p(
          `| ${e.method} | ${e.status} | ${e.bytes ?? '-'} | ${e.contentType || ''} | ${e.url} | ${
            e.bodyFile ? '`' + e.bodyFile + '`' : e.bodyError ? 'err' : '-'
          } |`
        );
      }
    } else {
      p('', '_No JSON-ish responses captured._');
    }
    p('');
  }

  // Q3 — auth/paywall
  p(`## Q3 — Auth / paywall (anonymous visibility)`, '');
  p(`This run is fully anonymous (no login), so everything captured IS the public view.`, '');
  for (const t of TICKERS) {
    const tr = r.tickers[t] || {};
    p(`- **${t}**: page text length ${tr.pageTextLen ?? 0} chars; paywall/login wording: ${
      (tr.paywallHits || []).length ? '`' + (tr.paywallHits || []).slice(0, 6).join(' | ') + '`' : 'none detected'
    }`);
    if (tr.fvLines && tr.fvLines.length)
      p(`  - fair-value-related lines seen: \`${tr.fvLines.slice(0, 4).join(' | ')}\``);
  }
  p('');

  // Q4 — DCF family
  p(`## Q4 — DCF variant family & routes`, '');
  p(`Route pattern: \`${r.base}/{TICKER}/valuation/{VARIANT}\``, '');
  p(`**Variant slug probe (RELIANCE.NS, HTTP status):**`, '');
  p('| variant slug | status |', '| --- | --- |');
  for (const [v, s] of Object.entries(r.variants || {})) p(`| \`${v}\` | ${s} |`);
  p('');
  const allLinks = [...new Set(TICKERS.flatMap((t) => (r.tickers[t]?.valuationLinks) || []))];
  p(`**Valuation/DCF links harvested from page navigation (${allLinks.length}):**`, '');
  if (allLinks.length) for (const l of allLinks.slice(0, 60)) p(`- \`${l}\``);
  else p('_none harvested (page may have been blocked)_');
  p('');

  // Q5 — universe enumeration
  p(`## Q5 — Universe enumeration`, '');
  for (const [p2, v] of Object.entries(r.infra || {})) {
    if (v.error) p(`- \`${p2}\`: ERROR ${v.error}`);
    else p(`- \`${p2}\`: status ${v.status}, ${v.bytes} bytes, ct=${v.contentType}`);
    if (v.head) p('  - head:', '  ```', ...v.head.split('\n').slice(0, 12).map((x) => '  ' + x), '  ```');
  }
  p('');
  p(`**Search / autocomplete probe** (home status ${r.search?.homeStatus ?? '?'}):`, '');
  const se = r.search?.searchEndpoints || [];
  if (se.length) {
    p('| status | content-type | url |', '| --- | --- | --- |');
    for (const s of se) p(`| ${s.status} | ${s.contentType} | ${s.url} |`);
  } else {
    p('_No search/autocomplete XHR observed (selector may not have matched; inspect home page manually)._');
  }
  p('');

  // Q6 — ticker format
  p(`## Q6 — Ticker format convention`, '');
  p('| ticker tried | status |', '| --- | --- |');
  for (const [t, s] of Object.entries(r.tickerFormats || {})) p(`| \`${t}\` | ${s} |`);
  p('');

  p(`## Artifacts`, '');
  p('- `recon/output/network-endpoints.json` — every captured response (all tickers)');
  p('- `recon/output/recon-data.json` — full structured findings');
  p('- `recon/output/<TICKER>/json-bodies/` — saved JSON response bodies');
  p('- `recon/output/<TICKER>/rendered.html`, `page-text.txt`, `screenshot.png`');
  p('- `recon/output/<TICKER>/embedded-*.json` — embedded data blobs (if any)');
  p('- `recon/output/<TICKER>/plain-fetch-*.html` — raw no-browser fetch bodies');
  p('- `recon/output/robots.txt`, `recon/output/sitemap.xml`');
  p('');

  return L.join('\n');
}

// ---------- main ----------
async function main() {
  await ensureDir(OUT);
  const report = {
    startedAt: new Date().toISOString(),
    base: BASE,
    primaryVariant: PRIMARY_VARIANT,
    env: { node: process.version, runnerOs: process.env.RUNNER_OS || null },
    tickers: {},
    fetchMatrix: {},
    variants: {},
    tickerFormats: {},
    infra: {},
    search: {},
  };
  const allEndpoints = [];
  let browser;

  try {
    // (a) plain fetch matrix — no browser
    console.log('=== STEP A: plain fetch() matrix (no browser) ===');
    for (const t of TICKERS) {
      const url = `${BASE}/${t}/valuation/${PRIMARY_VARIANT}`;
      const dir = path.join(OUT, slug(t));
      await ensureDir(dir);
      const bare = await probeFetch(url, {});
      const dressed = await probeFetch(url, { ua: CHROME_UA });
      if (bare._buf) await writeFile(path.join(dir, 'plain-fetch-bareUA.html'), truncate(bare._buf));
      if (dressed._buf)
        await writeFile(path.join(dir, 'plain-fetch-browserUA.html'), truncate(dressed._buf));
      report.fetchMatrix[t] = { bareUA: summarizeFetch(bare), browserUA: summarizeFetch(dressed) };
      console.log(
        `[fetch][${t}] bareUA=${bare.status ?? bare.error}  browserUA=${dressed.status ?? dressed.error}  challenge=${
          dressed.challengeDetected
        }  server=${dressed.server}`
      );
      console.log(`[fetch][${t}] first 1KB (browserUA):\n${(dressed.first1kb || '').slice(0, 1024)}\n---`);
    }

    // (b)-(e) headless Chromium recon
    console.log('=== STEP B-E: headless Chromium recon ===');
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent: CHROME_UA,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
    });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {}
    });

    for (const t of TICKERS) {
      try {
        report.tickers[t] = await reconTicker(context, t, allEndpoints);
        console.log(
          `[browser][${t}] docStatus=${report.tickers[t].docStatus} responses=${report.tickers[t].endpointsCount} json=${report.tickers[t].jsonEndpoints.length}`
        );
      } catch (e) {
        report.tickers[t] = { error: String((e && e.stack) || e) };
        console.error(`[browser][${t}] ERROR`, e);
      }
    }

    // (d) trace fair-value numbers
    for (const t of TICKERS) {
      const tr = report.tickers[t];
      if (tr && tr.fvNumbers && tr.fvNumbers.length) {
        tr.trace = await traceNumbers(path.join(OUT, slug(t)), tr.fvNumbers);
        console.log(
          `[trace][${t}] tested=${tr.trace.numbersTested} inXHR=${tr.trace.inJsonXHR.length} inHTML=${tr.trace.inInitialHtml.length} inBlob=${tr.trace.inEmbeddedBlob.length}`
        );
      }
    }

    // (f) infra / variants / formats / search probes
    console.log('=== STEP F: infra/variant/format/search probes ===');
    report.variants = await probeVariants(context, 'RELIANCE.NS');
    report.tickerFormats = await probeTickerFormats(context);
    report.infra = await probeInfra(context);
    report.search = await probeSearch(context);

    await context.close().catch(() => {});
  } catch (e) {
    report.fatalError = String((e && e.stack) || e);
    console.error('FATAL', e);
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    report.finishedAt = new Date().toISOString();
    await ensureDir(OUT);
    await writeFile(path.join(OUT, 'network-endpoints.json'), JSON.stringify(allEndpoints, null, 2));
    await writeFile(path.join(OUT, 'recon-data.json'), JSON.stringify(report, null, 2));
    const md = renderReport(report);
    await writeFile(path.join(OUT, 'RECON-REPORT.md'), md);
    console.log('\n\n===== RECON-REPORT.md =====\n');
    console.log(md);
  }
}

await main();
process.exit(0);
