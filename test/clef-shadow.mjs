// Clef shadow tests — provider mapping, log shape, and proof that shadowing
// cannot change a decision.
//
// Run from /opt/Crucix so the relative imports resolve:
//   cd /opt/Crucix && CRUCIX_JEV_LOG_PATH=/root/.hermes/cache/scratch/t-jev.jsonl \
//     CRUCIX_CLEF_LOG_PATH=/root/.hermes/cache/scratch/t-clef.jsonl \
//     node test/clef-shadow.mjs
//
// Live calls hit Cloudflare's free Workers AI allowance (~2 neurons), so this
// suite costs nothing and does not need the OpenRouter balance.

import '../apis/utils/env.mjs';
import { readFileSync, existsSync, rmSync } from 'fs';
import { CloudflareClefProvider, normaliseModel, DEFAULT_CLEF_MODEL } from '../lib/llm/clef.mjs';
import { stateSha, buildEntry, logClefShadow, clefShadowDecision, runClefShadow } from '../lib/alerts/clef-shadow.mjs';
import { triageSignals, triageQuestions } from '../lib/alerts/jev-triage.mjs';
import { TypesafeJevProvider } from '../lib/llm/typesafe.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readRows = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

const JEV_LOG = process.env.CRUCIX_JEV_LOG_PATH || '/root/.hermes/cache/scratch/t-jev.jsonl';
const CLEF_LOG = process.env.CRUCIX_CLEF_LOG_PATH || '/root/.hermes/cache/scratch/t-clef.jsonl';
for (const p of [JEV_LOG, CLEF_LOG]) { try { rmSync(p); } catch { /* fresh log */ } }

// ─── 1. model normalisation ───────────────────────────────────────────────
console.log('\n[1] model ids');
check('bare name passes through', normaliseModel('clef-flash') === 'clef-flash');
check('@cf/ prefixed id is stripped', normaliseModel('@cf/cloudflare/clef') === 'clef');
check('cloudflare/ prefixed id is stripped', normaliseModel('cloudflare/clef-flash') === 'clef-flash');
check('unsupported model -> null, never a silent swap', normaliseModel('gpt-oss-120b') === null);
check('unsupported model is refused at call time', (await new CloudflareClefProvider({ model: 'typesafe/jev-1.13' }).decide({ a: 1 }, triageQuestions())).ok === false);
check('clef-omni allowed', normaliseModel('clef-omni') === 'clef-omni');

// ─── 2. pairing hash ──────────────────────────────────────────────────────
console.log('\n[2] state pairing');
const s1 = { a: 1, b: [1, 2] };
check('same state -> same hash', stateSha(s1) === stateSha({ a: 1, b: [1, 2] }));
check('different state -> different hash', stateSha(s1) !== stateSha({ a: 2 }));
check('hash is 16 hex chars', /^[0-9a-f]{16}$/.test(stateSha(s1)));

// ─── 3. entry mapping ─────────────────────────────────────────────────────
console.log('\n[3] log entry mapping');
const entry = buildEntry(s1, {
  ok: true, model: 'clef-flash', latency: 0.42, neurons: 0.77,
  answers: {
    should_alert: { type: 'noul', noul: 0.91 },
    genuine: { type: 'noul', noul: 0.8 },
    corroborated: { type: 'noul', noul: 0.2 },
    tier: { type: 'choice', choice: 'flash', probabilities: { flash: 0.7, priority: 0.2, routine: 0.1, none: 0 }, confidence: 0.66 },
  },
}, { stateSha: 'deadbeefdeadbeef', signals: [{ key: 'vix' }, { key: 'tg_urgent:x' }], jevOk: true });
check('provider tagged', entry.provider === 'cloudflare');
check('probability mapped', entry.pAlert === 0.91);
check('tier mapped from choice', entry.rawTier === 'flash');
check('shouldAlert derived at 0.5', entry.shouldAlert === true);
check('round-trips the pairing hash', entry.stateSha === 'deadbeefdeadbeef');
check('signal keys carried', entry.keys.length === 2 && entry.keys[0] === 'vix');
check('jev status carried', entry.jevOk === true);

// ─── 4. fail-safe: disabled and unconfigured ──────────────────────────────
console.log('\n[4] fail-safe');
process.env.CRUCIX_CLEF_SHADOW = '0';
check('disabled -> null, no call', (await clefShadowDecision(s1, triageQuestions())) === null);
process.env.CRUCIX_CLEF_SHADOW = '1';
const badClient = new CloudflareClefProvider({ accountId: 'x'.repeat(32), apiKey: 'nope' });
const bad = await badClient.decide(s1, triageQuestions(), { timeout: 10000 });
check('bad creds -> ok:false, never throws', bad.ok === false && !!bad.error, JSON.stringify(bad).slice(0, 120));
// Env fallback is intentional, so "unconfigured" must be tested with the env cleared.
const saved = {
  a: process.env.CLOUDFLARE_ACCOUNT_ID, t: process.env.CRUCIX_CLEF_TOKEN,
  w: process.env.CLOUDFLARE_WORKERS_AI_TOKEN, c: process.env.CLOUDFLARE_API_TOKEN,
};
for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'CRUCIX_CLEF_TOKEN', 'CLOUDFLARE_WORKERS_AI_TOKEN', 'CLOUDFLARE_API_TOKEN']) delete process.env[k];
check('no creds anywhere -> isConfigured=false', new CloudflareClefProvider().isConfigured === false);
check('no creds -> decide() refuses without calling out', (await new CloudflareClefProvider().decide(s1, triageQuestions())).ok === false);
if (saved.a) process.env.CLOUDFLARE_ACCOUNT_ID = saved.a;
if (saved.t) process.env.CRUCIX_CLEF_TOKEN = saved.t;
if (saved.w) process.env.CLOUDFLARE_WORKERS_AI_TOKEN = saved.w;
if (saved.c) process.env.CLOUDFLARE_API_TOKEN = saved.c;

