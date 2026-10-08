'use strict';

/**
 * Distributed judge queue (BullMQ on Redis) used when JUDGE_MODE=queue and REDIS_URL is set.
 *
 * The API process enqueues one job per run/submit and waits for the result; judge worker
 * processes (workers/judgeWorker.js, usually on separate Docker hosts) execute it with the
 * same runner as local mode. The API process never starts containers in this mode.
 *
 * Saturation semantics match the in-process semaphore so controllers need no changes:
 *   - no judge worker online            -> JudgeBusyError immediately (fail fast, never hang)
 *   - waiting jobs >= JUDGE_MAX_QUEUE   -> JudgeBusyError immediately
 *   - not finished within JUDGE_MAX_WAIT_MS + run deadline -> JudgeBusyError('overloaded')
 *   - Redis unreachable                 -> JudgeBusyError (retryable, logged)
 *   - runner errors (missing image, ...) -> plain Error with the worker's message (as in local mode)
 *
 * Job payloads contain student code, so jobs carry an expiry the worker honours, finished jobs
 * are removed within a minute, stale waiting jobs are swept, and the events stream is capped.
 */

const os = require('os');
const { JudgeBusyError } = require('./judgeQueue');

const QUEUE_NAME = 'judge';
const JOB_NAME = 'run';
const BUSY_PREFIX = 'JUDGE_BUSY:';
/** Container create/start/remove + result transfer on top of the runner's own deadline. */
const DEADLINE_SLACK_MS = 15_000;

const parsePositiveInt = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const settings = () => ({
    redisUrl: String(process.env.REDIS_URL || '').trim(),
    prefix: String(process.env.JUDGE_QUEUE_PREFIX || 'algosutra').trim() || 'algosutra',
    maxQueue: parsePositiveInt(process.env.JUDGE_MAX_QUEUE, 100),
    maxWaitMs: parsePositiveInt(process.env.JUDGE_MAX_WAIT_MS, 90_000),
    /** How long a "how many workers are online" answer is reused. */
    workerCacheMs: parsePositiveInt(process.env.JUDGE_WORKER_CHECK_MS, 3_000),
});

let cachedMode = null;
/** 'queue' only when explicitly requested AND Redis is configured; otherwise today's local mode. */
const getJudgeMode = () => {
    if (cachedMode) return cachedMode;
    const requested = String(process.env.JUDGE_MODE || 'local').trim().toLowerCase();
    cachedMode = requested === 'queue' && settings().redisUrl ? 'queue' : 'local';
    return cachedMode;
};

let logger = console;
const setJudgeRemoteLogger = (l) => {
    if (l) logger = l;
};
const warn = (obj, msg) => (typeof logger.warn === 'function' ? logger.warn(obj, msg) : console.warn(msg, obj));

/** Job options shared by producer and documentation: no retries, aggressive removal. */
const jobOptions = () => ({
    attempts: 1,
    removeOnComplete: { age: 60, count: 200 },
    removeOnFail: { age: 300, count: 200 },
});

// ---------------------------------------------------------------------------
// Lazily created Queue + QueueEvents (one pair per API process)
// ---------------------------------------------------------------------------

let statePromise = null;
let sweepTimer = null;

const withTimeout = (promise, ms, message) =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            }
        );
    });

const createState = async () => {
    const { Queue, QueueEvents } = require('bullmq');
    const { redisOptionsFromUrl } = require('./redis');
    const { redisUrl, prefix, maxWaitMs } = settings();

    // Non-blocking commands fail after one retry while Redis is down (-> 429, never a hang);
    // QueueEvents does blocking reads and must use maxRetriesPerRequest: null.
    const queueConn = redisOptionsFromUrl(redisUrl, { maxRetriesPerRequest: 1 });
    const eventsConn = redisOptionsFromUrl(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue(QUEUE_NAME, {
        connection: queueConn,
        prefix,
        // Events carry return values (student output); keep the stream short.
        streams: { events: { maxLen: 500 } },
        defaultJobOptions: jobOptions(),
    });
    const queueEvents = new QueueEvents(QUEUE_NAME, { connection: eventsConn, prefix });
    queue.on('error', (err) => warn({ err: err?.message }, 'Judge queue error'));
    queueEvents.on('error', (err) => warn({ err: err?.message }, 'Judge queue events error'));

    try {
        await withTimeout(
            Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady()]),
            10_000,
            'Timed out connecting to Redis for the judge queue'
        );
    } catch (err) {
        await Promise.allSettled([queueEvents.close(), queue.close()]);
        throw err;
    }

    // Safety net for jobs nobody will ever run (e.g. API crashed after enqueue and no worker is up).
    if (!sweepTimer) {
        sweepTimer = setInterval(() => {
            queue.clean(maxWaitMs + DEADLINE_SLACK_MS, 1000, 'wait').catch(() => {});
        }, 60_000);
        sweepTimer.unref();
    }

    return { queue, queueEvents, workerCache: { at: 0, count: null, pending: null } };
};

