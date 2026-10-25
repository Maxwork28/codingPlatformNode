'use strict';

/**
 * Judge worker: runs queued Run / Submit / exam-grading jobs when the API uses JUDGE_WORKER=external.
 *
 *   node workers/judgeWorker.js
 *
 * Needs MONGO_URI (the job queue is the judgejobs collection), Docker, the judge images
 * (npm run build-docker) and the JUDGE_* variables. Takes up to JUDGE_CONCURRENCY jobs at a time,
 * highest priority first (exam Run > exam grading > teacher tests > Submit > Run > custom input).
 * Run one worker process per judge host; several hosts can share one database.
 *
 * SIGTERM / SIGINT (or PM2's 'shutdown' message on Windows): stop taking new jobs, let running
 * jobs finish, exit. A worker that dies mid-job is detected by its heartbeat: exam grading and
 * staff jobs are re-queued, practice jobs fail with "please try again".
 */

process.env.CONFIG_ROLE = process.env.CONFIG_ROLE || 'worker';

const path = require('path');

// config/env.js loads .env relative to the cwd; make `node workers/judgeWorker.js` from any cwd work.
process.chdir(path.join(__dirname, '..'));
const config = require('../config/env');

const mongoose = require('mongoose');
const pino = require('pino');
const { cleanupStaleJudgeArtifacts, dockerHealthy, calibrateLanguages } = require('../utils/judge');
const { JobWorker } = require('../services/judgeJobs');
const { handlers } = require('../services/judgeKinds');

const logger = pino({ level: config.logLevel, base: { role: 'judge-worker', pid: process.pid } });
const SHUTDOWN_GRACE_MS = Number.parseInt(process.env.JUDGE_WORKER_SHUTDOWN_MS, 10) || 200_000;

let worker;
let shuttingDown = false;

const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, judge: worker?.stats() }, 'Judge worker shutting down; finishing running jobs');
    const force = setTimeout(() => {
        logger.error('Shutdown grace period exceeded; exiting with jobs still running');
        process.exit(code || 1);
    }, SHUTDOWN_GRACE_MS + 5_000);
    force.unref();
    try {
        if (worker) await worker.stop(SHUTDOWN_GRACE_MS);
        await mongoose.disconnect();
    } catch (err) {
        logger.error({ err }, 'Error while stopping judge worker');
    } finally {
        clearTimeout(force);
        logger.info('Judge worker stopped');
        process.exit(code);
    }
};

const start = async () => {
    mongoose.set('strictQuery', true);
    await mongoose.connect(config.mongoUri, {
        maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 10,
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
    });
    logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
    await cleanupStaleJudgeArtifacts();
    if (!(await dockerHealthy())) logger.warn('Docker daemon is not reachable; jobs will fail until it is');

    worker = new JobWorker({ handlers, mode: 'external', logger });
    await worker.start();
    calibrateLanguages()
        .then((ms) => logger.info({ baselinesMs: ms }, 'Judge start-up baselines measured'))
        .catch(() => {});
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
