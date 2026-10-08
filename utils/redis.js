'use strict';

/**
 * ioredis connection factory shared by the rate-limit store, the BullMQ judge queue and the
 * judge worker. Only loaded when REDIS_URL is set, so a Redis-less deployment never touches it.
 *
 *   blocking: true  -> maxRetriesPerRequest: null (required by BullMQ Worker / QueueEvents, which
 *                      issue blocking reads that must survive reconnects)
 *   blocking: false -> commands fail after one retry instead of queueing forever while Redis is
 *                      down, so callers can degrade (rate limiter passes, judge returns 429).
 */

const Redis = require('ioredis');

const createRedisConnection = (url, { purpose = 'app', blocking = false, logger = console } = {}) => {
    const client = new Redis(url, {
        maxRetriesPerRequest: blocking ? null : 1,
        enableReadyCheck: true,
        connectTimeout: 10_000,
        retryStrategy: (times) => Math.min(times * 250, 5_000),
    });
    // ioredis emits 'error' on every failed reconnect; log at most once per 30 s per connection.
    let lastLog = 0;
    client.on('error', (err) => {
        const now = Date.now();
        if (now - lastLog < 30_000) return;
        lastLog = now;
        const log = typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
        log({ err: err?.message, purpose }, 'Redis connection error');
    });
    return client;
};

/**
 * Plain ioredis options from a redis:// or rediss:// URL. BullMQ is given options (not shared
 * instances) so it owns, duplicates and closes its connections itself.
 */
const redisOptionsFromUrl = (url, extra = {}) => {
    const u = new URL(url);
    const opts = {
        host: u.hostname || '127.0.0.1',
        port: u.port ? Number(u.port) : 6379,
        connectTimeout: 10_000,
        retryStrategy: (times) => Math.min(times * 250, 5_000),
    };
    if (u.username) opts.username = decodeURIComponent(u.username);
    if (u.password) opts.password = decodeURIComponent(u.password);
    const db = Number.parseInt(u.pathname.replace(/^\//, ''), 10);
    if (Number.isFinite(db)) opts.db = db;
    if (u.protocol === 'rediss:') opts.tls = {};
    const family = Number.parseInt(u.searchParams.get('family'), 10);
    if (family === 4 || family === 6) opts.family = family;
    return { ...opts, ...extra };
};

module.exports = { createRedisConnection, redisOptionsFromUrl };
