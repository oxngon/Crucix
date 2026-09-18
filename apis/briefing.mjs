#!/usr/bin/env node

// Crucix Master Orchestrator — runs all intelligence sources in parallel
// Outputs structured JSON for Claude to synthesize into actionable briefing

import './utils/env.mjs'; // Load API keys from .env
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// === Tier 1: Core OSINT & Geopolitical ===
import { briefing as gdelt } from './sources/gdelt.mjs';
import { briefing as opensky } from './sources/opensky.mjs';
import { briefing as firms } from './sources/firms.mjs';
import { briefing as ships } from './sources/ships.mjs';
import { briefing as safecast } from './sources/safecast.mjs';
import { briefing as acled } from './sources/acled.mjs';
import { briefing as reliefweb } from './sources/reliefweb.mjs';
import { briefing as who } from './sources/who.mjs';
import { briefing as ofac } from './sources/ofac.mjs';
import { briefing as opensanctions } from './sources/opensanctions.mjs';
import { briefing as adsb } from './sources/adsb.mjs';

// === Tier 2: Economic & Financial ===
import { briefing as fred } from './sources/fred.mjs';
import { briefing as treasury } from './sources/treasury.mjs';
import { briefing as bls } from './sources/bls.mjs';
import { briefing as eia } from './sources/eia.mjs';
import { briefing as gscpi } from './sources/gscpi.mjs';
import { briefing as usaspending } from './sources/usaspending.mjs';
import { briefing as comtrade } from './sources/comtrade.mjs';

// === Tier 3: Weather, Environment, Technology, Social ===
import { briefing as noaa } from './sources/noaa.mjs';
import { briefing as epa } from './sources/epa.mjs';
import { briefing as patents } from './sources/patents.mjs';
import { briefing as bluesky } from './sources/bluesky.mjs';
import { briefing as reddit } from './sources/reddit.mjs';
import { briefing as telegram } from './sources/telegram.mjs';
import { briefing as kiwisdr } from './sources/kiwisdr.mjs';

// === Tier 4: Space & Satellites ===
import { briefing as space } from './sources/space.mjs';

// === Tier 5: Live Market Data ===
import { briefing as yfinance } from './sources/yfinance.mjs';

// === Tier 6: Cyber & Infrastructure ===
import { briefing as cisaKev } from './sources/cisa-kev.mjs';
import { briefing as cloudflareRadar } from './sources/cloudflare-radar.mjs';

// 45s max per individual source for normal sources. GDELT is the exception: it
// must space several requests 6.5s apart to satisfy its 1-req/5s rate limit, so
// it gets its own longer budget. Without this it times out mid-sequence and gets
// logged as a failure even though every query succeeded.
const SOURCE_TIMEOUT_MS = 45_000;
const SOURCE_TIMEOUT_OVERRIDES = { GDELT: 100_000 };

let sweepCount = 0; // Track sweeps to throttle GDELT (rate-limited free API)

// Carry-forward cache for skipped GDELT sweeps. On skip sweeps we reuse the last
// successful GDELT payload (tagged with its fetch time) so the dashboard keeps
// serving ~4.5h-old news instead of nothing, and the source counts as ok → 29/29.
// Persisted to runs/gdelt-cache.json so it survives restarts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const GDELT_CACHE_FILE = join(__dirname, '..', 'runs', 'gdelt-cache.json');
const GDELT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // refuse to serve data older than 12h