// ─── 5. live call ─────────────────────────────────────────────────────────
console.log('\n[5] live Cloudflare call (free tier)');
const live = new CloudflareClefProvider();
if (!live.isConfigured) {
  console.log('  SKIP no CLOUDFLARE creds in env');
} else {
  const r = await live.decide({ signals: [{ key: 'vix', pctChange: 36.8 }], note: 'test' }, triageQuestions(), { timeout: 20000 });
  check('live decide() ok', r.ok === true, r.error || '');
  if (r.ok) {
    check('answers use our question names', ['should_alert', 'genuine', 'corroborated', 'tier'].every((k) => k in r.answers));
    check('pAlert is a probability', typeof r.answers.should_alert?.noul === 'number');
    check('model reported', r.model === 'clef-flash');
  }
}

// ─── 6. logging switches ──────────────────────────────────────────────────
console.log('\n[6] logging switches');
logClefShadow(buildEntry(s1, { ok: true, model: 'clef-flash', answers: { should_alert: { noul: 0.5 } } }));
check('row appended', readRows(CLEF_LOG).length === 1);
process.env.CRUCIX_CLEF_LOG = '0';
logClefShadow(buildEntry(s1, { ok: true, model: 'clef-flash', answers: {} }));
check('CRUCIX_CLEF_LOG=0 suppresses', readRows(CLEF_LOG).length === 1);
delete process.env.CRUCIX_CLEF_LOG;

// ─── 7. end-to-end: shadow runs beside the real path ──────────────────────
console.log('\n[7] end-to-end triageSignals');
process.env.CRUCIX_CLEF_LOG_PATH = CLEF_LOG;
process.env.CRUCIX_CLEF_SHADOW = '1';
try { rmSync(CLEF_LOG); } catch { /* fresh */ }
const signals = [
  { key: 'tg_urgent:abc', text: 'Explosion reported near the strait; shipping halted', severity: 'critical', direction: 'up', item: { channel: 'intel_agg' } },
  { key: 'vix', label: 'VIX', severity: 'high', direction: 'up', from: 18.2, to: 24.9, pctChange: 36.8, reason: 'spike' },
];
const delta = { summary: { totalChanges: 5, criticalChanges: 1, direction: 'up', signalBreakdown: { new: 2, escalated: 1, deescalated: 0, unchanged: 9 } } };
const t0 = Date.now();
const decision = await triageSignals(signals, delta);
const took = (Date.now() - t0) / 1000;
check('decision still returned', !!decision, 'null = Jev unavailable');
if (decision) {
  check('decision comes from jev, not clef', decision._source === 'jev');
  check('no clef fields leaked into the decision', !('clef' in decision) && !('provider' in decision));
  check('flash guard still applied', decision._jev.demotedFromFlash ? decision.tier === 'PRIORITY' : true);
  const jevRows = readRows(JEV_LOG);
  const row = jevRows[jevRows.length - 1];
  check('jev row carries provider', row?.provider === 'openrouter');
  check('jev row carries stateSha', /^[0-9a-f]{16}$/.test(row?.stateSha || ''));
  // fire-and-forget: the shadow lands asynchronously, after the call returns
  const expected = row?.stateSha;
  let clefRow = null;
  for (let i = 0; i < 30 && !clefRow; i++) {
    clefRow = readRows(CLEF_LOG).find((r) => r.stateSha === expected) || null;
    if (!clefRow) await sleep(1000);
  }
  check('clef shadow row written', !!clefRow, `no row with stateSha=${expected}`);
  if (clefRow) {
    check('rows pair on stateSha', clefRow.stateSha === expected);
    check('clef row marked ok + provider', clefRow.ok === true && clefRow.provider === 'cloudflare');
    check('same signals judged', clefRow.keys.length === 2);
    check('jev status recorded', clefRow.jevOk === true);
  }
  console.log(`  (triageSignals returned in ${took.toFixed(2)}s — shadow is not in that path)`);
}

// ─── 8. shadow survives a dead Jev ────────────────────────────────────────
console.log('\n[8] shadow when Jev fails');
try { rmSync(CLEF_LOG); } catch { /* fresh */ }
const deadJev = new TypesafeJevProvider({ apiKey: 'sk-or-v1-bogus', model: 'typesafe/jev-1.13' });
const nullDecision = await triageSignals(signals, delta, { client: deadJev });
check('Jev failure -> null (caller falls back)', nullDecision === null);
let row8 = null;
for (let i = 0; i < 30 && !row8; i++) {
  row8 = readRows(CLEF_LOG)[0] || null;
  if (!row8) await sleep(1000);
}
check('clef still logged when Jev failed', !!row8);
check('jevOk=false recorded', row8?.jevOk === false);
check('clef itself answered', row8?.ok === true, row8?.error || '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);