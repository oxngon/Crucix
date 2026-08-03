// OpenAI Provider — raw fetch, no SDK
// Supports custom baseUrl (OpenAI-compatible endpoints) and apiKeyFile
// (a JSON file containing {access_token} — read fresh per request, used for
// rotating tokens like Hermes' Nous auth).

import { readFileSync } from 'node:fs';
import { LLMProvider } from './provider.mjs';

export class OpenAIProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'openai';
    this.apiKey = config.apiKey;
    this.apiKeyFile = config.apiKeyFile || null;
    this.baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = config.model || 'gpt-5.4';
  }

  get isConfigured() { return !!(this.apiKey || this.apiKeyFile); }

  _resolveApiKey() {
    if (this.apiKeyFile) {
      try {
        const auth = JSON.parse(readFileSync(this.apiKeyFile, 'utf8'));
        if (auth.access_token) return auth.access_token;
      } catch (err) {
        console.error(`[OpenAI] Failed to read apiKeyFile ${this.apiKeyFile}:`, err.message);
      }
    }
    return this.apiKey;
  }

  async complete(systemPrompt, userMessage, opts = {}) {
    const apiKey = this._resolveApiKey();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens || 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}
