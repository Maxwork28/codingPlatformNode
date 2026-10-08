'use strict';

/**
 * Judge worker: executes code runs queued by the API when JUDGE_MODE=queue.
 *
 *   node workers/judgeWorker.js
 *
 * Needs only REDIS_URL + JUDGE_* variables (no MongoDB / JWT), Docker, and the judge images
 * (npm run build-docker). Run one worker process per judge host; it takes up to
 * JUDGE_CONCURRENCY jobs at a time, each guarded by the same local semaphore as local mode.
 *
 * SIGTERM / SIGINT (or PM2's 'shutdown' message on Windows): stop taking new jobs, let in-flight
 * runs finish, close the Redis connections, exit.
 */

process.env.CONFIG_ROLE = process.env.CONFIG_ROLE || 'worker';

const path = require('path');
const os = require('os');

// config/env.js loads .env relative to the cwd; make `node workers/judgeWorker.js` from any cwd work.
process.chdir(path.join(__dirname, '..'));
const config = require('../config/env');

const pino = require('pino');
const { Worker, Queue } = require('bullmq');
const { runJudgeDirect, cleanupStaleJudgeArtifacts, dockerHealthy, getJudgeQueueStats } = require('../utils/judge');
const { QUEUE_NAME, JOB_NAME, BUSY_PREFIX } = require('../utils/judgeRemote');
const { redisOptionsFromUrl } = require('../utils/redis');

const logger = pino({ level: config.logLevel, base: { role: 'judge-worker', pid: process.pid } });

const parsePositiveInt = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Same default as utils/judgeQueue.js so the BullMQ concurrency and the local semaphore agree.
const concurrency = parsePositiveInt(process.env.JUDGE_CONCURRENCY, Math.max(1, (os.cpus()?.length || 2) - 1));
const prefix = String(process.env.JUDGE_QUEUE_PREFIX || 'algosutra').trim() || 'algosutra';
const workerName = `${os.hostname()}:${process.pid}`;
const SHUTDOWN_GRACE_MS = parsePositiveInt(process.env.JUDGE_WORKER_SHUTDOWN_MS, 200_000);

const processJob = async (job) => {
    if (job.name !== JOB_NAME) throw new Error(`Unknown judge job type: ${job.name}`);
    const { language, code, testCases, timeLimit, memoryLimit, options, collectRepeatSummaries, startBy } = job.data || {};

    // The API stops waiting after JUDGE_MAX_WAIT_MS; running a run nobody will read wastes a slot.
    if (startBy && Date.now() > startBy) {
        throw new Error(`${BUSY_PREFIX} The code judge is overloaded. Please try again shortly.`);
    }

    const runOptions = { ...(options || {}) };
    if (collectRepeatSummaries) runOptions.repeatSummaries = [];

    const started = Date.now();
    try {
        const results = await runJudgeDirect(language, code, testCases, timeLimit, memoryLimit, runOptions);
        logger.info(
            {
                jobId: job.id,
                language,
                cases: Array.isArray(testCases) ? testCases.length : 0,
                ms: Date.now() - started,
                queuedMs: started - (job.timestamp || started),
            },
            'judge job done'
        );
        return { results, repeatSummaries: collectRepeatSummaries ? runOptions.repeatSummaries : undefined };
    } catch (err) {
        if (err?.code === 'JUDGE_BUSY') throw new Error(`${BUSY_PREFIX} ${err.message}`);
        logger.warn({ jobId: job.id, language, err: err?.message }, 'judge job failed');
        throw err;
    }
};

let worker;
let janitorQueue;
let janitorTimer;
let shuttingDown = false;

/**
 * Finished jobs hold student code and output. The API removes each job once it has the result;
 * this sweep catches the rest (caller crashed / timed out) because BullMQ's age-based
 * removeOnComplete only runs when later jobs complete.
 */
const startJanitor = () => {
    janitorQueue = new Queue(QUEUE_NAME, { connection: redisOptionsFromUrl(config.redisUrl, { maxRetriesPerRequest: 1 }), prefix });
    janitorQueue.on('error', () => {});
    janitorTimer = setInterval(() => {
        Promise.allSettled([
            janitorQueue.clean(60_000, 1000, 'completed'),
            janitorQueue.clean(300_000, 1000, 'failed'),
        ]).catch(() => {});
    }, 30_000);
    janitorTimer.unref();
};

const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, judge: getJudgeQueueStats() }, 'Judge worker shutting down; finishing in-flight jobs');
    const force = setTimeout(() => {
        logger.error('Shutdown grace period exceeded; exiting with jobs still running');
        process.exit(code || 1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    try {
        if (janitorTimer) clearInterval(janitorTimer);
        if (worker) await worker.close(); // waits for active jobs, then closes its Redis connections
        if (janitorQueue) await janitorQueue.close().catch(() => {});
    } catch (err) {
        logger.error({ err }, 'Error while closing judge worker');
    } finally {
        clearTimeout(force);
        logger.info('Judge worker stopped');
        process.exit(code);
    }
};

const start = async () => {
    await cleanupStaleJudgeArtifacts();
    if (!(await dockerHealthy())) {
        logger.warn('Docker daemon is not reachable; jobs will fail until it is');
    }

    worker = new Worker(QUEUE_NAME, processJob, {
        connection: redisOptionsFromUrl(config.redisUrl, { maxRetriesPerRequest: null }),
        prefix,
        concurrency,
        name: workerName,
        // Docker waits keep the event loop free, so lock renewal (every lockDuration/2) is reliable.
        // A crashed worker's lock expires after this; the API then answers 429 for that run.
        lockDuration: 20_000,
        maxStalledCount: 1,
    });

    startJanitor();

    worker.on('ready', () => logger.info({ concurrency, prefix, name: workerName }, 'Judge worker ready'));
    worker.on('error', (err) => logger.error({ err: err?.message }, 'Judge worker error'));
    worker.on('stalled', (jobId) => logger.warn({ jobId }, 'Judge job stalled (worker lost its lock)'));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// PM2 on Windows (and `pm2 reload` with shutdown_with_message) sends a message instead of a signal.
process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown('message');
});
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in judge worker');
    shutdown('uncaughtException', 1);
});

start().catch((err) => {
    logger.fatal({ err }, 'Judge worker failed to start');
    process.exit(1);
});
