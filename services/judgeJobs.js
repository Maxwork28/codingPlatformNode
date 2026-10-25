'use strict';

/**
 * Judge job queue on MongoDB.
 *
 *   enqueue()      API: create a job (idempotent per client request id), returns at once
 *   publicView()   what the owner may see (status, queue position, result / error)
 *   waitForJob()   wait for a job to finish (staff tools and ?wait=1 callers)
 *   JobWorker      claims jobs by priority, runs the kind's handler (services/judgeKinds.js),
 *                  heartbeats, re-queues jobs of crashed workers, expires stale interactive jobs
 *   JobNotifier    API: reports finished jobs over Socket.IO (owner's user room + staff rooms)
 *
 * Worker placement (JUDGE_WORKER):
 *   inline   (default) the API process also runs a JobWorker - one process, no extra setup
 *   external the API only enqueues; run `node workers/judgeWorker.js` (one per judge host)
 */

const os = require('os');
const { EventEmitter } = require('events');
const JudgeJob = require('../models/JudgeJob');
const JudgeWorker = require('../models/JudgeWorker');
const { JudgeBusyError } = require('../utils/judgeQueue');

const PRIORITY = {
    'exam-run': 90,
    'exam-grade': 80,
    'teacher-test': 60,
    'teacher-custom': 60,
    'staff-rejudge': 55,
    'practice-submit': 50,
    'practice-run': 40,
    'practice-custom': 30,
};
const PRACTICE_KINDS = ['practice-run', 'practice-custom', 'practice-submit'];
/** Never expire while queued and retried after a worker crash: an exam answer must be graded. */
const DURABLE_KINDS = ['exam-grade'];
/** Retries after a worker crash. Practice jobs write a Submission when they finish, so they are not re-run. */
const MAX_ATTEMPTS = { 'exam-grade': 3, 'exam-run': 2, 'teacher-test': 2, 'teacher-custom': 2, 'staff-rejudge': 2 };

const intEnv = (name, fallback) => {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const settings = () => ({
    mode: String(process.env.JUDGE_WORKER || 'inline').trim().toLowerCase() === 'external' ? 'external' : 'inline',
    concurrency: intEnv('JUDGE_CONCURRENCY', Math.max(1, (os.cpus()?.length || 2) - 1)),
    /** Practice jobs allowed to wait; beyond this new practice requests get "judge busy" (429). */
    maxQueue: intEnv('JUDGE_MAX_QUEUE', 300),
    /** A queued Run / exam Run / teacher test older than this is dropped as "judge busy". Submit gets 3x. */
    maxWaitMs: intEnv('JUDGE_MAX_WAIT_MS', 120_000),
    /** Finished jobs (they hold student code) are deleted after this. */
    jobTtlMs: intEnv('JUDGE_JOB_TTL_HOURS', 24) * 3600_000,
});

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Error a handler throws to fail a job with a client-facing status + message. */
class JobError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// API side
// ---------------------------------------------------------------------------

let workersCache = { at: 0, online: false };
const workersOnline = async () => {
    if (Date.now() - workersCache.at < 3_000) return workersCache.online;
    const online = Boolean(await JudgeWorker.exists({ lastSeenAt: { $gte: new Date(Date.now() - 20_000) } }));
    workersCache = { at: Date.now(), online };
    return online;
};

const isDuplicateKey = (err) => err?.code === 11000;

/**
 * @returns {Promise<{ job: object, duplicate?: boolean }>}
 * @throws JudgeBusyError (429) when the practice queue is full or no worker is online (external mode)
 */
const enqueue = async ({ kind, ownerId, clientRequestId, spec, context = {} }) => {
    if (!PRIORITY[kind]) throw new Error(`Unknown judge job kind: ${kind}`);
    const key = typeof clientRequestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId) ? clientRequestId : undefined;
    if (key) {
        const existing = await JudgeJob.findOne({ ownerId, clientRequestId: key }).lean();
        if (existing) return { job: existing, duplicate: true };
    }
    const { maxQueue, mode } = settings();
    if (PRACTICE_KINDS.includes(kind)) {
        const waiting = await JudgeJob.countDocuments({ status: 'queued', kind: { $in: PRACTICE_KINDS } });
        if (waiting >= maxQueue) throw new JudgeBusyError();
    }
    if (mode === 'external' && !DURABLE_KINDS.includes(kind) && !(await workersOnline())) {
        throw new JudgeBusyError('No code judge workers are online right now. Please try again shortly.');
    }
    try {
        const job = await JudgeJob.create({ kind, priority: PRIORITY[kind], ownerId, clientRequestId: key, spec, context });
        bus.emit('enqueued');
        return { job: job.toObject() };
    } catch (err) {
        if (key && isDuplicateKey(err)) {
            const existing = await JudgeJob.findOne({ ownerId, clientRequestId: key }).lean();
            if (existing) return { job: existing, duplicate: true };
        }
        throw err;
    }
};

