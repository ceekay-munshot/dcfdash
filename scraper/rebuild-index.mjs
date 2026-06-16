// Rebuild public/data/index.json from the docs already on disk — no scraping.
// Use after changing index logic (e.g. adding DDM-covered banks) to republish
// the search index without a full re-scrape. The weekly batch run does the same
// rebuild at the end, so this just brings the committed index forward.
//
//   node scraper/rebuild-index.mjs
import { buildIndexAndStats } from './scrape-all.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('public/data');
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

const universe = await readJson(path.join(OUT, 'universe.json'));
if (!universe || !Array.isArray(universe.tickers)) { console.error('universe.json missing'); process.exit(1); }

const ds = await buildIndexAndStats(universe);
const now = new Date().toISOString();
await writeFile(path.join(OUT, 'index.json'), JSON.stringify({ generated_at: now, count: ds.companies.length, companies: ds.companies }, null, 2));

// merge fresh coverage into existing metadata, preserving the last run's details
const meta = (await readJson(path.join(OUT, 'dcf-metadata.json'))) || {};
meta.generated_at = now;
meta.covered = ds.covered;
meta.ddm_covered = ds.ddm_covered;
meta.no_dcf = ds.no_dcf;
meta.failed = ds.failed;
meta.missing = ds.missing;
meta.stale = ds.stale;
meta.reindexed_at = now;
await writeFile(path.join(OUT, 'dcf-metadata.json'), JSON.stringify(meta, null, 2));

console.log(`[reindex] index.json companies=${ds.companies.length} (dcf=${ds.covered} ddm=${ds.ddm_covered}) no_dcf=${ds.no_dcf} failed=${ds.failed} missing=${ds.missing} stale=${ds.stale}`);