function loadGdeltCache() {
  try {
    const cached = JSON.parse(readFileSync(GDELT_CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (!cached?.data || !Number.isFinite(age) || age > GDELT_MAX_AGE_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

export async function runSource(name, fn, ...args) {
  const start = Date.now();
  const timeoutMs = SOURCE_TIMEOUT_OVERRIDES[name] ?? SOURCE_TIMEOUT_MS;
  let timer;
  try {
    const dataPromise = fn(...args);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Source ${name} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    const data = await Promise.race([dataPromise, timeoutPromise]);
    return { name, status: 'ok', durationMs: Date.now() - start, data };
  } catch (e) {
    return { name, status: 'error', durationMs: Date.now() - start, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply GDELT carry-forward to a completed source entry.
 *
 * Triggers on a SKIPPED sweep (GDELT run only every Nth sweep) and on a FAILED
 * one (GDELT answering HTTP 429 from its side). On success the entry becomes
 * status 'ok' with carried=true: counted healthy, but the topbar age tag keeps
 * it honest and the returned carryReason records why, so a stale payload is
 * never silently presented as fresh and the source is never silently blank.
 *
 * An empty payload is never served: carrying zeros forward would look like
 * working data while saying nothing.
 *
 * The cache loader is injectable so this is testable without a live sweep.
 */
export function applyGdeltCarryForward(gdeltEntry, loadCache = loadGdeltCache) {
  const result = { carriedFrom: null, carryReason: null };
  if (gdeltEntry && (gdeltEntry.status === 'skipped' || gdeltEntry.status === 'error')) {
    const failed = gdeltEntry.status === 'error';
    const cached = gdeltEntry.cached?.data ? gdeltEntry.cached : loadCache();
    if (cached?.data && (cached.data.totalArticles ?? 0) > 0) {
      gdeltEntry.status = 'ok';
      gdeltEntry.data = cached.data;
      gdeltEntry.carried = true;
      result.carriedFrom = cached.fetchedAt;
      if (failed) result.carryReason = gdeltEntry.error || 'throttled';
    }
  }
  delete gdeltEntry?.cached;
  return result;
}

export async function fullBriefing() {
  sweepCount++;
  const runGdelt = sweepCount % 4 === 1; // Run GDELT every 4 sweeps (~6h) due to rate limits
  console.error(`[Crucix] Starting intelligence sweep — 29 sources${runGdelt ? ' (GDELT enabled)' : ' (GDELT skipped)'}...`);
  const start = Date.now();

  const allPromises = [
    // Tier 1: Core OSINT & Geopolitical
    runGdelt ? runSource('GDELT', gdelt) : Promise.resolve({ name: 'GDELT', status: 'skipped', data: null, cached: loadGdeltCache() }),
    runSource('OpenSky', opensky),
    runSource('FIRMS', firms),
    runSource('Maritime', ships),
    runSource('Safecast', safecast),
    runSource('ACLED', acled),
    runSource('ReliefWeb', reliefweb),
    runSource('WHO', who),
    runSource('OFAC', ofac),
    runSource('OpenSanctions', opensanctions),
    runSource('ADS-B', adsb),

    // Tier 2: Economic & Financial
    runSource('FRED', fred, process.env.FRED_API_KEY),
    runSource('Treasury', treasury),
    runSource('BLS', bls, process.env.BLS_API_KEY),
    runSource('EIA', eia, process.env.EIA_API_KEY),
    runSource('GSCPI', gscpi),
    runSource('USAspending', usaspending),
    runSource('Comtrade', comtrade),

    // Tier 3: Weather, Environment, Technology, Social
    runSource('NOAA', noaa),
    runSource('EPA', epa),
    runSource('Patents', patents),
    runSource('Bluesky', bluesky),
    runSource('Reddit', reddit),
    runSource('Telegram', telegram),
    runSource('KiwiSDR', kiwisdr),

    // Tier 4: Space & Satellites
    runSource('Space', space),

    // Tier 5: Live Market Data
    runSource('YFinance', yfinance),

    // Tier 6: Cyber & Infrastructure
    runSource('CISA-KEV', cisaKev),
    runSource('Cloudflare-Radar', cloudflareRadar),
  ];

  // Each runSource has its own 30s timeout, so allSettled will resolve
  // within ~30s even if APIs hang. Global timeout is a safety net.
  const results = await Promise.allSettled(allPromises);

  const sources = results.map(r => r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message });

  // Carry-forward: keep serving the last real GDELT fetch rather than nothing.
  const gdeltEntry = sources.find(s => s.name === 'GDELT');
  const { carriedFrom: gdeltCarriedFrom, carryReason: gdeltCarryReason } =
    applyGdeltCarryForward(gdeltEntry);
  const totalMs = Date.now() - start;

  // Persist a fresh GDELT payload for future carry-forward. Only a payload that
  // actually contains articles: persisting an empty one overwrites good cached
  // data with zeros, and a later throttled sweep then has nothing to serve.
  if (gdeltEntry && !gdeltEntry.carried && gdeltEntry.data && (gdeltEntry.data.totalArticles ?? 0) > 0) {
    try {
      writeFileSync(GDELT_CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), data: gdeltEntry.data }));
    } catch (e) {
      console.error('[Crucix] Failed to persist GDELT cache:', e.message);
    }
  }

  const output = {
    crucix: {
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      totalDurationMs: totalMs,
      sourcesQueried: sources.length,
      sourcesOk: sources.filter(s => s.status === 'ok').length,
      // Intentionally-skipped sources (e.g. GDELT throttled to every 4th sweep)
      // are NOT failures. Counting them as such produced a permanent phantom
      // "1/29 sources failing — GDELT" alert on 3 out of every 4 sweeps.
      // Since carry-forward was added (2026-08-25), skipped sweeps serve the
      // cached GDELT payload as ok, so sourcesSkipped is normally 0.
      sourcesSkipped: sources.filter(s => s.status === 'skipped').length,
      sourcesFailed: sources.filter(s => s.status !== 'ok' && s.status !== 'skipped').length,
      ...(gdeltCarriedFrom ? { gdeltCarriedFrom } : {}),
      ...(gdeltCarryReason ? { gdeltCarryReason } : {}),
    },
    sources: Object.fromEntries(
      sources.filter(s => s.status === 'ok').map(s => [s.name, s.data])
    ),
    skipped: sources.filter(s => s.status === 'skipped').map(s => s.name),
    errors: sources
      .filter(s => s.status !== 'ok' && s.status !== 'skipped')
      .map(s => ({ name: s.name, error: s.error })),
    timing: Object.fromEntries(
      sources.map(s => [s.name, { status: s.status, ms: s.durationMs }])
    ),
  };

  console.error(`[Crucix] Sweep complete in ${totalMs}ms — ${output.crucix.sourcesOk}/${sources.length} sources returned data`);
  return output;
}

// Run and output when executed directly
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref && import.meta.url === entryHref) {
  const data = await fullBriefing();
  console.log(JSON.stringify(data, null, 2));
}