/** Jobs ahead of this one (higher priority, or same priority and older). */
const queuePosition = async (job) => {
    if (job.status !== 'queued') return 0;
    return JudgeJob.countDocuments({
        status: 'queued',
        $or: [{ priority: { $gt: job.priority } }, { priority: job.priority, createdAt: { $lt: job.createdAt } }],
    });
};

const publicView = (job, extra = {}) => ({
    jobId: String(job._id),
    kind: job.kind,
    status: job.status,
    ...(job.status === 'done' ? { result: job.result ?? null } : {}),
    ...(job.status === 'failed' ? { error: { status: job.error?.status || 500, message: job.error?.message || 'Code execution failed' } } : {}),
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    ...extra,
});

/** Resolve with the job once it is done/failed, or with its latest state after timeoutMs. */
const waitForJob = (jobId, timeoutMs = 120_000) =>
    new Promise((resolve) => {
        const id = String(jobId);
        let settled = false;
        let poll = null;
        let timer = null;
        const finish = (job) => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            clearTimeout(timer);
            bus.removeListener(`done:${id}`, check);
            resolve(job);
        };
        const check = async () => {
            try {
                const job = await JudgeJob.findById(id).lean();
                if (!job || job.status === 'done' || job.status === 'failed') finish(job);
            } catch {
                /* transient DB error: next poll retries */
            }
        };
        bus.on(`done:${id}`, check);
        poll = setInterval(check, 400);
        timer = setTimeout(async () => finish(await JudgeJob.findById(id).lean().catch(() => null)), timeoutMs);
        check();
    });

/**
 * Judge-backed student endpoints answer 202 { jobId, status, position } at once; the result
 * arrives over Socket.IO ('judge:done' in the student's user room) or GET /judge/jobs/:id.
 * ?wait=1 (tools, scripts) keeps the old behaviour: the request waits for the result.
 */
