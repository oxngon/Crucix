/**
 * Focused test for GDELT carry-forward (apis/briefing.mjs -> applyGdeltCarryForward).
 *
 * The behaviour that matters: a throttled or failed GDELT fetch must keep
 * serving the last real payload instead of going blank, must never serve an
 * empty payload, and must always record WHY it fell back so a stale reading is
 * never mistaken for a live one.
 *
 * The cache loader is injected, so this runs without any network access.
 *
 * Run: node test/gdelt-carry-forward.mjs
 */
import { applyGdeltCarryForward } from '../apis/briefing.mjs';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const FETCHED = '2026-09-18T06:00:00.000Z';
const goodCache = { fetchedAt: FETCHED, data: { totalArticles: 75, allArticles: [{ url: 'u1' }] } };
const emptyCache = { fetchedAt: FETCHED, data: { totalArticles: 0, allArticles: [] } };
const loaderFor = (c) => () => c;

console.log('GDELT carry-forward');

// 1. skipped sweep + fresh cache -> served, counted healthy, age recorded
{
  const entry = { name: 'GDELT', status: 'skipped', data: null };
  const r = applyGdeltCarryForward(entry, loaderFor(goodCache));
  check('skipped + fresh cache -> served as ok', entry.status === 'ok' && entry.carried === true);
  check('  ...age recorded', r.carriedFrom === FETCHED);
  check('  ...no failure reason (nothing failed)', r.carryReason === null);
  check('  ...payload substituted', entry.data?.totalArticles === 75);
}

// 2. FAILED sweep (HTTP 429) + fresh cache -> served, and the reason is kept
{
  const entry = { name: 'GDELT', status: 'error', error: 'GDELT throttled on all 1 queries: HTTP 429' };
  const r = applyGdeltCarryForward(entry, loaderFor(goodCache));
  check('error + fresh cache -> served instead of blank', entry.status === 'ok' && entry.carried === true);
  check('  ...reason preserved for the dashboard', /HTTP 429/.test(r.carryReason || ''));
  check('  ...age recorded', r.carriedFrom === FETCHED);
}

// 3. FAILED sweep + no usable cache -> stays an error (never invents data)
{
  const entry = { name: 'GDELT', status: 'error', error: 'GDELT throttled: HTTP 429' };
  const r = applyGdeltCarryForward(entry, loaderFor(null));
  check('error + no cache -> stays error', entry.status === 'error');
  check('  ...nothing carried', r.carriedFrom === null && !entry.carried);
}

// 4. never serve an empty payload (the "0 articles but healthy" trap)
{
  const entry = { name: 'GDELT', status: 'error', error: 'throttled' };
  const r = applyGdeltCarryForward(entry, loaderFor(emptyCache));
  check('error + empty cached payload -> NOT served', entry.status === 'error' && r.carriedFrom === null);
}

// 5. a healthy fetch is left completely alone
{
  const entry = { name: 'GDELT', status: 'ok', data: { totalArticles: 42 } };
  const r = applyGdeltCarryForward(entry, loaderFor(goodCache));
  check('ok -> untouched', entry.status === 'ok' && !entry.carried && r.carriedFrom === null);
  check('  ...live payload kept', entry.data.totalArticles === 42);
}

// 6. skip sweep carries its own freshly-loaded cache (as fullBriefing attaches it)
{
  const entry = { name: 'GDELT', status: 'skipped', cached: goodCache };
  const r = applyGdeltCarryForward(entry, loaderFor(null)); // loader must not be needed
  check('skipped + attached cache -> served', entry.status === 'ok' && r.carriedFrom === FETCHED);
  check('  ...cache field cleaned up', entry.cached === undefined);
}

// 7. absent entry must not throw
{
  const r = applyGdeltCarryForward(undefined, loaderFor(goodCache));
  check('no GDELT entry -> no throw, no carry', r.carriedFrom === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
