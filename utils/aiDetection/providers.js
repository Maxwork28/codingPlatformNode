'use strict';

/**
 * Minimal REST clients (plain fetch, no SDKs) for the providers used to produce AI reference
 * solutions. Only question-derived prompts are ever sent; student code never is.
 *
 *   openai     POST {OPENAI_BASE_URL}/responses                      (Responses API, Bearer key)
 *   gemini     POST {GEMINI_BASE_URL}/models/{model}:generateContent (x-goog-api-key header)
 *   anthropic  POST {ANTHROPIC_BASE_URL}/v1/messages                 (x-api-key + anthropic-version)
 *
 * Every call: per-request timeout, retries with exponential backoff (+ Retry-After) on 429 / 5xx /
 * network errors, a per-process concurrency cap, and automatic removal of optional parameters
 * (temperature, reasoning effort) that a given model rejects with HTTP 400.
 */

const { createLimiter } = require('./queue');

const PROVIDERS = ['openai', 'gemini', 'anthropic'];
const LABELS = { openai: 'ChatGPT (OpenAI)', gemini: 'Gemini (Google)', anthropic: 'Claude (Anthropic)', manual: 'Pasted by a teacher' };
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_OUTPUT_TOKENS = 8192;

let defaultSettings = null;
const settingsOrDefault = (settings) => {
    if (settings) return settings;
    if (!defaultSettings) defaultSettings = require('../../config/env').ai;
    return defaultSettings;
};

/** Providers with an API key configured. */
const enabledProviders = (settings) => {
    const s = settingsOrDefault(settings);
    return PROVIDERS.filter((p) => s[p]?.apiKey);
};

/** Safe-to-expose provider status (never the keys). */
const providerStatus = (settings) => {
    const s = settingsOrDefault(settings);
    return PROVIDERS.map((p) => ({ id: p, label: LABELS[p], enabled: Boolean(s[p]?.apiKey), model: s[p]?.model || null }));
};

const limiters = new Map();
const limiterFor = (settings) => {
    const n = settings.providerConcurrency || 3;
    if (!limiters.has(n)) limiters.set(n, createLimiter(n));
    return limiters.get(n);
};

/** model → Set of optional params it rejected (so later calls skip them). */
const rejectedParams = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const providerError = (message, extra = {}) => Object.assign(new Error(message), extra);

const shortError = (data, text) => {
    const msg = data?.error?.message || data?.error?.status || data?.message || (typeof data?.error === 'string' ? data.error : '') || text || '';
    return String(msg).replace(/\s+/g, ' ').slice(0, 300);
};

/** POST JSON with a timeout. Returns { status, data, text, headers }. */
const postJson = async (url, headers, body, timeoutMs) => {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        /* non-JSON error page */
    }
    return { status: res.status, data, text: data ? '' : text.slice(0, 300), headers: res.headers };
};

// ---------------------------------------------------------------------------
// Request builders / response parsers
// ---------------------------------------------------------------------------

const builders = {
    openai: (s, { system, prompt, temperature }) => ({
        url: `${s.openai.baseUrl}/responses`,
        headers: { Authorization: `Bearer ${s.openai.apiKey}` },
        body: {
            model: s.openai.model,
            instructions: system,
            input: prompt,
            max_output_tokens: MAX_OUTPUT_TOKENS,
            ...(s.openai.reasoningEffort ? { reasoning: { effort: s.openai.reasoningEffort } } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            store: false,
        },
        optional: { temperature: ['temperature'], reasoning: ['reasoning'], store: ['store'] },
        model: s.openai.model,
    }),
    gemini: (s, { system, prompt, temperature }) => ({
        url: `${s.gemini.baseUrl}/models/${encodeURIComponent(s.gemini.model)}:generateContent`,
        headers: { 'x-goog-api-key': s.gemini.apiKey },
        body: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                ...(temperature !== undefined ? { temperature } : {}),
            },
        },
        optional: { temperature: ['generationConfig', 'temperature'] },
        model: s.gemini.model,
    }),
    anthropic: (s, { system, prompt, temperature }) => ({
        url: `${s.anthropic.baseUrl}/v1/messages`,
        headers: { 'x-api-key': s.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
        body: {
            model: s.anthropic.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages: [{ role: 'user', content: prompt }],
            ...(temperature !== undefined ? { temperature: Math.min(1, temperature) } : {}),
        },
        optional: { temperature: ['temperature'] },
        model: s.anthropic.model,
    }),
};

