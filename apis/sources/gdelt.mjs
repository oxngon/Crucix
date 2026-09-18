// GDELT — Global Database of Events, Language, and Tone
// No auth required. Updates every 15 minutes. Monitors news in 100+ languages.
// DOC 2.0 API: full-text search across last 3 months of global news
// GEO 2.0 API: geolocation mapping of events

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.gdeltproject.org/api/v2';

// GDELT rate limit: 1 request per 5 seconds. We now space requests much wider
// than the documented limit (15s vs 5s): the documented figure is a floor, not a
// safe rate, and this box has been served HTTP 429 on all queries with 6.5s
// spacing. Fewer requests, further apart, is the only lever we control.
const RATE_LIMIT_MS = 15_000;

// Individual GDELT requests observed at 14-25s under load. 30s per request keeps
// a slow-but-working query alive without letting one hang eat the whole budget.
const REQUEST_TIMEOUT_MS = 30_000;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// GDELT answers throttled/oversized queries with a PLAIN-TEXT nag instead of a
// JSON error, so safeFetch hands back { rawText: "Please limit requests..." }.
// Without this check the source silently reports 0 articles and looks "healthy".
function throttleMessage(res) {
  const raw = typeof res?.rawText === 'string' ? res.rawText : '';
  if (/limit requests|larger queries|too many requests/i.test(raw)) {
    return raw.slice(0, 120);
  }
  if (typeof res?.error === 'string' && /HTTP 429/.test(res.error)) {
    return res.error.slice(0, 120);
  }
  return null;
}

// Search recent global events/articles by keyword
export async function searchEvents(query = '', opts = {}) {
  const {
    mode = 'ArtList',       // ArtList, TimelineVol, TimelineVolInfo, TimelineTone, TimelineLang, TimelineSourceCountry
    maxRecords = 75,
    timespan = '24h',       // e.g. "24h", "7d", "3m"
    format = 'json',
    sortBy = 'DateDesc',    // DateDesc, DateAsc, ToneDesc, ToneAsc
  } = opts;

  // If no query, use broad geopolitical terms
  const q = query || 'conflict OR crisis OR military OR sanctions OR war OR economy';
  const params = new URLSearchParams({
    query: q,
    mode,
    maxrecords: String(maxRecords),
    timespan,
    format,
    sort: sortBy,
  });

  // retries: 0 — safeFetch's exponential backoff maxes out around 1s, which can
  // never satisfy GDELT's 5s rate limit. Retrying just burns 20s+ of our budget
  // and returns the same 429. We do our own spacing in briefing() instead.
  return safeFetch(`${BASE}/doc/doc?${params}`, { timeout: REQUEST_TIMEOUT_MS, retries: 0 });
}

// Get tone/sentiment timeline for a topic
export async function toneTrend(query, timespan = '7d') {
  const params = new URLSearchParams({
    query,
    mode: 'TimelineTone',
    timespan,
    format: 'json',
  });
  return safeFetch(`${BASE}/doc/doc?${params}`, { timeout: 45000 });
}

// Get volume timeline for a topic (how much coverage)
export async function volumeTrend(query, timespan = '7d') {
  const params = new URLSearchParams({
    query,
    mode: 'TimelineVol',
    timespan,
    format: 'json',
  });
  return safeFetch(`${BASE}/doc/doc?${params}`, { timeout: 45000 });
}

// GEO API — geographic event mapping
export async function geoEvents(query = '', opts = {}) {
  const {
    mode = 'PointData',
    timespan = '24h',
    format = 'GeoJSON',
    maxPoints = 500,
  } = opts;

  const q = query || 'conflict OR military OR protest OR explosion';
  const params = new URLSearchParams({
    query: q,
    mode,
    timespan,
    format,
    maxpoints: String(maxPoints),
  });

  return safeFetch(`${BASE}/geo/geo?${params}`, { timeout: 45000 });
}

