// Alert rendering test — deterministic, offline (no Jev/network calls).
//   node test/alert-render.mjs
//
// Guards the regression where a Jev-approved alert rendered as raw signal ids
// (`tg_urgent:1bb71decb48139c8`) with the model's probability string as the
// "reason". Reproduces the exact 2026-10-11 13:04 flash payload.

import { mergeDecisionProse, signalLine, isOsintSignal } from '../lib/alerts/jev-triage.mjs';
import { TelegramAlerter } from '../lib/alerts/telegram.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
}

// The real live payload: 4 new urgent Telegram posts + an air-activity jump.
const liveSignals = [
  { key: 'tg_urgent:1bb71decb48139c8', text: 'Strikes reported on port infrastructure in the Black Sea region overnight', item: { channel: 'intelslava' }, reason: 'New urgent OSINT post' },
  { key: 'tg_urgent:21943236e01ab361', text: 'General Staff confirms hits on missile-fuel production sites', item: { channel: 'intelslava' }, reason: 'New urgent OSINT post' },
  { key: 'tg_urgent:4d7876b84b67ff4f', text: 'Air defence active over multiple regions, local channels report', item: { channel: 'CIG_telegram' }, reason: 'New urgent OSINT post' },
  { key: 'tg_urgent:ea8d7a2b3f40f44e', text: 'Emergency power cuts announced in two oblasts', item: { channel: 'CIG_telegram' }, reason: 'New urgent OSINT post' },
  { key: 'air_total', label: 'Air Activity', severity: 'high', direction: 'up', from: 812, to: 904, pctChange: 11.3 },
];
const delta = { summary: { totalChanges: 6, criticalChanges: 4, direction: 'mixed' } };

// Shape returned by triageSignals() for that sweep (see journal 2026-10-11 15:04).
const jevEval = {
  shouldAlert: true,
  tier: 'FLASH',
  confidence: 'HIGH',
  reason: 'Jev: P(alert)=0.66, P(genuine)=0.67, tier=flash (p=0.74)',
  _source: 'jev',
  _jev: { pAlert: 0.66, pGenuine: 0.67, tierProbs: { flash: 0.74, priority: 0.18, routine: 0.08 }, latency: 0.31 },
};

const tg = new TelegramAlerter({ botToken: null, chatId: null });
const merged = mergeDecisionProse(jevEval, liveSignals, delta, tg);
const message = tg._formatTieredAlert(merged, delta, 'FLASH');

console.log('─────────────────────────────────────────');
console.log(message);
console.log('─────────────────────────────────────────\n');

// 1. No raw signal ids anywhere.
check('no raw signal ids', !/tg_urgent:/.test(message) && !merged.signals.some(s => s.includes('tg_urgent:')));

// 2. No probability string in the reason.
check('no probability string in reason', !/P\(alert\)/.test(merged.reason), `reason=${JSON.stringify(merged.reason)}`);

// 3. No 'n/a' cross-correlation.
check('no n/a cross-correlation', !/n\/a/.test(message));

// 4. Post text and channel actually surface.
check('post text surfaces', merged.signals.some(s => s.includes('Black Sea')), `signals=${JSON.stringify(merged.signals)}`);
check('channel surfaces', merged.signals.some(s => s.includes('[intelslava]')));

// 5. Metric rendered with numbers, and headline leads with it (hard data > chatter).
check('metric rendered with numbers', merged.signals.some(s => /Air Activity: 812 → 904 \(\+11\.3%\)/.test(s)));
check('headline leads with the metric', /Air Activity/.test(merged.headline), `headline=${JSON.stringify(merged.headline)}`);

// 6. Single-source honesty: OSINT + air really is 2 domains, so corroborated line.
check('corroboration stated', /Corroborated across 2 domains/.test(merged.reason), `reason=${JSON.stringify(merged.reason)}`);

// 7. Probabilities demoted to the footer, not the body.
check('jevNote carries probabilities', /p\(alert\) 0\.66/.test(merged.jevNote), `jevNote=${JSON.stringify(merged.jevNote)}`);
check('footer renders the note', /Jev p\(alert\) 0\.66/.test(message));

// 8. Confidence reflects the alert decision, not the tier label.
check('confidence MEDIUM at p=0.66', merged.confidence === 'MEDIUM', `confidence=${merged.confidence}`);

// 9. OSINT-only cluster: headline describes the cluster, reason says single-source,
//    and cross-correlation is omitted entirely.
const osintOnly = mergeDecisionProse(jevEval, liveSignals.slice(0, 4), delta, tg);
check('osint-only headline', /OSINT surge: 4 new urgent posts/.test(osintOnly.headline), `headline=${JSON.stringify(osintOnly.headline)}`);
check('osint-only single-source honesty', /Single-source \(telegram\)/.test(osintOnly.reason), `reason=${JSON.stringify(osintOnly.reason)}`);
check('osint-only omits cross-correlation', osintOnly.crossCorrelation === undefined);
const osintMsg = tg._formatTieredAlert(osintOnly, delta, 'FLASH');
check('osint-only message has no cross-correlation line', !/Cross-correlation/.test(osintMsg));

// 10. Single-post case headlines the post itself.
const one = mergeDecisionProse(jevEval, liveSignals.slice(3, 4), delta, tg);
check('single post headline is the post', /Emergency power cuts/.test(one.headline), `headline=${JSON.stringify(one.headline)}`);

// 11. Rules-prose path still supplies a richer actionable when it fires.
class StubAlerter {
  _ruleBasedEvaluation() {
    return { shouldAlert: true, actionable: 'Check dashboard for affected sites.', crossCorrelation: 'market + conflict' };
  }
}
const withRules = mergeDecisionProse(jevEval, liveSignals, delta, new StubAlerter());
check('rules actionable preserved', withRules.actionable === 'Check dashboard for affected sites.', `actionable=${JSON.stringify(withRules.actionable)}`);

// 12. Never throws on junk.
try {
  const junk = mergeDecisionProse({ shouldAlert: true, tier: 'FLASH' }, [], {}, null);
  check('empty signals does not throw', typeof junk.headline === 'string' && typeof junk.reason === 'string');
} catch (err) {
  check('empty signals does not throw', false, err.message);
}

// 13. A non-OSINT signal is not misclassified.
check('metric not misread as OSINT', !isOsintSignal({ key: 'vix', label: 'VIX' }));
check('metric line format', signalLine({ key: 'vix', label: 'VIX', from: 14, to: 22, pctChange: 57.1 }) === 'VIX: 14 → 22 (+57.1%)');
check('threshold-only metric uses its reason', signalLine({ key: 'vix', label: 'VIX', severity: 'critical', direction: 'up', reason: '+38% in 24h' }) === 'VIX: +38% in 24h');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
