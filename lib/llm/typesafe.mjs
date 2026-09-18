// TypeSafe Jev Provider — structured decisions, not text generation.
//
// Jev (typesafe/jev-1.13) is a "System One" model: you give it unstructured
// `state` plus typed `questions`, and it returns calibrated probabilities.
// There is no prose and no rationale, which is the point — the answer cannot be
// malformed, cannot invent an undeclared field, and needs no JSON parsing.
//
//   POST https://openrouter.ai/api/alpha/decisions     (NOT /chat/completions)
//   {model, state, questions} -> {answers: {<name>: {...}}}
//
// Question types:
//   noul   -> {noul: P(true) in 0..1}          yes/no as a probability
//   choice -> {choice, probabilities}          pick one of `criteria` keys
//   score  -> {score}                          position on an ordered rubric
//
// IMPORTANT — do NOT set LLM_PROVIDER=typesafe for the whole app: Crucix also
// uses its provider for generative work (briefings), which Jev cannot do.
// Jev is meant to be used alongside the generative provider, for decisions only
// (see lib/alerts/jev-triage.mjs). It is registered here so it can be selected
// explicitly, and so tests/pilots can instantiate it directly.
//
// Measured 2026-09-18: 0.18-0.34s per decision, ~$0.00002 each.

import { LLMProvider } from './provider.mjs';

const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';

export class TypesafeJevProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'typesafe';
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || null;
    this.model = config.model || DEFAULT_MODEL;
    this.baseUrl = config.baseUrl || DECISIONS_ENDPOINT;
  }

  get isConfigured() { return !!this.apiKey; }

  /**
   * Ask Jev typed questions about `state`.
   * @param {string|object} state - unstructured material to judge
   * @param {object} questions - {name: {type, instructions, criteria}}
   * @returns {Promise<{ok: boolean, answers?: object, latency?: number, error?: string, cost?: number}>}
   *          Never throws: an unavailable Jev yields {ok:false}, never a fake verdict.
   */
  async decide(state, questions, opts = {}) {
    if (!this.isConfigured) return { ok: false, error: 'no api key' };
    if (!questions || !Object.keys(questions).length) {
      return { ok: false, error: 'no questions supplied' };
    }
    const body = {
      model: this.model,
      state: typeof state === 'string' ? state : JSON.stringify(state),
      questions,
    };
    const t0 = Date.now();
    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout || 30000),
      });
      const latency = (Date.now() - t0) / 1000;
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${err.substring(0, 200)}`, latency };
      }
      const data = await res.json();
      const answers = data?.answers || {};
      if (!Object.keys(answers).length) {
        return { ok: false, error: 'empty answers', latency };
      }
      return { ok: true, answers, latency, cost: data?.usage?.cost, model: this.model };
    } catch (err) {
      return { ok: false, error: `${err.name || 'Error'}: ${err.message}`, latency: (Date.now() - t0) / 1000 };
    }
  }

  /**
   * LLMProvider interface compliance. Jev cannot generate prose, so this is only
   * meaningful when opts.questions is supplied — it then returns the answers
   * serialised as text. Prefer decide() in new code.
   */
  async complete(systemPrompt, userMessage, opts = {}) {
    if (!opts.questions) {
      throw new Error('typesafe: Jev does not generate text; supply opts.questions or use decide()');
    }
    const state = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;
    const r = await this.decide(state, opts.questions, opts);
    if (!r.ok) throw new Error(`typesafe: ${r.error}`);
    return { text: JSON.stringify(r.answers), usage: { inputTokens: 0, outputTokens: 0 }, model: this.model };
  }
}

export default TypesafeJevProvider;
