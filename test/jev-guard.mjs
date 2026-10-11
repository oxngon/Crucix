// Deterministic guard test for Jev alert triage — offline (stub client, no network).
//   node test/jev-guard.mjs
//
// Covers the FLASH corroboration guard, the "none" tier refusal, and that the
// decision state actually carries the delta summary (it reached the model as
// undefined for every decision before 2026-10-11).

import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LOG_PATH = join(tmpdir(), `jev-guard-${process.pid}.jsonl`);
process.env.CRUCIX_JEV_LOG_PATH = LOG_PATH;
try { rmSync(LOG_PATH); } catch { /* fresh */ }

const { triageSignals, buildState, corroborationOf } = await import('../lib/alerts/jev-triage.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
}

const osintPost = (n, ch = 'intelslava') => ({
  key: `tg_urgent:${n}`, item: { channel: ch }, text: `urgent post ${n}`, reason: 'New urgent OSINT post',
});
const telegramOnly = [osintPost('aaaa'), osintPost('bbbb'), osintPost('cccc'), osintPost('dddd')];
const withSensor = [...telegramOnly, { key: 'air_total', label: 'Air Activity', severity: 'high', direction: 'up', from: 812, to: 904, pctChange: 11.3 }];
const withCritical = [{ key: 'vix', label: 'VIX', severity: 'critical', direction: 'up', reason: '+38%' }];
const withNuke = [{ key: 'nuke_anomaly', severity: 'critical', reason: 'Nuclear anomaly detected' }];

const delta = { summary: { totalChanges: 6, criticalChanges: 4, direction: 'mixed', signalBreakdown: { new: 4, escalated: 2, deescalated: 0, unchanged: 18 } } };

const answersFlash = {
  should_alert: { noul: 0.9 },
  genuine: { noul: 0.9 },
  corroborated: { noul: 0.1 },
  tier: { choice: 'flash', probabilities: { flash: 0.9, priority: 0.05, routine: 0.03, none: 0.02 } },
};
function stub(answers, record) {
  return {
    isConfigured: true,
    decide: async (state, questions) => {
      if (record) { record.state = state; record.questions = questions; }
      return { ok: true, answers, latency: 0.2, cost: 0.00002 };
    },
  };
}

// ── 1. FLASH demoted on single-source Telegram chatter ──────────────────────
const rec = {};
const a = await triageSignals(telegramOnly, delta, { client: stub(answersFlash, rec) });
check('single-source flash demoted', a?.tier === 'PRIORITY' && a._jev.demotedFromFlash === true, `tier=${a?.tier} demoted=${a?._jev?.demotedFromFlash}`);
check('demotion is recorded in the reason', /flash demoted/.test(a?.reason || ''), a?.reason);

// ── 2. FLASH survives when an independent domain corroborates ───────────────
const b = await triageSignals(withSensor, delta, { client: stub(answersFlash) });
check('flash kept with independent sensor', b?.tier === 'FLASH' && b._jev.demotedFromFlash === false, `tier=${b?.tier}`);

// ── 3. FLASH survives on a critical-severity signal ─────────────────────────
const c = await triageSignals(withCritical, delta, { client: stub(answersFlash) });
check('flash kept with a critical signal', c?.tier === 'FLASH', `tier=${c?.tier}`);

// ── 4. FLASH survives on a radiation anomaly ────────────────────────────────
const d = await triageSignals(withNuke, delta, { client: stub(answersFlash) });
check('flash kept on radiation anomaly', d?.tier === 'FLASH', `tier=${d?.tier}`);

// ── 5. tier "none" is a refusal to alert, not a low tier ────────────────────
const noneAns = { should_alert: { noul: 0.9 }, genuine: { noul: 0.9 }, corroborated: { noul: 0.9 },
  tier: { choice: 'none', probabilities: { none: 0.8, flash: 0.1, priority: 0.05, routine: 0.05 } } };
const e = await triageSignals(withSensor, delta, { client: stub(noneAns) });
check('tier none suppresses the alert', e?.shouldAlert === false, `shouldAlert=${e?.shouldAlert} tier=${e?.tier}`);

// ── 6. pAlert below 0.5 still suppresses ────────────────────────────────────
const lowAns = { should_alert: { noul: 0.4 }, genuine: { noul: 0.9 }, corroborated: { noul: 0.9 },
  tier: { choice: 'flash', probabilities: { flash: 0.6 } } };
const f = await triageSignals(withSensor, delta, { client: stub(lowAns) });
check('pAlert 0.4 suppresses', f?.shouldAlert === false, `shouldAlert=${f?.shouldAlert}`);

// ── 7. the decision state carries the real delta summary ────────────────────
const state = buildState(withSensor, delta);
check('state.delta.changed from summary.totalChanges', state.delta.changed === 6, `changed=${state.delta.changed}`);
check('state.delta.critical_changes from summary', state.delta.critical_changes === 4, `cc=${state.delta.critical_changes}`);
check('state.delta direction/breakdown present', state.delta.direction === 'mixed' && state.delta.breakdown?.unchanged === 18);
check('state summarises corroboration', state.summary.corroborated === true && /independent domains/.test(state.summary.corroboration_basis), state.summary.corroboration_basis);
check('osint posts carry channel + kind', rec.state.signals.some(s => s.channel === 'intelslava' && s.kind === 'telegram'));

// ── 8. the question set now includes corroborated and the none tier ─────────
check('questions include corroborated', !!rec.questions?.corroborated && rec.questions.corroborated.type === 'noul');
check('tier criteria include none', !!rec.questions?.tier?.criteria?.none);

// ── 9. corroborationOf unit behaviour ──────────────────────────────────────
check('corroborationOf: telegram only -> false', corroborationOf(telegramOnly).corroborated === false);
check('corroborationOf: same channel counts once', corroborationOf([osintPost('x', 'CIG_telegram'), osintPost('y', 'CIG_telegram')]).domains.length === 1);
check('corroborationOf: telegram + sensor -> true', corroborationOf(withSensor).corroborated === true);

// ── 10. every decision is logged with probabilities ────────────────────────
let logged = [];
try {
  logged = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
} catch { /* missing file = failure below */ }
check('decisions logged to jsonl', logged.length >= 6, `lines=${logged.length}`);
check('log carries probabilities + domains', logged.every(x => typeof x.pAlert === 'number' && Array.isArray(x.domains)));
check('log flags the flash demotion', logged.some(x => x.demotedFromFlash === true));

try { rmSync(LOG_PATH); } catch { /* best effort */ }
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