const getState = () => {
    if (!statePromise) {
        statePromise = createState().catch((err) => {
            statePromise = null; // retry on the next call
            throw err;
        });
    }
    return statePromise;
};

/** Number of judge worker processes connected to the queue; null when Redis cannot tell us. */
const countWorkers = async (state, { fresh = false } = {}) => {
    const { workerCacheMs } = settings();
    const cache = state.workerCache;
    if (!fresh && Date.now() - cache.at < workerCacheMs) return cache.count;
    if (cache.pending) return cache.pending; // one CLIENT LIST at a time per process
    cache.pending = (async () => {
        let count = null;
        try {
            const workers = await state.queue.getWorkers();
            // GCP Memorystore and some managed Redis disable CLIENT LIST: unknown, not zero.
            const unsupported = workers.length === 1 && /does not support/i.test(workers[0]?.name || '');
            count = unsupported ? null : workers.length;
        } catch {
            count = null;
        }
        cache.at = Date.now();
        cache.count = count;
        return count;
    })();
    try {
        return await cache.pending;
    } finally {
        cache.pending = null;
    }
};

// Admission (worker check + queue-length check + add) is serialised inside this process so a
// burst from one API process cannot all see "queue empty" at once. Across several API
// processes the overshoot is at most (processes - 1) jobs.
let admissionChain = Promise.resolve();
const serialised = (task) => {
    const run = admissionChain.then(task, task);
    admissionChain = run.catch(() => {});
    return run;
};

const toPlainTestCases = (testCases) =>
    (Array.isArray(testCases) ? testCases : []).map((t) => ({
        input: t?.input,
        expectedOutput: t?.expectedOutput,
        isPublic: t?.isPublic,
    }));

/** Options minus non-serialisable / caller-owned fields. */
const toPlainOptions = (options = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(options || {})) {
        if (k === 'repeatSummaries' || typeof v === 'function' || v === undefined) continue;
        out[k] = v;
    }
    return JSON.parse(JSON.stringify(out));
};

const isRedisInfraError = (err) =>
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|Connection is closed|max retries|Redis|Stream isn't writeable/i.test(
        err?.message || ''
    );

/**
 * Enqueue a judge run and wait for its result. Same contract as executeDockerCode.
 * @param {number} runDeadlineMs host-side deadline the runner will apply (estimateJudgeDeadlineMs)
 */
