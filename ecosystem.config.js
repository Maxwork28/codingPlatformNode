/**
 * PM2 process file for EC2.
 *
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save && pm2 startup
 *
 * Default: ONE API process in fork mode that also runs the judge worker (JUDGE_WORKER=inline).
 * The judge job queue lives in MongoDB, so nothing here needs Redis.
 *
 * Scaling (see ../DEPLOY.md "Scaling out"), all opt-in:
 *
 *   1. API cluster mode - only when REDIS_URL is set (Socket.IO Redis adapter + shared rate
 *      limits). Start with:  API_INSTANCES=2 pm2 start ecosystem.config.js --env production
 *      (or API_INSTANCES=max). PM2 cluster balances connections round-robin with NO stickiness,
 *      so Socket.IO clients must connect with transports: ['websocket'] (no long-polling), or run
 *      several fork-mode instances on different PORTs behind an nginx upstream with ip_hash.
 *      With JUDGE_WORKER=inline every API process runs its own worker: keep
 *      instances x JUDGE_CONCURRENCY below the vCPU count, or use external workers.
 *
 *   2. Separate judge worker process - set JUDGE_WORKER=external in .env. The API then only
 *      queues jobs and this file also starts `algosutra-judge-worker` (Docker + judge images
 *      needed on that host). On a judge-only host (same MONGO_URI):
 *          pm2 start ecosystem.config.js --only algosutra-judge-worker --env production
 */

const apiInstances = process.env.API_INSTANCES || '1';
const apiCluster = apiInstances !== '1';
const isOnlyWorker = process.argv.some((a) => /algosutra-judge-worker/.test(a));
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const includeWorker = String(process.env.JUDGE_WORKER || '').toLowerCase() === 'external' || isOnlyWorker;

const logDir = process.env.PM2_LOG_DIR || '/var/log/algosutra';

const apps = [
    {
        name: 'algosutra-api',
        script: 'server.js',
        cwd: __dirname,
        instances: apiCluster ? (apiInstances === 'max' ? 'max' : Number(apiInstances)) : 1,
        exec_mode: apiCluster ? 'cluster' : 'fork',
        autorestart: true,
        max_memory_restart: '1G',
        kill_timeout: 20000, // inline worker: running jobs finish or are re-queued on reload
        listen_timeout: 15000,
        wait_ready: false,
        env: {
            NODE_ENV: 'development',
        },
        env_production: {
            NODE_ENV: 'production',
            // All other values come from .env (loaded by config/env.js).
        },
        out_file: `${logDir}/api.out.log`,
        error_file: `${logDir}/api.err.log`,
        merge_logs: true,
        time: true,
    },
];

if (includeWorker) {
    apps.push({
        name: 'algosutra-judge-worker',
        script: 'workers/judgeWorker.js',
        cwd: __dirname,
        // One process per host; it runs JUDGE_CONCURRENCY containers in parallel (default vCPUs - 1).
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        max_memory_restart: '512M',
        // SIGTERM -> stop taking jobs, finish in-flight runs (up to JUDGE_MAX_RUN_MS), then exit.
        kill_timeout: 200000,
        shutdown_with_message: process.platform === 'win32',
        env: {
            NODE_ENV: 'development',
            CONFIG_ROLE: 'worker',
        },
        env_production: {
            NODE_ENV: 'production',
            CONFIG_ROLE: 'worker',
            // Needs MONGO_URI and JUDGE_* in .env; JWT_SECRET / CORS are not required.
        },
        out_file: `${logDir}/judge-worker.out.log`,
        error_file: `${logDir}/judge-worker.err.log`,
        merge_logs: true,
        time: true,
    });
}

module.exports = { apps };
