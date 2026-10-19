// Clef shadow — run Cloudflare's decision model next to Jev on the same state.
//
// WHY: the open question is whether Jev earns its slot, and Jev costs money
// (OpenRouter) while Clef is free inside Cloudflare's 10k neurons/day Workers
// Free allowance. An A/B on Cloudflare's published benchmarks cannot answer it —
// they publish no calibration metric, and probabilities do not transfer between
// models. So we collect the only evidence that can: our own state, our own
// questions, both models, logged side by side, tagged by model.
//
// WHAT IT DOES: nothing but call and log. It is not imported by any decision
// path; triageSignals() fires it fire-and-forget AFTER its own decision is made,
// so it cannot delay, alter, or silence an alert. Every failure returns null.
//
// Rows land in runs/clef-shadow.jsonl with the same field names as the Jev log
// (runs/jev-triage.jsonl) plus `model`, `provider`, `stateSha` and `jevOk`, so
// the two files pair up on stateSha + the signal keys for the same sweep.
//
// Kill switch: CRUCIX_CLEF_SHADOW=0. Log off: CRUCIX_CLEF_LOG=0.
// Test redirect: CRUCIX_CLEF_LOG_PATH. Model: CRUCIX_CLEF_MODEL (default clef-flash).

import { appendFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CloudflareClefProvider, clefEnabled } from '../llm/clef.mjs';

const DEFAULT_LOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../runs/clef-shadow.jsonl');

/** Stable hash of the state both models saw — the pairing key for the two logs. */
export function stateSha(state) {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

/** One shadow call. Returns the provider result, or null when disabled/unconfigured. */
export async function clefShadowDecision(state, questions, opts = {}) {
  if (!clefEnabled()) return null;
  const client = opts.client || new CloudflareClefProvider({ model: opts.model });
  if (!client.isConfigured) return null;
  return client.decide(state, questions, { timeout: opts.timeout || 15000 });
}

/** Map a provider result onto the Jev log's field names, so the files are comparable. */
export function buildEntry(state, result, meta = {}) {
  const a = result?.answers || {};
  const probs = a.tier?.probabilities || {};
  const rawTier = String(a.tier?.choice || '').toLowerCase();
  const signals = Array.isArray(meta.signals) ? meta.signals : [];
  return {
    ts: new Date().toISOString(),
    provider: 'cloudflare',
    model: result?.model || meta.model || process.env.CRUCIX_CLEF_MODEL || 'clef-flash',
    stateSha: meta.stateSha || stateSha(state),
    // Jev-side status: false means Jev could not answer this sweep (key, quota,
    // timeout) while Clef did — the case where the comparison matters most.
    jevOk: meta.jevOk !== undefined ? !!meta.jevOk : null,
    jevError: meta.jevError || null,
    ok: !!result?.ok,
    error: result?.error || null,
    shouldAlert: typeof a.should_alert?.noul === 'number' ? a.should_alert.noul >= 0.5 : null,
    pAlert: a.should_alert?.noul,
    pGenuine: a.genuine?.noul,
    pCorroborated: a.corroborated?.noul,
    rawTier,
    tierProbs: probs,
    tierConfidence: a.tier?.confidence,
    noulConfidence: a.should_alert?.confidence,
    latency: result?.latency,
    neurons: result?.neurons,
    signalCount: signals.length,
    keys: signals.map((s) => s.key).slice(0, 12),
  };
}

/** Append a row. Never throws — logging must not be able to break the alert path. */
export function logClefShadow(entry) {
  if (process.env.CRUCIX_CLEF_LOG === '0') return;
  try {
    const path = process.env.CRUCIX_CLEF_LOG_PATH || DEFAULT_LOG_PATH;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch { /* never break the alert path for a log line */ }
}

/**
 * Fire-and-forget shadow. Never throws, never awaited by the caller, and a
 * failure (including a network hang) leaves the caller's decision untouched.
 * Returns nothing by design — call `clefShadowDecision()` directly if you need
 * the result in a test.
 */
export function runClefShadow(state, questions, meta = {}) {
  try {
    Promise.resolve(clefShadowDecision(state, questions, meta))
      .then((result) => {
        if (!result) return; // disabled or unconfigured: stay silent
        logClefShadow(buildEntry(state, result, meta));
      })
      .catch(() => { /* advisory only */ });
  } catch { /* advisory only */ }
}

export default runClefShadow;