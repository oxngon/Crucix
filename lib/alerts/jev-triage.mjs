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
 * Merge a Jev decision (shouldAlert + tier) with operator-facing prose.
 *
 * Jev supplies the *decision* but cannot write text. Borrowing prose from the
 * rule-based evaluator only works when the rules would ALSO alert (>=5 OSINT
 * posts, a critical, etc.) — below those thresholds there is no prose, and the
 * alert fell back to `label || key`, rendering raw signal ids like
 * `tg_urgent:1bb71decb48139c8` with the model's probability string as the
 * "reason". So build the prose deterministically from the signals themselves,
 * which always renders and always says what actually changed.
 *
 * Never throws.
 */
export function mergeDecisionProse(jevEval, signals, delta, alerter) {
  let rulesProse = null;
  if (jevEval.shouldAlert && typeof alerter?._ruleBasedEvaluation === 'function') {
    try { rulesProse = alerter._ruleBasedEvaluation(signals, delta); } catch { rulesProse = null; }
  }
  const rulesOk = !!(rulesProse && rulesProse.shouldAlert);

  const list = Array.isArray(signals) ? signals : [];
  const osint = list.filter(isOsintSignal);
  const metrics = list.filter((s) => !isOsintSignal(s));
  const domains = [...new Set(list.map(domainOf))];

  // Headline: lead with a hard-data move if there is one, else describe the
  // OSINT cluster (never a bare signal id, never a probability string).
  const topMetric = metrics
    .slice()
    .sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0)
      || Math.abs(b.pctChange || 0) - Math.abs(a.pctChange || 0))[0];
  let headline;
  if (topMetric) headline = oneLine(metricLine(topMetric), 95);
  else if (osint.length === 1) headline = oneLine(`${channelTag(osint[0])}${osint[0].text || 'Urgent OSINT post'}`, 95);
  else if (osint.length > 1) headline = `OSINT surge: ${osint.length} new urgent posts`;
  else headline = 'Signal change detected';

  // Reason: plain summary + honest corroboration status.
  const bits = [];
  if (osint.length) bits.push(`${osint.length} new urgent OSINT post${osint.length > 1 ? 's' : ''}.`);
  // Don't repeat whatever the headline already leads with.
  const restMetrics = metrics.filter((m) => m !== topMetric);
  if (restMetrics.length) bits.push(`Also moving: ${restMetrics.slice(0, 3).map(metricLine).join(' · ')}.`);
  if (domains.length >= 2) bits.push(`Corroborated across ${domains.length} domains (${domains.join(' + ')}).`);
  else if (domains.length === 1) bits.push(`Single-source (${domains[0]}) — no cross-domain corroboration this sweep.`);
  const reason = bits.join(' ') || 'Signal change detected.';

  // Confidence reflects the alert decision itself, not the tier label.
  const pAlert = jevEval._jev?.pAlert;
  const pGenuine = jevEval._jev?.pGenuine;
  let confidence = 'MEDIUM';
  if (typeof pAlert === 'number' && typeof pGenuine === 'number') {
    if (pAlert >= 0.7 && pGenuine >= 0.7) confidence = 'HIGH';
    else if (pAlert < 0.5 || pGenuine < 0.5) confidence = 'LOW';
  } else if (jevEval.confidence) confidence = jevEval.confidence;

  const out = {
    shouldAlert: jevEval.shouldAlert,
    tier: jevEval.tier,
    confidence,
    headline,
    reason,
    signals: list.map(signalLine).slice(0, 6),
    _source: 'jev',
    _jev: jevEval._jev,
    jevNote: buildJevNote(jevEval),
  };
  // Cross-correlation is only worth printing when there IS corroboration.
  const cross = domains.length >= 2 ? domains.join(' + ') : null;
  if (cross) out.crossCorrelation = cross;
  else if (rulesOk && rulesProse.crossCorrelation && rulesProse.crossCorrelation !== 'n/a') {
    out.crossCorrelation = rulesProse.crossCorrelation;
  }
  out.actionable = (rulesOk && rulesProse.actionable && rulesProse.actionable !== 'Monitor')
    ? rulesProse.actionable
    : 'Review dashboard.';
  return out;
}

// ─── Deterministic prose helpers ──────────────────────────────────────────

const SEV_RANK = { critical: 3, high: 2, moderate: 1, low: 0 };

export function isOsintSignal(s) {
  return !!s?.item?.channel || String(s?.key || '').startsWith('tg_urgent');
}

function oneLine(text, max = 150) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function channelTag(s) {
  const ch = s?.item?.channel;
  return ch ? `[${ch}] ` : '';
}

/** `Label: from → to (+x%)` for count/numeric metrics. */
function metricLine(s) {
  const label = s?.label || s?.key || 'signal';
  if (s?.from !== undefined && s?.to !== undefined) {
    const pct = typeof s?.pctChange === 'number'
      ? ` (${s.pctChange > 0 ? '+' : ''}${s.pctChange}%)`
      : '';
    return `${label}: ${s.from} → ${s.to}${pct}`;
  }
  // No absolute pair (threshold-only signals) — use the delta or the reason text.
  const detail = (s?.pctChange !== undefined && s?.pctChange !== null)
    ? `${s.pctChange > 0 ? '+' : ''}${s.pctChange}%`
    : (s?.reason ? oneLine(s.reason, 60) : '');
  if (detail) return `${label}: ${detail}`;
  return `${label}${s?.direction ? ` ${s.direction}` : ''}`;
}

/** One readable bullet per signal. OSINT -> `[channel] post text`; metrics -> numbers. */
export function signalLine(s) {
  if (isOsintSignal(s)) return `${channelTag(s)}${oneLine(s.text || s.reason || 'urgent post')}`;
  return metricLine(s);
}

const MARKET_KEYS = ['vix', 'hy_spread', 'wti', 'brent', 'natgas', 'gold', 'silver', '10y2y', 'fed_funds', '10y_yield', 'usd_index'];

function domainOf(s) {
  if (isOsintSignal(s)) return 'telegram';
  const k = String(s?.key || '');
  if (MARKET_KEYS.includes(k)) return 'market';
  if (['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(k)) return 'conflict';
  if (k === 'nuke_anomaly') return 'radiation';
  if (k === 'air_total') return 'air';
  if (k === 'sdr_online') return 'sigint';
  return k.split('_')[0] || 'other';
}

function buildJevNote(jevEval) {
  const pAlert = jevEval._jev?.pAlert;
  if (typeof pAlert !== 'number') return '';
  const parts = [`p(alert) ${pAlert.toFixed(2)}`];
  if (typeof jevEval._jev?.pGenuine === 'number') parts.push(`p(genuine) ${jevEval._jev.pGenuine.toFixed(2)}`);
  const tierKey = String(jevEval.tier || '').toLowerCase();
  const tierP = jevEval._jev?.tierProbs?.[tierKey];
  if (typeof tierP === 'number') parts.push(`${tierKey} ${tierP.toFixed(2)}`);
  return parts.join(' · ');
}
