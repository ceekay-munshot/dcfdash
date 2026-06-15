# valueinvesting.io DCF — Recon Spike Report

- Generated: `2026-06-15T05:54:52.513Z` → `2026-06-15T05:55:26.623Z`
- Runner: GitHub Actions `Linux`, Node `v22.22.3`
- Base: https://valueinvesting.io
- Primary page tested: `/{TICKER}/valuation/dcf-growth-exit-5y`
- Tickers: `RELIANCE.NS`, `TCS.NS`, `HDFCBANK.NS`

## TL;DR — Recommendation: BATCH PLAYWRIGHT or HTML/blob parse

DCF numbers are server-rendered into the HTML / embedded blob rather than a clean XHR JSON API.

| Signal | Result |
| --- | --- |
| JSON API endpoint(s) present | ✅ yes |
| DCF numbers traced to an XHR JSON body | ❌ no |
| DCF numbers in initial HTML / embedded blob | ✅ yes |
| Plain `fetch()` (browser UA) returned 200 | ✅ yes |
| Plain `fetch()` (bare UA) returned 200 | ✅ yes |
| Headless Chromium rendered page (2xx) | ✅ yes |
| Cloudflare / bot challenge seen on fetch | ❌ no |
| Paywall / login wording on page | ✅ yes |

## Q2 — Runner-IP blocking (fetch vs headless)

| Ticker | fetch bareUA | fetch browserUA | headless doc status | notes |
| --- | --- | --- | --- | --- |
| RELIANCE.NS | 200 | 200 | 200 | cf-ray seen; server=cloudflare |
| TCS.NS | 200 | 200 | 200 | cf-ray seen; server=cloudflare |
| HDFCBANK.NS | 200 | 200 | 200 | cf-ray seen; server=cloudflare |

## Q1 — API vs HTML (where does the DCF data live?)

### RELIANCE.NS
- Total network responses captured: **92**
- JSON-ish responses: **9**
- Embedded blobs: __NEXT_DATA__ ❌ no, __NUXT__ ❌ no, Next RSC (`__next_f`) ❌ no, `<script type=application/json>` × 0
- Fair-value trace (5 numbers): in XHR JSON → **0**, in initial server HTML → **4**, in embedded blob → **0**

| method | status | bytes | content-type | url | saved |
| --- | --- | --- | --- | --- | --- |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/001_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/002_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/003_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 18178 | application/json; charset=UTF-8 | https://ep1.adtrafficquality.google/getconfig/sodar?sv=200&tid=gda&tv=r20260611&st=env&sjk=5093050466953611 | `json-bodies/004_200_getconfig_sodar.json` |
| GET | 200 | 11596 | application/json | https://embed.tawk.to/_s/v4/app/6a2a73cfdc0/languages/en.json | `json-bodies/005_200__s_v4_app_6a2a73cfdc0_languages_en.json.json` |
| GET | 200 | 10839 | application/json | https://embed.tawk.to/_s/v4/app/6a2a73cfdc0/languages/en_dev.json | `json-bodies/006_200__s_v4_app_6a2a73cfdc0_languages_en_dev.json.json` |
| GET | 200 | 2953 | application/json | https://va.tawk.to/v1/widget-settings?propertyId=611c4284d6e7610a49b0ad9d&widgetId=1fdb67lcq&sv=null | `json-bodies/007_200_v1_widget-settings.json` |
| POST | 200 | 1044 | application/json | https://va.tawk.to/v1/session/start | `json-bodies/008_200_v1_session_start.json` |
| POST | 200 | 156 | application/json;charset=utf-8 | https://m.stripe.com/6 | `json-bodies/009_200_6.json` |

### TCS.NS
- Total network responses captured: **91**
- JSON-ish responses: **9**
- Embedded blobs: __NEXT_DATA__ ❌ no, __NUXT__ ❌ no, Next RSC (`__next_f`) ❌ no, `<script type=application/json>` × 0
- Fair-value trace (5 numbers): in XHR JSON → **0**, in initial server HTML → **4**, in embedded blob → **0**

| method | status | bytes | content-type | url | saved |
| --- | --- | --- | --- | --- | --- |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/001_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/002_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/003_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 17958 | application/json; charset=UTF-8 | https://ep1.adtrafficquality.google/getconfig/sodar?sv=200&tid=gda&tv=r20260611&st=env&sjk=969487616648880 | `json-bodies/004_200_getconfig_sodar.json` |
| GET | 200 | 2953 | application/json | https://va.tawk.to/v1/widget-settings?propertyId=611c4284d6e7610a49b0ad9d&widgetId=1fdb67lcq&sv=null | `json-bodies/005_200_v1_widget-settings.json` |
| GET | 200 | 11596 | application/json | https://embed.tawk.to/_s/v4/app/6a2a73cfdc0/languages/en.json | `json-bodies/006_200__s_v4_app_6a2a73cfdc0_languages_en.json.json` |
| GET | 200 | 10839 | application/json | https://embed.tawk.to/_s/v4/app/6a2a73cfdc0/languages/en_dev.json | `json-bodies/007_200__s_v4_app_6a2a73cfdc0_languages_en_dev.json.json` |
| POST | 200 | 605 | application/json | https://va.tawk.to/v1/session/start | `json-bodies/008_200_v1_session_start.json` |
| POST | 200 | 156 | application/json;charset=utf-8 | https://m.stripe.com/6 | `json-bodies/009_200_6.json` |