const executeViaQueue = async (language, code, testCases, timeLimit, memoryLimit, options = {}, runDeadlineMs = 60_000) => {
    const { maxQueue, maxWaitMs } = settings();

    let state;
    try {
        state = await getState();
    } catch (err) {
        warn({ err: err?.message }, 'Judge queue unavailable');
        throw new JudgeBusyError('The code judge is temporarily unavailable. Please try again shortly.');
    }

    const now = Date.now();
    const waitBudgetMs = maxWaitMs + runDeadlineMs + DEADLINE_SLACK_MS;
    const data = {
        language,
        code: String(code ?? ''),
        testCases: toPlainTestCases(testCases),
        timeLimit,
        memoryLimit,
        options: toPlainOptions(options),
        collectRepeatSummaries: Array.isArray(options?.repeatSummaries),
        // A worker that picks the job up after this has passed drops it: the caller already gave up.
        startBy: now + maxWaitMs,
        enqueuedAt: now,
        origin: `${os.hostname()}:${process.pid}`,
    };

    let job;
    try {
        job = await serialised(async () => {
            let workers = await countWorkers(state);
            if (workers === 0) workers = await countWorkers(state, { fresh: true }); // a worker may have just started
            if (workers === 0) {
                throw new JudgeBusyError('No code judge workers are online right now. Please try again shortly.');
            }
            const waiting = await state.queue.getWaitingCount();
            if (waiting >= maxQueue) throw new JudgeBusyError();
            return state.queue.add(JOB_NAME, data, jobOptions());
        });
    } catch (err) {
        if (err instanceof JudgeBusyError) throw err;
        warn({ err: err?.message }, 'Failed to enqueue judge job');
        throw new JudgeBusyError('The code judge is temporarily unavailable. Please try again shortly.');
    }

    // Watchdog: if every worker disappears while we wait (crash, scale-in), nobody will finish
    // this job; answer 429 within seconds instead of waiting out the whole budget. A job that is
    // still locked is being finished by a worker that is shutting down gracefully: keep waiting.
    let watchdog = null;
    const isOrphaned = async () => {
        if ((await countWorkers(state)) !== 0) return false;
        const jobState = await job.getState();
        if (jobState === 'completed' || jobState === 'failed') return false; // event is on its way
        if (jobState !== 'active') return true; // waiting/unknown: no worker will pick it up
        const client = await state.queue.client;
        return !(await client.exists(state.queue.toKey(`${job.id}:lock`))); // lock expired: worker died
    };
    const orphaned = new Promise((_resolve, reject) => {
        let checking = false;
        watchdog = setInterval(async () => {
            if (checking) return;
            checking = true;
            try {
                if (await isOrphaned()) {
                    const err = new Error('JUDGE_ORPHANED');
                    err.orphaned = true;
                    reject(err);
                }
            } catch {
                /* Redis hiccup: the overall wait budget still bounds this request */
            } finally {
                checking = false;
            }
        }, Math.max(1_000, settings().workerCacheMs));
        watchdog.unref();
    });
    orphaned.catch(() => {});

    let returnValue;
    try {
        returnValue = await Promise.race([job.waitUntilFinished(state.queueEvents, waitBudgetMs), orphaned]);
    } catch (err) {
        const msg = String(err?.message || '');
        if (err?.orphaned) {
            await job.remove().catch(() => {});
            throw new JudgeBusyError('No code judge workers are online right now. Please try again shortly.');
        }
        if (/timed out before finishing/i.test(msg)) {
            // Still waiting -> drop it so it never runs; active -> it finishes and is auto-removed.
            await job.remove().catch(() => {});
            throw new JudgeBusyError('The code judge is overloaded. Please try again shortly.');
        }
        if (msg.startsWith(BUSY_PREFIX)) {
            throw new JudgeBusyError(msg.slice(BUSY_PREFIX.length).trim() || undefined);
        }
        if (isRedisInfraError(err) && !/docker|image|container/i.test(msg)) {
            warn({ err: msg, jobId: job.id }, 'Judge queue connection problem while waiting');
            throw new JudgeBusyError('The code judge is temporarily unavailable. Please try again shortly.');
        }
        job.remove().catch(() => {});
        throw new Error(msg || 'Judge run failed');
    } finally {
        clearInterval(watchdog);
    }

    // The caller has the result: drop the job (student code + output) now instead of waiting for
    // removeOnComplete's age-based sweep, which only runs when later jobs complete.
    job.remove().catch(() => {});

    const value = typeof returnValue === 'string' ? JSON.parse(returnValue) : returnValue;
    const results = Array.isArray(value?.results) ? value.results : [];
    if (Array.isArray(options?.repeatSummaries) && Array.isArray(value?.repeatSummaries)) {
        options.repeatSummaries.push(...value.repeatSummaries);
    }
    return results;
};

/** Queue stats for /health (queue mode only). Never throws; bounded by a short timeout. */
const getRemoteQueueStats = async () => {
    try {
        const state = await withTimeout(getState(), 3_000, 'judge queue not ready');
        const [counts, workers] = await withTimeout(
            Promise.all([
                state.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
                countWorkers(state, { fresh: true }),
            ]),
            3_000,
            'judge queue stats timed out'
        );
        return { mode: 'queue', redis: 'up', workers, ...counts, maxQueue: settings().maxQueue };
    } catch (err) {
        return { mode: 'queue', redis: 'down', error: err?.message || 'unavailable' };
    }
};

const closeJudgeRemote = async () => {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
    if (!statePromise) return;
    const p = statePromise;
    statePromise = null;
    try {
        const state = await p;
        await Promise.allSettled([state.queueEvents.close(), state.queue.close()]);
    } catch {
        /* never connected */
    }
};

module.exports = {
    QUEUE_NAME,
    JOB_NAME,
    BUSY_PREFIX,
    getJudgeMode,
    executeViaQueue,
    getRemoteQueueStats,
    closeJudgeRemote,
    setJudgeRemoteLogger,
};
