// Clef Provider — Cloudflare's own System One decision models, via Workers AI.
//
// Same contract as lib/llm/typesafe.mjs (Jev), different wire format:
//
//   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash
//   {"model":"clef-flash", "state": <str|obj>, "questions": {...}}
//   -> {"result": {"model","answers":{...},"usage":{...}}, "success": true}
//
// Differences from the OpenRouter path that this class hides:
//   * the body is FLAT — no `input` wrapper — and lives under `result`
//   * the `model` field must be the BARE name (`clef`, `clef-flash`); the
//     `@cf/cloudflare/...` id or `cloudflare/clef` fails a regex on the server
//   * a 200 can still carry {"success": false, "errors":[...]}, so success must
//     be checked explicitly — res.ok alone is not enough
//
// WHY THIS EXISTS: Clef is free inside the Workers Free daily allowance
// (10,000 neurons/day ≈ 12,900 clef-flash calls at ~224 input tokens each),
// while the same model on OpenRouter is billed at $0.14/M. Jev is a
// third-party model on Cloudflare and is NOT covered by that allowance — it
// returns HTTP 402 (code 2021). So: Jev goes through OpenRouter, Clef goes
// through here.
//
// FAIL-SAFE CONTRACT: same as Jev. Advisory only; {ok:false} on any problem.
// Never throws, never fabricates an answer.

import { LLMProvider } from './provider.mjs';

const CF_API = 'https://api.cloudflare.com/client/v4/accounts';
const ALLOWED_MODELS = ['clef', 'clef-flash', 'clef-omni'];
export const DEFAULT_CLEF_MODEL = 'clef-flash';

export function clefEnabled() {
  return process.env.CRUCIX_CLEF_SHADOW !== '0';
}

export class CloudflareClefProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'cloudflare-clef';
    this.accountId = config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || null;
    // Token resolution order. CLOUDFLARE_API_TOKEN is deliberately LAST: Crucix
    // already uses that name for its Cloudflare Radar briefing source, and that
    // token was minted for Radar, not for Workers AI — overwriting it (or
    // trusting it here) would either break briefings or silently 403 the shadow.
    this.apiKey = config.apiKey
      || process.env.CRUCIX_CLEF_TOKEN
      || process.env.CLOUDFLARE_WORKERS_AI_TOKEN
      || process.env.CLOUDFLARE_API_TOKEN
      || null;
    this.model = normaliseModel(config.model ?? process.env.CRUCIX_CLEF_MODEL ?? DEFAULT_CLEF_MODEL);
    this.baseUrl = config.baseUrl || CF_API;
  }

  get isConfigured() { return !!(this.accountId && this.apiKey); }

  /**
   * Ask Clef typed questions about `state`.
   * @returns {Promise<{ok:boolean, answers?:object, latency?:number, error?:string,
   *                    model?:string, provider?:string}>} never throws
   */
  async decide(state, questions, opts = {}) {
    if (!this.isConfigured) return { ok: false, error: 'no CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN' };
    if (this.model === null) {
      return { ok: false, error: `cloudflare serves ${ALLOWED_MODELS.join(', ')}; the requested model is not available there `
        + '(typesafe/jev is third-party and bills outside the free neuron pool)' };
    }
    if (!questions || !Object.keys(questions).length) return { ok: false, error: 'no questions supplied' };

    const url = `${this.baseUrl}/${this.accountId}/ai/run/@cf/cloudflare/${this.model}`;
    const body = {
      model: this.model, // bare name — see header note
      state: typeof state === 'string' ? state : JSON.stringify(state),
      questions,
    };
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout || 30000),
      });
      const latency = (Date.now() - t0) / 1000;
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.substring(0, 200)}`, latency, provider: 'cloudflare' };
      }
      let data;
      try { data = JSON.parse(text); } catch { return { ok: false, error: 'unparseable response', latency }; }
      if (data?.success === false) {
        const msg = data?.errors?.[0]?.message || 'success=false';
        return { ok: false, error: `cloudflare: ${msg}`, latency, provider: 'cloudflare' };
      }
      const answers = data?.result?.answers || {};
      if (!Object.keys(answers).length) return { ok: false, error: 'empty answers', latency, provider: 'cloudflare' };
      return { ok: true, answers, latency, model: this.model, provider: 'cloudflare', neurons: data?.result?.usage?.neurons };
    } catch (err) {
      return { ok: false, error: `${err.name || 'Error'}: ${err.message}`, latency: (Date.now() - t0) / 1000, provider: 'cloudflare' };
    }
  }

  /** LLMProvider compliance — Clef cannot write prose either. */
  async complete(systemPrompt, userMessage, opts = {}) {
    if (!opts.questions) {
      throw new Error('clef: does not generate text; supply opts.questions or use decide()');
    }
    const state = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;
    const r = await this.decide(state, opts.questions, opts);
    if (!r.ok) throw new Error(`clef: ${r.error}`);
    return { text: JSON.stringify(r.answers), usage: { inputTokens: 0, outputTokens: 0 }, model: this.model };
  }
}

/**
 * Accepts `clef-flash`, `@cf/cloudflare/clef-flash` or `cloudflare/clef-flash`.
 * Returns null for a model Cloudflare does not serve — NEVER a substitute. A
 * caller asking for jev must not silently receive clef: every threshold we hold
 * is calibrated per model, so a quiet swap would poison the comparison.
 */
export function normaliseModel(name) {
  const bare = String(name ?? '').split('/').pop() || DEFAULT_CLEF_MODEL;
  return ALLOWED_MODELS.includes(bare) ? bare : null;
}

export default CloudflareClefProvider;