### HDFCBANK.NS
- Total network responses captured: **92**
- JSON-ish responses: **9**
- Embedded blobs: __NEXT_DATA__ ❌ no, __NUXT__ ❌ no, Next RSC (`__next_f`) ❌ no, `<script type=application/json>` × 0

| method | status | bytes | content-type | url | saved |
| --- | --- | --- | --- | --- | --- |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/001_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/002_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 474 | application/json | https://js.stripe.com/v3/.deploy_status_henson.json | `json-bodies/003_200_v3_.deploy_status_henson.json.json` |
| GET | 200 | 18046 | application/json; charset=UTF-8 | https://ep1.adtrafficquality.google/getconfig/sodar?sv=200&tid=gda&tv=r20260611&st=env&sjk=3933928160664238 | `json-bodies/004_200_getconfig_sodar.json` |
| GET | 200 | 2953 | application/json | https://va.tawk.to/v1/widget-settings?propertyId=611c4284d6e7610a49b0ad9d&widgetId=1fdb67lcq&sv=null | `json-bodies/005_200_v1_widget-settings.json` |
| GET | 200 | 11596 | application/json | https://embed.tawk.to/_s/v4/app/6a2a73cfdc0/languages/en.json | `json-bodies/006_200__s_v4_app_6a2a73cfdc0_languages_en.json.json` |
| GET | 200 | 10839 | application/json | https://embed.tawk.to/_s/v4/app/6a2a73cfdc0/languages/en_dev.json | `json-bodies/007_200__s_v4_app_6a2a73cfdc0_languages_en_dev.json.json` |
| POST | 200 | 605 | application/json | https://va.tawk.to/v1/session/start | `json-bodies/008_200_v1_session_start.json` |
| POST | 200 | 156 | application/json;charset=utf-8 | https://m.stripe.com/6 | `json-bodies/009_200_6.json` |

## Q3 — Auth / paywall (anonymous visibility)

This run is fully anonymous (no login), so everything captured IS the public view.

- **RELIANCE.NS**: page text length 2384 chars; paywall/login wording: none detected
  - fair-value-related lines seen: `Peter Lynch Fair Value | Upside | The Discounted Cash Flow (DCF) valuation of Reliance Industries Ltd (RELIANCE.NS) is 694.05 INR. With the latest stock price at 1,293.00 INR, the upside of Reliance Industries Ltd based on DCF is -46.3%. | Upside	-56.2% - -31.4%	-46.3%`
- **TCS.NS**: page text length 2269 chars; paywall/login wording: none detected
  - fair-value-related lines seen: `Peter Lynch Fair Value | Upside | The Discounted Cash Flow (DCF) valuation of Tata Consultancy Services Ltd (TCS.NS) is 1,084.92 INR. With the latest stock price at 2,161.40 INR, the upside of Tata Consultancy Services Ltd based on DCF is -49.8%. | Upside	-56.6% - -39.7%	-49.8%`
- **HDFCBANK.NS**: page text length 2785 chars; paywall/login wording: `Equity market risk premium	8.3%	9.3% | The Cost of Equity reflects the return a company needs to deliver to shareholders to justify the risk of investing in its shares. It’s computed using the Capital Asset Pricing Model (CAPM), which blends the risk-free rate, the stock’s beta, and the market risk premium.`
  - fair-value-related lines seen: `Peter Lynch Fair Value`

## Q4 — DCF variant family & routes

Route pattern: `https://valueinvesting.io/{TICKER}/valuation/{VARIANT}`

**Variant slug probe (RELIANCE.NS, HTTP status):**

| variant slug | status |
| --- | --- |
| `dcf-growth-exit-5y` | 200 |
| `dcf-growth-exit-10y` | 403 |
| `dcf-growth-exit` | 200 |
| `dcf-perpetuity-growth-5y` | 200 |
| `dcf-perpetuity-growth-10y` | 200 |
| `dcf-perpetuity-growth` | 200 |
| `dcf-simple` | 200 |
| `dcf-2-stage` | 200 |
| `dcf-three-stage` | 200 |
| `reverse-dcf` | 200 |
| `earnings-power-value` | 200 |
| `ddm` | 200 |
| `dividend-discount` | 403 |
| `dcf` | 200 |

**Valuation/DCF links harvested from page navigation (46):**