const parsers = {
    openai: (data) => {
        if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
        const parts = [];
        for (const item of data?.output || []) {
            if (item?.type !== 'message') continue;
            for (const c of item.content || []) if (c?.type === 'output_text' && c.text) parts.push(c.text);
        }
        return parts.join('\n');
    },
    gemini: (data) =>
        (data?.candidates?.[0]?.content?.parts || [])
            .filter((p) => p && typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join(''),
    anthropic: (data) =>
        (data?.content || [])
            .filter((c) => c?.type === 'text')
            .map((c) => c.text)
            .join('\n'),
};

const deletePath = (obj, path) => {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i += 1) {
        cur = cur?.[path[i]];
        if (!cur) return false;
    }
    const last = path[path.length - 1];
    if (cur && last in cur) {
        delete cur[last];
        return true;
    }
    return false;
};

/**
 * Ask one provider. Resolves with the reply text; rejects with an Error (message safe to show staff).
 * @param {'openai'|'gemini'|'anthropic'} provider
 * @param {{system: string, prompt: string, temperature?: number}} request
 * @param {object} [settings] config.ai (injected by tests)
 */
const callProvider = (provider, request, settings) => {
    const s = settingsOrDefault(settings);
    if (!builders[provider]) return Promise.reject(providerError(`Unknown provider ${provider}`));
    if (!s[provider]?.apiKey) return Promise.reject(providerError(`${LABELS[provider]} is not configured`));
    return limiterFor(s)(async () => {
        const req = builders[provider](s, request);
        const rejected = rejectedParams.get(`${provider}:${req.model}`) || new Set();
        for (const name of rejected) if (req.optional[name]) deletePath(req.body, req.optional[name]);

        const maxRetries = s.maxRetries ?? 3;
        const baseMs = s.retryBaseMs ?? 1000;
        let attempt = 0;
        let paramDrops = 0;
        for (;;) {
            let res;
            try {
                res = await postJson(req.url, req.headers, req.body, s.requestTimeoutMs || 90_000);
            } catch (err) {
                const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
                if (attempt >= maxRetries) {
                    throw providerError(`${LABELS[provider]}: ${timedOut ? 'request timed out' : `network error (${err?.cause?.code || err?.message || 'failed'})`}`, { retryable: true });
                }
                attempt += 1;
                await sleep(baseMs * 2 ** (attempt - 1) + Math.random() * baseMs * 0.25);
                continue;
            }
            if (res.status >= 200 && res.status < 300) {
                const text = parsers[provider](res.data);
                if (!text || !text.trim()) {
                    const reason = res.data?.candidates?.[0]?.finishReason || res.data?.stop_reason || res.data?.incomplete_details?.reason || res.data?.status;
                    throw providerError(`${LABELS[provider]}: empty reply${reason ? ` (${reason})` : ''}`);
                }
                return text;
            }
            const message = shortError(res.data, res.text);
            // A model that does not accept an optional parameter: drop it and retry right away.
            if (res.status === 400 && paramDrops < 3) {
                const name = Object.keys(req.optional).find((k) => new RegExp(k, 'i').test(message) && deletePath(req.body, req.optional[k]));
                if (name) {
                    paramDrops += 1;
                    rejected.add(name);
                    rejectedParams.set(`${provider}:${req.model}`, rejected);
                    continue;
                }
            }
            if (RETRYABLE.has(res.status) && attempt < maxRetries) {
                attempt += 1;
                const retryAfter = Number(res.headers.get('retry-after'));
                const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : baseMs * 2 ** (attempt - 1) + Math.random() * baseMs * 0.25;
                await sleep(wait);
                continue;
            }
            throw providerError(`${LABELS[provider]}: HTTP ${res.status}${message ? ` – ${message}` : ''}`, { status: res.status, retryable: RETRYABLE.has(res.status) });
        }
    });
};

module.exports = { PROVIDERS, LABELS, enabledProviders, providerStatus, callProvider, parsers, builders };
