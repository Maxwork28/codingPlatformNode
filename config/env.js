'use strict';

/**
 * Single place that reads and validates environment configuration.
 * Fails fast at boot when a production-critical value is missing, so a misconfigured EC2
 * deployment never silently falls back to a public JWT secret or a localhost database.
 */

require('dotenv').config();

/**
 * CONFIG_ROLE=worker (set by workers/judgeWorker.js) skips the API-only checks (MONGO_URI,
 * JWT_SECRET, CORS): a judge worker host only needs REDIS_URL plus the JUDGE_* variables.
 */
const role = String(process.env.CONFIG_ROLE || 'api').trim().toLowerCase() === 'worker' ? 'worker' : 'api';
const isWorker = role === 'worker';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const fail = (message) => {
    console.error(`[config] ${message}`);
    if (!isTest) process.exit(1);
};

const str = (name, fallback) => {
    const v = process.env[name];
    return v === undefined || v === null || v === '' ? fallback : String(v).trim();
};
const int = (name, fallback) => {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) ? n : fallback;
};
const list = (name) =>
    str(name, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const mongoUri = str('MONGO_URI');
if (!mongoUri && !isWorker) fail('MONGO_URI is required');

const jwtSecret = str('JWT_SECRET');
if (isWorker) {
    /* not used by judge workers */
} else if (!jwtSecret) fail('JWT_SECRET is required (generate one: openssl rand -base64 48)');
else if (jwtSecret.length < 32) {
    if (isProd) fail('JWT_SECRET must be at least 32 characters in production');
    else console.warn('[config] JWT_SECRET is shorter than 32 characters; fine for local dev only');
}

const devOrigins = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5176', 'http://127.0.0.1:5173'];
let corsOrigins = list('CORS_ORIGINS');
if (!corsOrigins.length && !isWorker) {
    if (isProd) {
        console.warn('[config] CORS_ORIGINS is empty in production: browsers will be refused. Set it to your frontend origin(s).');
    } else {
        corsOrigins = devOrigins;
    }
}

const redisUrl = str('REDIS_URL', '');

/**
 * JUDGE_MODE:
 *   local (default) - this process runs judge containers itself (in-process semaphore).
 *   queue           - the API enqueues runs on BullMQ (Redis); workers/judgeWorker.js executes them.
 *                     Needs REDIS_URL; without it we fall back to local so nothing breaks.
 */
const requestedJudgeMode = str('JUDGE_MODE', 'local').toLowerCase();
let judgeMode = 'local';
if (requestedJudgeMode === 'queue') {
    if (redisUrl) judgeMode = 'queue';
    else if (!isWorker) console.warn('[config] JUDGE_MODE=queue needs REDIS_URL; falling back to JUDGE_MODE=local');
} else if (requestedJudgeMode !== 'local') {
    console.warn(`[config] Unknown JUDGE_MODE '${requestedJudgeMode}'; using local`);
}
if (isWorker && !redisUrl) fail('REDIS_URL is required for the judge worker');

const config = {
    role,
    isWorker,
    isProd,
    isTest,
    nodeEnv: str('NODE_ENV', 'development'),
    port: int('PORT', 5000),
    mongoUri,
    jwtSecret,
    jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    corsOrigins,
    /** Behind nginx/ALB set TRUST_PROXY=1 so rate limiting sees the real client IP. */
    trustProxy: int('TRUST_PROXY', isProd ? 1 : 0),
    /** Public URL of the React app; used to build password-reset links in emails. */
    publicAppUrl: str('PUBLIC_APP_URL', isProd ? '' : 'http://localhost:5173').replace(/\/$/, ''),
    /**
     * Public URL of this API as browsers and Safe Exam Browser reach it (e.g. https://api.algosutra.co.in).
     * Used for SEB launch links (sebs://...), the SEB URL filter and Config Key checks. When unset it is
     * derived from the request (Host / X-Forwarded-Host) in production, http://localhost:PORT otherwise.
     */
    apiPublicUrl: str('API_PUBLIC_URL', isProd ? '' : `http://localhost:${int('PORT', 5000)}`).replace(/\/+$/, ''),
    redisUrl,
    judgeMode,
    logLevel: str('LOG_LEVEL', isProd ? 'info' : 'debug'),
    bodyLimit: str('BODY_LIMIT', '2mb'),
    rateLimits: {
        authWindowMs: int('RATE_AUTH_WINDOW_MS', 15 * 60 * 1000),
        authMax: int('RATE_AUTH_MAX', 20),
        judgeWindowMs: int('RATE_JUDGE_WINDOW_MS', 60 * 1000),
        judgeMax: int('RATE_JUDGE_MAX', 30),
        apiWindowMs: int('RATE_API_WINDOW_MS', 60 * 1000),
        apiMax: int('RATE_API_MAX', 600),
    },
    // ---- AI-generated-code detection (exam coding answers). All optional: without provider keys,
    // teachers paste reference solutions manually. Keys are never sent to the browser.
    ai: {
        openai: {
            apiKey: str('OPENAI_API_KEY', ''),
            model: str('OPENAI_MODEL', 'gpt-6.1-sol'),
            baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
            /** Responses API reasoning effort; dropped automatically for models that reject it. */
            reasoningEffort: str('OPENAI_REASONING_EFFORT', 'low'),
        },
        gemini: {
            apiKey: str('GEMINI_API_KEY', ''),
            model: str('GEMINI_MODEL', 'gemini-3.8-flash'),
            baseUrl: str('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
        },
        anthropic: {
            apiKey: str('ANTHROPIC_API_KEY', ''),
            model: str('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
            baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''),
        },
        /** Prompt variants generated per provider per language (1–6). */
        variantsPerProvider: Math.min(6, Math.max(1, int('AI_REF_VARIANTS', 3))),
        /** Generate references automatically when the first answer for a question+language arrives. */
        autoGenerate: !/^(0|false|no|off)$/i.test(str('AI_AUTO_GENERATE', '1')),
        /** Submissions checked in parallel (in-process queue). */
        checkConcurrency: Math.max(1, int('AI_CHECK_CONCURRENCY', 2)),
        /** Provider HTTP calls in flight per process. */
        providerConcurrency: Math.max(1, int('AI_PROVIDER_CONCURRENCY', 3)),
        requestTimeoutMs: Math.max(1000, int('AI_REQUEST_TIMEOUT_MS', 90_000)),
        maxRetries: Math.max(0, int('AI_MAX_RETRIES', 3)),
        /** Upper bound on provider calls one "Generate" click may make. */
        maxCallsPerJob: Math.max(1, int('AI_MAX_CALLS_PER_JOB', 150)),
        /** Student code shorter than this (tokens, after removing starter code) → 'too_short'. */
        minTokens: Math.max(5, int('AI_MIN_TOKENS', 25)),
    },
};

module.exports = config;
