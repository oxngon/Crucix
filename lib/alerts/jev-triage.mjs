// Jev triage — structured alert decisions via TypeSafe Jev.
//
// Replaces the fragile "ask a chat model for JSON, then JSON.parse it" step in
// the alert path with a typed decision. The output space is declared up front,
// so the model cannot emit a malformed tier or invent a field:
//
//   noul   should_alert -> P(interrupt the operator now)
//   choice tier         -> flash | priority | routine
//   noul   genuine      -> P(real change, not routine noise)
//
// FAIL-SAFE CONTRACT: this module is advisory. If Jev is unconfigured,
// unreachable, slow, or returns something unusable, triageSignals() returns
// null and the caller keeps its existing behaviour (LLM eval -> rules). Jev can
// never silence an alert by failing, and never fabricates a verdict.
//
// Enable/disable with CRUCIX_JEV_TRIAGE=0 (default: enabled when a key exists).

import { TypesafeJevProvider } from '../llm/typesafe.mjs';

// Tier keys must match TIER_CONFIG in the alerters.
const TIER_CRITERIA = {
  flash: 'Immediate, high-consequence, likely to move markets or indicate escalation. Interrupt now.',
  priority: 'Meaningful and actionable but not an emergency. Surface soon.',
  routine: 'Worth logging and mentioning later; not worth interrupting anyone.',
};

function resolveKey(opts = {}) {
  if (opts.apiKey) return opts.apiKey;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  // Crucix's LLM_API_KEY is an OpenRouter key when its provider is openrouter.
  if ((process.env.LLM_PROVIDER || '').toLowerCase() === 'openrouter' && process.env.LLM_API_KEY) {
    return process.env.LLM_API_KEY;
  }
  return null;
}

function compactSignals(signals) {
  return signals.slice(0, 12).map((s) => ({
    key: s.key,
    label: s.label || undefined,
    severity: s.severity,
    direction: s.direction,
    text: s.text ? String(s.text).substring(0, 160) : undefined,
    reason: s.reason,
  }));
}

function buildState(signals, delta) {
  const crit = signals.filter((s) => s.severity === 'critical').length;
  const high = signals.filter((s) => s.severity === 'high').length;
  const up = signals.filter((s) => s.direction === 'up' || s.direction === 'escalated').length;
  return {
    new_and_escalated_signals: compactSignals(signals),
    summary: {
      count: signals.length,
      critical: crit,
      high,
      escalating: up,
      domains: [...new Set(signals.map((s) => String(s.key || '').split('_')[0]).filter(Boolean))].slice(0, 8),
    },
    delta: {
      changed: delta?.changed,
      critical_changes: delta?.criticalChanges,
      signals_total: delta?.signalsTotal,
    },
    note: 'These signals already passed deterministic delta thresholds. Judge whether this is worth interrupting the operator, and at what tier.',
  };
}

/**
 * Decide whether to alert, and at what tier, using Jev.
 * @returns {Promise<null|{shouldAlert: boolean, tier?: string, confidence?: string,
 *                          reason: string, _source: string}>}
 *          null when Jev is unavailable — caller must fall back.
 */
export async function triageSignals(signals, delta, opts = {}) {
  if (process.env.CRUCIX_JEV_TRIAGE === '0') return null;
  if (!signals?.length) return null;

  const jev = opts.client || new TypesafeJevProvider({
    apiKey: resolveKey(opts),
    model: opts.model || process.env.JEV_MODEL || undefined,
  });
  if (!jev.isConfigured) return null;

  const r = await jev.decide(buildState(signals, delta), {
    should_alert: {
      type: 'noul',
      instructions: 'Given these signal changes, is this worth interrupting the operator right now?',
      criteria: {
        true: 'Actionable now: the operator would want to know immediately',
        false: 'Not worth an interruption; can wait for the next digest',
      },
    },
    genuine: {
      type: 'noul',
      instructions: 'Are these genuine, meaningful changes rather than routine fluctuation or duplicate noise?',
      criteria: { true: 'Real signal', false: 'Routine noise or duplicate' },
    },
    tier: {
      type: 'choice',
      instructions: 'If this does warrant an alert, which tier?',
      criteria: TIER_CRITERIA,
    },
  }, { timeout: opts.timeout || 15000 });

  if (!r.ok) return null; // fail-safe: caller keeps its own path

  const a = r.answers;
  const pAlert = a.should_alert?.noul;
  const pGenuine = a.genuine?.noul;
  const tier = String(a.tier?.choice || '').toLowerCase();
  if (typeof pAlert !== 'number') return null;

  // Require both a clear intent to alert and a genuine change; a low tier
  // confidence should not manufacture an interruption.
  const shouldAlert = pAlert >= 0.5 && (pGenuine === undefined || pGenuine >= 0.5);

  const probs = a.tier?.probabilities || {};
  const conf = 'HIGH';
  return {
    shouldAlert,
    tier: TIER_CRITERIA[tier] ? tier.toUpperCase() : 'ROUTINE',
    confidence: shouldAlert && (probs[tier] ?? 0) >= 0.6 ? conf : 'MEDIUM',
    reason: `Jev: P(alert)=${pAlert.toFixed(2)}`
      + (pGenuine !== undefined ? `, P(genuine)=${pGenuine.toFixed(2)}` : '')
      + `, tier=${tier || 'n/a'} (p=${probs[tier] !== undefined ? Number(probs[tier]).toFixed(2) : 'n/a'})`,
    _source: 'jev',
    _jev: { pAlert, pGenuine, tierProbs: probs, latency: r.latency, cost: r.cost },
  };
}

export default triageSignals;

/**
 * Merge a Jev decision (shouldAlert + tier) with prose from the existing
 * rule-based evaluation (headline/actionable/signals), so the alert embed still
 * renders. Jev supplies the *decision*; prose stays with whatever can generate
 * text. Never throws.
 */
export function mergeDecisionProse(jevEval, signals, delta, alerter) {
  let prose = null;
  if (jevEval.shouldAlert && typeof alerter?._ruleBasedEvaluation === 'function') {
    try { prose = alerter._ruleBasedEvaluation(signals, delta); } catch { prose = null; }
  }
  const base = prose && prose.shouldAlert ? prose : {};
  const out = {
    ...base,
    shouldAlert: jevEval.shouldAlert,
    tier: jevEval.tier,
    confidence: jevEval.confidence,
    reason: jevEval.reason,
    _source: 'jev',
    _jev: jevEval._jev,
  };
  if (!out.headline) {
    const top = signals.find(s => s.severity === 'critical') || signals[0] || {};
    out.headline = top.label || top.reason || 'Signal Change Detected';
  }
  if (!out.actionable) out.actionable = 'Review dashboard.';
  if (!out.signals) out.signals = signals.map(s => s.label || s.key).slice(0, 5);
  if (!out.crossCorrelation) out.crossCorrelation = 'n/a';
  return out;
}