// Compact article for briefing
function compactArticle(a) {
  return {
    title: a.title,
    url: a.url,
    date: a.seendate,
    domain: a.domain,
    language: a.language,
    country: a.sourcecountry,
  };
}

// Briefing mode — GDELT rejects multi-term OR queries with HTTP 429 ("larger
// queries"), so we issue a SINGLE-TERM query. It surfaces an error only when
// that query was throttled, so a throttle is never reported as "0 articles,
// healthy"; callers fall back to the carry-forward cache in that case.
export async function briefing() {
  // ONE term. Each request costs 14-25s, so N terms cost N sequential requests
  // against a hard 5s rate limit — every extra term both risks a 429 and eats
  // the source budget. 'conflict' is the broadest single term that still feeds
  // the conflict/crisis buckets; categorisation below splits the results into
  // the economy/health/crisis buckets by keyword, so the buckets still fill
  // from one query. Multi-term OR is not an option: GDELT rejects it outright
  // as a "larger query".
  const TERMS = ['conflict'];

  // Hard deadline: stop starting new work if we'd overrun the source budget.
  const DEADLINE_MS = 80_000;
  const startedAt = Date.now();
  const remaining = () => DEADLINE_MS - (Date.now() - startedAt);

  const seen = new Set();
  const articles = [];
  const throttled = [];
  let lastThrottle = null;

  for (let i = 0; i < TERMS.length; i++) {
    if (i > 0) {
      // Only pay the rate-limit wait if there's budget for the request after it.
      if (remaining() < RATE_LIMIT_MS + REQUEST_TIMEOUT_MS) break;
      await delay(RATE_LIMIT_MS);
    }

    const term = TERMS[i];
    const res = await searchEvents(term, { maxRecords: 75, timespan: '24h' });

    const nag = throttleMessage(res);
    if (nag) {
      lastThrottle = nag;
      throttled.push(term);
      continue;
    }

    for (const a of (res?.articles || [])) {
      if (!a?.url || seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push(compactArticle(a));
    }
  }

  // Every attempted term throttled — throw so runSource() records a real error
  // instead of silently reporting a healthy source with zero articles.
  if (articles.length === 0 && throttled.length > 0) {
    throw new Error(`GDELT throttled on all ${throttled.length} queries: ${lastThrottle || 'HTTP 429'}`);
  }

  // Sort newest-first so the merged set behaves like a single DateDesc query.
  articles.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  // Categorize by keyword matching in titles
  const categorize = (keywords) => articles.filter(a =>
    keywords.some(k => a.title?.toLowerCase().includes(k))
  );

  // Geo events — separate API, single-term, and strictly optional. Skipped
  // entirely when the article queries already consumed the budget.
  let geoPoints = [];
  if (remaining() > RATE_LIMIT_MS + REQUEST_TIMEOUT_MS) {
    await delay(RATE_LIMIT_MS);
    try {
      const geo = await geoEvents('conflict', { maxPoints: 30, timespan: '24h' });
      if (!throttleMessage(geo)) {
        geoPoints = (geo?.features || []).filter(f => f.geometry?.coordinates).map(f => ({
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          name: f.properties?.name || f.properties?.html || '',
          count: f.properties?.count || 1,
          type: f.properties?.type || 'event',
        }));
      }
    } catch (e) { /* geo endpoint optional — don't break briefing */ }
  }

  return {
    source: 'GDELT',
    timestamp: new Date().toISOString(),
    totalArticles: articles.length,
    queriedTerms: TERMS,
    throttledTerms: throttled,
    allArticles: articles,
    geoPoints,
    conflicts: categorize(['military', 'conflict', 'war', 'strike', 'missile', 'attack', 'bomb', 'troops']),
    economy: categorize(['economy', 'recession', 'inflation', 'market', 'sanctions', 'tariff', 'trade', 'gdp']),
    health: categorize(['pandemic', 'outbreak', 'epidemic', 'disease', 'virus', 'health']),
    crisis: categorize(['crisis', 'disaster', 'emergency', 'refugee', 'famine']),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('gdelt.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
