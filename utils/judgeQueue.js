'use strict';

/**
 * Bounded concurrency gate for Docker judge runs.
 *
 * Every run/submit used to start its own container with no limit, so N students
 * clicking "Run" at once meant N containers each allowed `memoryLimit` MB and
 * `timeLimit` CPUs. This gate caps simultaneous containers to JUDGE_CONCURRENCY
 * (default: vCPUs - 1) and rejects with a 429-style error once JUDGE_MAX_QUEUE
 * requests are already waiting, so the API host itself never gets OOM-killed.
 */

const os = require('os');

class JudgeBusyError extends Error {
    constructor(message) {
        super(message || 'The code judge is busy right now. Please try again in a few seconds.');
        this.name = 'JudgeBusyError';
        this.status = 429;
        this.code = 'JUDGE_BUSY';
    }
}

const parsePositiveInt = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const concurrency = parsePositiveInt(
    process.env.JUDGE_CONCURRENCY,
    Math.max(1, (os.cpus()?.length || 2) - 1)
);
const maxQueue = parsePositiveInt(process.env.JUDGE_MAX_QUEUE, 100);
const maxWaitMs = parsePositiveInt(process.env.JUDGE_MAX_WAIT_MS, 90_000);

let active = 0;
const waiting = [];
const stats = { started: 0, completed: 0, rejected: 0, timedOutWaiting: 0, peakActive: 0, peakQueued: 0 };

const pump = () => {
    while (active < concurrency && waiting.length > 0) {
        const next = waiting.shift();
        if (next.settled) continue;
        clearTimeout(next.timer);
        next.settled = true;
        active += 1;
        stats.started += 1;
        stats.peakActive = Math.max(stats.peakActive, active);
        next.resolve();
    }
};

const acquire = () =>
    new Promise((resolve, reject) => {
        if (active < concurrency && waiting.length === 0) {
            active += 1;
            stats.started += 1;
            stats.peakActive = Math.max(stats.peakActive, active);
            return resolve();
        }
        if (waiting.length >= maxQueue) {
            stats.rejected += 1;
            return reject(new JudgeBusyError());
        }
        const entry = { resolve, settled: false, timer: null };
        entry.timer = setTimeout(() => {
            if (entry.settled) return;
            entry.settled = true;
            const idx = waiting.indexOf(entry);
            if (idx !== -1) waiting.splice(idx, 1);
            stats.timedOutWaiting += 1;
            reject(new JudgeBusyError('The code judge is overloaded. Please try again shortly.'));
        }, maxWaitMs);
        waiting.push(entry);
        stats.peakQueued = Math.max(stats.peakQueued, waiting.length);
    });

const release = () => {
    active = Math.max(0, active - 1);
    stats.completed += 1;
    pump();
};

/** Run `task` once a judge slot is free. Rejects with JudgeBusyError when saturated. */
const runWithSlot = async (task) => {
    await acquire();
    try {
        return await task();
    } finally {
        release();
    }
};

const getJudgeQueueStats = () => ({
    concurrency,
    maxQueue,
    active,
    queued: waiting.length,
    ...stats,
});

module.exports = { runWithSlot, getJudgeQueueStats, JudgeBusyError };