- `/RELIANCE.NS/valuation/dcf-growth-exit-5y`
- `/RELIANCE.NS/valuation/intrinsic-value`
- `/RELIANCE.NS/valuation/pe-multiples`
- `/RELIANCE.NS/valuation/fair-value`
- `/RELIANCE.NS/valuation/epv`
- `/RELIANCE.NS/valuation/ddm-stable`
- `/RELIANCE.NS/valuation/wacc`
- `/IOC.NS/valuation/dcf-growth-exit-5y`
- `/5020.T/valuation/dcf-growth-exit-5y`
- `/BPCL.NS/valuation/dcf-growth-exit-5y`
- `/5019.T/valuation/dcf-growth-exit-5y`
- `/HINDPETRO.NS/valuation/dcf-growth-exit-5y`
- `/5021.T/valuation/dcf-growth-exit-5y`
- `/RELIANCE.NS/valuation/dcf-growth-exit-10y`
- `/RELIANCE.NS/valuation/dcf-ebitda-exit-5y`
- `/RELIANCE.NS/valuation/dcf-ebitda-exit-10y`
- `/TCS.NS/valuation/dcf-growth-exit-5y`
- `/TCS.NS/valuation/intrinsic-value`
- `/TCS.NS/valuation/pe-multiples`
- `/TCS.NS/valuation/fair-value`
- `/TCS.NS/valuation/epv`
- `/TCS.NS/valuation/ddm-stable`
- `/TCS.NS/valuation/wacc`
- `/INFY.NS/valuation/dcf-growth-exit-5y`
- `/WIPRO.NS/valuation/dcf-growth-exit-5y`
- `/TECHM.NS/valuation/dcf-growth-exit-5y`
- `/PERSISTENT.NS/valuation/dcf-growth-exit-5y`
- `/LTI.NS/valuation/dcf-growth-exit-5y`
- `/MINDTREE.NS/valuation/dcf-growth-exit-5y`
- `/TCS.NS/valuation/dcf-growth-exit-10y`
- `/TCS.NS/valuation/dcf-ebitda-exit-5y`
- `/TCS.NS/valuation/dcf-ebitda-exit-10y`
- `/HDFCBANK.NS/valuation/wacc`
- `/HDFCBANK.NS/valuation/intrinsic-value`
- `/HDFCBANK.NS/valuation/pe-multiples`
- `/HDFCBANK.NS/valuation/fair-value`
- `/HDFCBANK.NS/valuation/ddm-stable`
- `/ICICIBANK.NS/valuation/wacc`
- `/SBIN.NS/valuation/wacc`
- `/KOTAKBANK.NS/valuation/wacc`
- `/AXISBANK.NS/valuation/wacc`
- `/BANKBARODA.NS/valuation/wacc`
- `/PNB.NS/valuation/wacc`
- `/BANKINDIA.NS/valuation/wacc`
- `/INDUSINDBK.NS/valuation/wacc`
- `/SOUTHBANK.NS/valuation/wacc`

## Q5 — Universe enumeration

- `/robots.txt`: status 200, 607 bytes, ct=text/plain; charset=utf-8
  - head:
  ```
  User-agent: Googlebot
  Disallow: /*epv$
  Disallow: /*dcf-ebitda-exit-5y$
  Disallow: /*dcf-ebitda-exit-10y$
  Disallow: /*dcf-growth-exit-10y$
  Disallow: /*ddm-stable$
  Disallow: /*ddm-growth$
  Disallow: /*overview$
  Disallow: /*financials$
  Disallow: /*compare$
  Disallow: /*historical-price$
  Disallow: /*insider-transaction$
  ```
- `/sitemap.xml`: status 200, 295 bytes, ct=text/xml; charset=utf-8
  - head:
  ```
  <?xml version="1.0" encoding="UTF-8"?>
  <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap>
          <loc>https://valueinvesting.io/sitemap1.xml</loc>
      </sitemap>
      <sitemap>
          <loc>https://valueinvesting.io/sitemap2.xml</loc>
      </sitemap>
  </sitemapindex>
  ```

**Search / autocomplete probe** (home status 200):

_No search/autocomplete XHR observed (selector may not have matched; inspect home page manually)._

## Q6 — Ticker format convention

| ticker tried | status |
| --- | --- |
| `RELIANCE.NS` | 200 |
| `RELIANCE.BO` | 200 |
| `RELIANCE` | 200 |
| `500325.BO` | 200 |
| `TCS.BO` | 429 |
| `INFY.NS` | 429 |

## Artifacts

- `recon/output/network-endpoints.json` — every captured response (all tickers)
- `recon/output/recon-data.json` — full structured findings
- `recon/output/<TICKER>/json-bodies/` — saved JSON response bodies
- `recon/output/<TICKER>/rendered.html`, `page-text.txt`, `screenshot.png`
- `recon/output/<TICKER>/embedded-*.json` — embedded data blobs (if any)
- `recon/output/<TICKER>/plain-fetch-*.html` — raw no-browser fetch bodies
- `recon/output/robots.txt`, `recon/output/sitemap.xml`