const respondWithJob = async (req, res, job, duplicate) => {
    if (req.query?.wait === '1' || req.body?.wait === true) {
        const done = await waitForJob(job._id, 150_000);
        if (done?.status === 'done') return res.status(200).json(done.result);
        if (done?.status === 'failed') return res.status(done.error?.status || 500).json({ error: done.error?.message || 'Code execution failed' });
        return res.status(202).json(publicView(done || job, { position: await queuePosition(done || job) }));
    }
    return res.status(202).json(publicView(job, { position: await queuePosition(job), ...(duplicate ? { duplicate: true } : {}) }));
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

class JobWorker {
    /**
     * @param {{ handlers: Record<string, Function>, mode?: 'inline'|'external', concurrency?: number, logger?: object }} opts
     */
    constructor({ handlers, mode, concurrency, logger } = {}) {
        const s = settings();
        this.handlers = handlers;
        this.mode = mode || s.mode;
        this.concurrency = concurrency || s.concurrency;
        this.logger = logger || console;
        this.id = `${os.hostname()}:${process.pid}`;
        this.active = new Map(); // jobId -> started ms
        this.stopping = false;
        this.pumping = false;
        this.timers = [];
        this.onEnqueued = () => this.pump();
    }

    async start() {
        bus.on('enqueued', this.onEnqueued);
        await this.heartbeat();
        await this.sweep();
        this.timers.push(setInterval(() => this.pump(), 500));
        this.timers.push(setInterval(() => this.heartbeat(), 5_000));
        this.timers.push(setInterval(() => this.sweep(), 10_000));
        this.timers.forEach((t) => t.unref?.());
        this.pump();
        this.logger.info?.({ worker: this.id, mode: this.mode, concurrency: this.concurrency }, 'Judge worker started');
    }

    async claim() {
        return JudgeJob.findOneAndUpdate(
            { status: 'queued' },
            { $set: { status: 'running', workerId: this.id, startedAt: new Date(), heartbeatAt: new Date() }, $inc: { attempts: 1 } },
            { sort: { priority: -1, createdAt: 1 }, new: true }
        ).lean();
    }

    async pump() {
        if (this.pumping || this.stopping) return;
        this.pumping = true;
        try {
            while (!this.stopping && this.active.size < this.concurrency) {
                const job = await this.claim();
                if (!job) break;
                this.active.set(String(job._id), Date.now());
                this.process(job).finally(() => {
                    this.active.delete(String(job._id));
                    setImmediate(() => this.pump());
                });
            }
        } catch (err) {
            this.logger.warn?.({ err: err?.message }, 'Judge worker could not claim a job');
        } finally {
            this.pumping = false;
        }
    }

    async process(job) {
        const started = Date.now();
        const handler = this.handlers[job.kind];
        let update;
        try {
            if (!handler) throw new JobError(500, `No handler for judge job kind ${job.kind}`);
            const { result, events } = await handler(job);
            update = { status: 'done', result: result ?? null, ...(events?.length ? { events } : {}) };
        } catch (err) {
            const status = Number(err?.status) || 500;
            const message = status < 500 || err instanceof JobError ? err.message : 'Code execution failed';
            if (status >= 500) this.logger.warn?.({ jobId: String(job._id), kind: job.kind, err: err?.message }, 'Judge job failed');
            update = { status: 'failed', error: { status, message: String(message || 'Code execution failed').slice(0, 2000) } };
        }
        const now = new Date();
        // Student code is not kept on finished jobs; the Submission is the permanent record.
        const res = await JudgeJob.updateOne(
            { _id: job._id, status: 'running', workerId: this.id },
            {
                $set: { ...update, finishedAt: now, expireAt: new Date(now.getTime() + settings().jobTtlMs) },
                $unset: { 'spec.code': '', 'spec.customTests': '', 'spec.checker': '', 'context.answer': '' },
            }
        ).catch((err) => {
            this.logger.error?.({ err: err?.message, jobId: String(job._id) }, 'Could not store judge job result');
            return null;
        });
        if (res?.modifiedCount) {
            bus.emit(`done:${job._id}`);
            bus.emit('finished', String(job._id));
        }
        this.logger.debug?.({ jobId: String(job._id), kind: job.kind, status: update.status, ms: Date.now() - started }, 'Judge job finished');
    }

    async heartbeat() {
        const now = new Date();
        try {
            if (this.active.size) {
                await JudgeJob.updateMany({ _id: { $in: [...this.active.keys()] }, workerId: this.id }, { $set: { heartbeatAt: now } });
            }
            await JudgeWorker.updateOne(
                { _id: this.id },
                {
                    $set: { host: os.hostname(), pid: process.pid, mode: this.mode, concurrency: this.concurrency, active: this.active.size, lastSeenAt: now },
                    $setOnInsert: { startedAt: now },
                },
                { upsert: true }
            );
        } catch (err) {
            this.logger.warn?.({ err: err?.message }, 'Judge worker heartbeat failed');
        }
    }

    /** Re-queue (or fail) jobs of crashed workers; drop interactive jobs nobody is waiting for any more. */
    async sweep() {
        const now = Date.now();
        const { maxWaitMs, jobTtlMs } = settings();
        try {
            const stale = await JudgeJob.find({ status: 'running', heartbeatAt: { $lt: new Date(now - 30_000) } })
                .select('_id kind attempts heartbeatAt')
                .lean();
            for (const job of stale) {
                const retry = job.attempts < (MAX_ATTEMPTS[job.kind] || 1);
                await JudgeJob.updateOne(
                    { _id: job._id, status: 'running', heartbeatAt: job.heartbeatAt },
                    retry
                        ? { $set: { status: 'queued' }, $unset: { workerId: '', startedAt: '', heartbeatAt: '' } }
                        : {
                            $set: {
                                status: 'failed',
                                error: { status: 503, message: 'The judge stopped while running your code. Please try again.' },
                                finishedAt: new Date(),
                                expireAt: new Date(now + jobTtlMs),
                            },
                        }
                );
            }
            const expired = { status: 'failed', error: { status: 429, message: 'The code judge is overloaded. Please try again shortly.' }, finishedAt: new Date(), expireAt: new Date(now + jobTtlMs) };
            await JudgeJob.updateMany(
                { status: 'queued', kind: { $nin: [...DURABLE_KINDS, 'practice-submit'] }, createdAt: { $lt: new Date(now - maxWaitMs) } },
                { $set: expired }
            );
            await JudgeJob.updateMany(
                { status: 'queued', kind: 'practice-submit', createdAt: { $lt: new Date(now - 3 * maxWaitMs) } },
                { $set: expired }
            );
        } catch (err) {
            this.logger.warn?.({ err: err?.message }, 'Judge job sweep failed');
        }
    }

    /** Stop claiming, let running jobs finish (up to graceMs). */
    async stop(graceMs = 60_000) {
        this.stopping = true;
        bus.removeListener('enqueued', this.onEnqueued);
        this.timers.forEach(clearInterval);
        const until = Date.now() + graceMs;
        while (this.active.size && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
        await JudgeWorker.deleteOne({ _id: this.id }).catch(() => {});
    }

    stats() {
        return { workerId: this.id, mode: this.mode, concurrency: this.concurrency, active: this.active.size };
    }
}

// ---------------------------------------------------------------------------
// Notifier (API process)
// ---------------------------------------------------------------------------

const MAX_INLINE_RESULT_BYTES = 256 * 1024;

class JobNotifier {
    constructor({ io, logger, intervalMs = 400 } = {}) {
        this.io = io;
        this.logger = logger || console;
        this.intervalMs = intervalMs;
        this.flushing = false;
        this.again = false;
        this.timer = null;
        this.onFinished = () => this.flush();
    }

    start() {
        bus.on('finished', this.onFinished);
        this.timer = setInterval(() => this.flush(), this.intervalMs);
        this.timer.unref?.();
    }

    stop() {
        bus.removeListener('finished', this.onFinished);
        clearInterval(this.timer);
    }

    async flush() {
        if (this.flushing) {
            this.again = true;
            return;
        }
        this.flushing = true;
        try {
            do {
                this.again = false;
                const jobs = await JudgeJob.find({ notifiedAt: null, status: { $in: ['done', 'failed'] } })
                    .sort({ finishedAt: 1 })
                    .limit(100)
                    .lean();
                for (const job of jobs) {
                    const claimed = await JudgeJob.updateOne({ _id: job._id, notifiedAt: null }, { $set: { notifiedAt: new Date() } });
                    if (claimed.modifiedCount) this.emit(job);
                }
            } while (this.again);
        } catch (err) {
            this.logger.warn?.({ err: err?.message }, 'Judge notifier failed');
        } finally {
            this.flushing = false;
        }
    }

    emit(job) {
        if (!this.io) return;
        for (const ev of job.events || []) {
            if (ev?.room && ev?.event) this.io.to(ev.room).emit(ev.event, ev.payload ?? {});
        }
        let view = publicView(job);
        if (view.result && JSON.stringify(view.result).length > MAX_INLINE_RESULT_BYTES) view = { ...view, result: undefined, resultTooLarge: true };
        this.io.to(`user:${job.ownerId}`).emit('judge:done', view);
    }
}

// ---------------------------------------------------------------------------
// Stats (/health)
// ---------------------------------------------------------------------------

const queueStats = async (localWorker = null) => {
    const s = settings();
    const [queued, active, workers] = await Promise.all([
        JudgeJob.countDocuments({ status: 'queued' }),
        JudgeJob.countDocuments({ status: 'running' }),
        JudgeWorker.find({ lastSeenAt: { $gte: new Date(Date.now() - 20_000) } }).select('_id mode concurrency active lastSeenAt').lean(),
    ]);
    return {
        mode: s.mode,
        concurrency: workers.reduce((n, w) => n + (w.concurrency || 0), 0) || (localWorker ? localWorker.concurrency : 0),
        maxQueue: s.maxQueue,
        active,
        queued,
        workers: workers.map((w) => ({ id: w._id, mode: w.mode, concurrency: w.concurrency, active: w.active })),
    };
};

module.exports = {
    PRIORITY,
    PRACTICE_KINDS,
    JobError,
    JobWorker,
    JobNotifier,
    enqueue,
    respondWithJob,
    publicView,
    queuePosition,
    waitForJob,
    queueStats,
    judgeSettings: settings,
    judgeBus: bus,
};
