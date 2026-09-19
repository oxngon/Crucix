// Yahoo Finance — Live market quotes (no API key required)
// Provides real-time prices for stocks, ETFs, crypto, commodities
// Replaces the need for Alpaca or any paid market data provider

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, '..', '..', 'runs', 'yfinance-cache.json');

// How long a live quote may be carried forward after a partial fetch failure.
// Deliberately spans a weekend + market holiday: a Friday close IS the last
// known-good live price on a Saturday, so reusing it is correct, not a bug.
const MAX_CARRY_AGE_MS = 96 * 60 * 60 * 1000;

// Symbols to track — covers broad market, rates, commodities, crypto, volatility
const SYMBOLS = {
  // Indexes / ETFs
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq Composite',
  '^DJI': 'Dow Jones',
  '^RUT': 'Russell 2000',
  // Rates / Credit
  TLT: '20Y+ Treasury',
  HYG: 'High Yield Corp',
  LQD: 'IG Corporate',
  // Commodities
  'GC=F': 'Gold',
  'SI=F': 'Silver',
  'CL=F': 'WTI Crude',
  'BZ=F': 'Brent Crude',
  'NG=F': 'Natural Gas',
  // Crypto
  'BTC-USD': 'Bitcoin',
  'ETH-USD': 'Ethereum',
  // Volatility
  '^VIX': 'VIX',
};

async function fetchQuote(symbol) {
  try {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
    const data = await safeFetch(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta || {};
    const quotes = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const timestamps = result.timestamp || [];

    // Get current price and previous close
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2];
    const change = price && prevClose ? price - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    // Build 5-day history
    const history = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) {
        history.push({
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          close: Math.round(closes[i] * 100) / 100,
        });
      }
    }

    return {
      symbol,
      name: SYMBOLS[symbol] || meta.shortName || symbol,
      price: Math.round(price * 100) / 100,
      prevClose: Math.round((prevClose || 0) * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      marketState: meta.marketState || 'UNKNOWN',
      history,
    };
  } catch (e) {
    return { symbol, name: SYMBOLS[symbol] || symbol, error: e.message };
  }
}

// ─── Carry-forward cache ─────────────────────────────────────────────────────
// Yahoo occasionally fails per-symbol under a parallel burst (the failure comes
// back as `quotes['unknown'] = {error:'fetch failed'}`, or the symbol is simply
// absent). Without this, a single failed symbol silently keeps whatever the
// source module last emitted — for commodities that is the days-old official
// EIA spot print, which then sits beside a live neighbour and fabricates a move
// (real case: live WTI $96.08 shown with stale Brent $130.80 → a fake +31.7%
// "Brent escalated" and a $34.72 phantom spread that drove a whole trade thesis).
//
// We persist every successfully-fetched quote and, on failure, reuse the last
// known-good one — tagged with the time it was actually fetched, so the vintage
// is visible downstream instead of being passed off as current.
// Mirrors the GDELT carry-forward pattern in apis/briefing.mjs.
function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    return parsed?.symbols || {};
  } catch (e) {
    console.error('[Crucix] Failed to read Yahoo cache:', e.message);
    return {};
  }
}

function persistCache(symbols) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), symbols }));
  } catch (e) {
    console.error('[Crucix] Failed to persist Yahoo cache:', e.message);
  }
}

export async function briefing() {
  return collect();
}

export async function collect() {
  const symbols = Object.keys(SYMBOLS);
  const results = await Promise.allSettled(
    symbols.map(s => fetchQuote(s))
  );

  const cache = loadCache();
  const quotes = {};
  const carried = [];
  const missing = [];
  let ok = 0;

  for (let i = 0; i < results.length; i++) {
    const sym = symbols[i];                       // index-aligned — do NOT trust q.symbol:
    const r = results[i];                         // a failed fetch returns bare null, which
    const q = r.status === 'fulfilled' ? r.value : null;  // would lose the identity entirely

    if (q && !q.error && q.price != null) {
      quotes[sym] = q;
      ok++;
      continue;
    }

    // Reuse the last known-good live quote if it is still recent enough.
    const cached = cache[sym];
    if (cached?.quote?.price != null) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age <= MAX_CARRY_AGE_MS) {
        quotes[sym] = {
          ...cached.quote,
          carriedForward: true,
          carriedFrom: cached.fetchedAt,
        };
        carried.push({ symbol: sym, carriedFrom: cached.fetchedAt, ageMs: age });
        continue;
      }
    }

    missing.push(sym);
    quotes[sym] = q || { symbol: sym, error: 'fetch failed' };
  }

  // Refresh the cache with this sweep's live quotes. Entries that were carried
  // keep their ORIGINAL fetchedAt, so their age keeps growing and a persistent
  // failure eventually expires instead of being carried forever.
  const nextSymbols = { ...cache };
  const fetchedAt = new Date().toISOString();
  for (const [sym, q] of Object.entries(quotes)) {
    if (!q.error && !q.carriedForward && q.price != null) {
      nextSymbols[sym] = { fetchedAt, quote: q };
    }
  }
  // Drop entries for symbols that no longer exist in SYMBOLS.
  for (const sym of Object.keys(nextSymbols)) {
    if (!symbols.includes(sym)) delete nextSymbols[sym];
  }
  persistCache(nextSymbols);

  // Categorize for easy dashboard consumption
  return {
    quotes,
    summary: {
      totalSymbols: symbols.length,
      ok,
      carried: carried.length,
      failed: missing.length,
      carriedSymbols: carried.map(c => c.symbol),
      missingSymbols: missing,
      timestamp: fetchedAt,
    },
    indexes: pickGroup(quotes, ['^GSPC', '^IXIC', '^DJI', '^RUT']),
    rates: pickGroup(quotes, ['TLT', 'HYG', 'LQD']),
    commodities: pickGroup(quotes, ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'NG=F']),
    crypto: pickGroup(quotes, ['BTC-USD', 'ETH-USD']),
    volatility: pickGroup(quotes, ['^VIX']),
  };
}

function pickGroup(quotes, symbols) {
  return symbols.map(s => quotes[s]).filter(Boolean);
}
