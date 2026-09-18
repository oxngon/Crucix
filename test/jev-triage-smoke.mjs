// Smoke test for the Jev alert triage integration.
//   node test/jev-triage-smoke.mjs
import '../apis/utils/env.mjs'; // loads Crucix .env into process.env
import { triageSignals, mergeDecisionProse } from '../lib/alerts/jev-triage.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';

const signals = [
  { key: 'vix', label: 'VIX', severity: 'critical', direction: 'up', reason: '+38% in 24h' },
  { key: 'conflict_events', label: 'Conflict Events', severity: 'critical', direction: 'up', reason: 'ACLED +210%' },
  { key: 'wti', label: 'WTI Crude', severity: 'high', direction: 'up', reason: '+11%' },
];
const delta = { changed: 14, criticalChanges: 2, signalsTotal: 31 };

const routineSignals = [
  { key: 'natgas', label: 'NatGas', severity: 'high', direction: 'down', reason: '-4% (within normal weekly range)' },
];

console.log('provider=%s  LLM_API_KEY=%s  OPENROUTER_API_KEY=%s',
  process.env.LLM_PROVIDER, !!process.env.LLM_API_KEY, !!process.env.OPENROUTER_API_KEY);

// ── 1. real decision ────────────────────────────────────────────────────────
const r = await triageSignals(signals, delta);
if (!r) {
  console.log('1. ESCALATION CASE -> null (no key / disabled / Jev unavailable)');
} else {
  console.log('1. ESCALATION CASE -> shouldAlert=%s tier=%s conf=%s (%ss, $%s)',
    r.shouldAlert, r.tier, r.confidence, r._jev?.latency, r._jev?.cost);
  console.log('   reason:', r.reason);
}

// ── 2. routine noise should not be treated the same ─────────────────────────
const r2 = await triageSignals(routineSignals, { changed: 3 });
console.log('2. ROUTINE CASE ->', r2 ? `shouldAlert=${r2.shouldAlert} tier=${r2.tier}` : 'null');
if (r2) console.log('   reason:', r2.reason);

// ── 3. fail-safe: no key => null, never a verdict ───────────────────────────
const r3 = await triageSignals(signals, delta, { client: { isConfigured: false } });
console.log('3. NO KEY ->', r3 === null ? 'null (correct: caller falls back)' : `LEAK: ${JSON.stringify(r3)}`);

// ── 4. fail-safe: unreachable API => null, no throw ─────────────────────────
const r4 = await triageSignals(signals, delta, {
  client: { isConfigured: true, decide: async () => ({ ok: false, error: 'simulated timeout' }) },
});
console.log('4. API FAILURE ->', r4 === null ? 'null (correct: no fabricated verdict)' : `LEAK: ${JSON.stringify(r4)}`);

// ── 5. disabled via env ─────────────────────────────────────────────────────
process.env.CRUCIX_JEV_TRIAGE = '0';
const r5 = await triageSignals(signals, delta);
console.log('5. DISABLED ->', r5 === null ? 'null (correct)' : `LEAK: ${JSON.stringify(r5)}`);
delete process.env.CRUCIX_JEV_TRIAGE;

// ── 6. merge produces a renderable evaluation (needs prose for the embed) ───
class StubAlerter {
  _ruleBasedEvaluation() {
    return { shouldAlert: true, tier: 'FLASH', headline: '2 Critical Cross-Domain Signals',
             reason: 'rules prose', actionable: 'Review dashboard.', signals: ['VIX'], crossCorrelation: 'market + conflict' };
  }
}
if (r) {
  const merged = mergeDecisionProse(r, signals, delta, new StubAlerter());
  const ok = merged.shouldAlert === r.shouldAlert && merged.tier === r.tier
    && typeof merged.headline === 'string' && merged.headline.length > 0
    && merged._source === 'jev';
  console.log('6. MERGE -> %s  headline=%j tier=%s source=%s',
    ok ? 'renderable OK' : 'BROKEN', merged.headline, merged.tier, merged._source);
}

// ── 7. provider registry still works for generative providers ───────────────
const p = createLLMProvider({ provider: 'openrouter', apiKey: 'x', model: 'y' });
console.log('7. REGISTRY -> openrouter=%s typesafe=%s',
  p?.name, createLLMProvider({ provider: 'typesafe', apiKey: 'x' })?.name);
