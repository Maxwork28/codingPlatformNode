/**
 * PM2 process file for EC2.
 *
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save && pm2 startup
 *
 * Default: ONE API process in fork mode running the judge locally (JUDGE_MODE=local). Nothing
 * here needs Redis.
 *
 * Scaling (see ../DEPLOY.md "Scaling out"), all opt-in:
 *
 *   1. API cluster mode - only when REDIS_URL is set (Socket.IO Redis adapter + shared rate
 *      limits). Start with:  API_INSTANCES=2 pm2 start ecosystem.config.js --env production
 *      (or API_INSTANCES=max). PM2 cluster balances connections round-robin with NO stickiness,
 *      so Socket.IO clients must connect with transports: ['websocket'] (no long-polling), or run
 *      several fork-mode instances on different PORTs behind an nginx upstream with ip_hash.
 *      In local judge mode each API process gets its own JUDGE_CONCURRENCY budget: keep
 *      instances x JUDGE_CONCURRENCY below the vCPU count, or switch to JUDGE_MODE=queue.
 *
 *   2. Judge workers - JUDGE_MODE=queue on the API (+ REDIS_URL) and one
 *      `algosutra-judge-worker` per judge host (Docker + judge images required there; the API
 *      host then runs no containers). On a judge-only host:
 *          pm2 start ecosystem.config.js --only algosutra-judge-worker --env production
 *      To also run a worker on the API host, start with JUDGE_WORKER=1.
 */

const apiInstances = process.env.API_INSTANCES || '1';
const apiCluster = apiInstances !== '1';
const isOnlyWorker = process.argv.some((a) => /algosutra-judge-worker/.test(a));
const includeWorker = process.env.JUDGE_WORKER === '1' || isOnlyWorker;

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
        kill_timeout: 20000, // give in-flight judge runs time to finish on reload
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
            // Needs REDIS_URL and JUDGE_* in .env; MONGO_URI / JWT_SECRET are not required.
        },
        out_file: `${logDir}/judge-worker.out.log`,
        error_file: `${logDir}/judge-worker.err.log`,
        merge_logs: true,
        time: true,
    });
}

module.exports = { apps };
