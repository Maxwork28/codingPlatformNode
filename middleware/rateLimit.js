'use strict';

const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('../config/env');

/**
 * Students in one lab share a NAT IP, so judge/API limits key on the bearer token when present
 * (hashed, never stored raw) and fall back to the IP for anonymous traffic.
 */
const tokenOrIpKey = (req) => {
    const header = req.header('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return 'u:' + crypto.createHash('sha256').update(m[1]).digest('base64url').slice(0, 32);
    return 'ip:' + ipKeyGenerator(req.ip);
};

const message = (text) => ({ error: text, code: 'RATE_LIMITED' });

/**
 * Shared store: with REDIS_URL every API process (PM2 cluster workers, several instances) counts
 * against the same per-user/IP budget. Without it, express-rate-limit's in-memory store is used
 * exactly as before. Each limiter needs its own store instance and key prefix.
 */
let redisClient = null;
const makeStore = (name) => {
    if (!config.redisUrl) return undefined; // default MemoryStore
    const { RedisStore } = require('rate-limit-redis');
    if (!redisClient) {
        const { createRedisConnection } = require('../utils/redis');
        redisClient = createRedisConnection(config.redisUrl, { purpose: 'rate-limit' });
    }
    const client = redisClient;

    /**
     * rate-limit-redis caches the SCRIPT LOAD promise from init(); if Redis was down at boot that
     * promise stays rejected forever. Reload the scripts after any failure so limiting resumes
     * once Redis is back, and never leave a rejected promise unhandled.
     */
    class ResilientRedisStore extends RedisStore {
        async init(options) {
            try {
                await super.init(options);
            } catch (err) {
                console.warn(`[rateLimit] Redis store '${name}' not ready (${err?.message}); requests pass until it is`);
            }
        }

        reloadScripts() {
            this.incrementScriptSha = this.loadIncrementScript();
            this.getScriptSha = this.loadGetScript();
            this.incrementScriptSha.catch(() => {});
            this.getScriptSha.catch(() => {});
        }

        async increment(key) {
            try {
                return await super.increment(key);
            } catch (err) {
                this.reloadScripts();
                throw err;
            }
        }
    }

    return new ResilientRedisStore({
        prefix: `${process.env.RATE_LIMIT_REDIS_PREFIX || 'algosutra:rl'}:${name}:`,
        sendCommand: (command, ...args) => client.call(command, ...args),
    });
};

/** If Redis is unreachable, let requests through (logged by express-rate-limit) instead of 500ing. */
const storeOptions = (name) => {
    const store = makeStore(name);
    return store ? { store, passOnStoreError: true } : {};
};

/** Login / forgot / reset: brute-force protection, per IP. */
const authLimiter = rateLimit({
    windowMs: config.rateLimits.authWindowMs,
    limit: config.rateLimits.authMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    ...storeOptions('auth'),
    message: message('Too many attempts. Please wait a few minutes and try again.'),
});

/** Code run / submit / teacher test: per user. */
const judgeLimiter = rateLimit({
    windowMs: config.rateLimits.judgeWindowMs,
    limit: config.rateLimits.judgeMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: tokenOrIpKey,
    ...storeOptions('judge'),
    message: message('You are running code too quickly. Please wait a moment.'),
});

/** Everything else: generous per-user ceiling to stop runaway clients. */
const apiLimiter = rateLimit({
    windowMs: config.rateLimits.apiWindowMs,
    limit: config.rateLimits.apiMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: tokenOrIpKey,
    skip: (req) => req.path === '/health' || req.path === '/health/live',
    ...storeOptions('api'),
    message: message('Too many requests. Please slow down.'),
});

const JUDGE_PATH = /\/(run|run-custom|submit|submit-answer|teacher-test|teacher-test-custom|test-solution)$/;

/** Route-agnostic: applies the judge limiter to any POST that triggers code execution. */
const judgeLimiterIfJudgePath = (req, res, next) =>
    req.method === 'POST' && JUDGE_PATH.test(req.path) ? judgeLimiter(req, res, next) : next();

/** Closes the shared Redis connection (graceful shutdown). */
const closeRateLimitStore = async () => {
    if (!redisClient) return;
    const c = redisClient;
    redisClient = null;
    await c.quit().catch(() => c.disconnect());
};

module.exports = { authLimiter, judgeLimiter, apiLimiter, judgeLimiterIfJudgePath, closeRateLimitStore };
