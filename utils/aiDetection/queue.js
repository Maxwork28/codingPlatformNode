'use strict';

/** Run at most `concurrency` async functions at a time (FIFO). */
const createLimiter = (concurrency) => {
    let active = 0;
    const waiting = [];
    const next = () => {
        if (active >= concurrency || !waiting.length) return;
        active += 1;
        const { fn, resolve, reject } = waiting.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active -= 1;
                next();
            });
    };
    const run = (fn) =>
        new Promise((resolve, reject) => {
            waiting.push({ fn, resolve, reject });
            next();
        });
    run.stats = () => ({ active, waiting: waiting.length });
    return run;
};

/**
 * Keyed task queue with bounded concurrency and de-duplication:
 *  - a key already waiting is not queued twice;
 *  - a key that is running when pushed again runs once more afterwards (inputs may have changed).
 * Task errors are passed to onError and never thrown.
 */
const createKeyedQueue = ({ concurrency, onError }) => {
    const waiting = new Map(); // key -> fn
    const running = new Set();
    const rerun = new Map(); // key -> fn
    let idleResolvers = [];

    const settleIdle = () => {
        if (!waiting.size && !running.size) {
            idleResolvers.forEach((r) => r());
            idleResolvers = [];
        }
    };

    const pump = () => {
        while (running.size < concurrency && waiting.size) {
            const [key, fn] = waiting.entries().next().value;
            waiting.delete(key);
            running.add(key);
            Promise.resolve()
                .then(fn)
                .catch((err) => {
                    try {
                        onError?.(err, key);
                    } catch {
                        /* ignore */
                    }
                })
                .finally(() => {
                    running.delete(key);
                    if (rerun.has(key)) {
                        const again = rerun.get(key);
                        rerun.delete(key);
                        if (!waiting.has(key)) waiting.set(key, again);
                    }
                    setImmediate(() => {
                        pump();
                        settleIdle();
                    });
                });
        }
    };

    return {
        push(key, fn) {
            if (waiting.has(key)) return false;
            if (running.has(key)) {
                rerun.set(key, fn);
                return true;
            }
            waiting.set(key, fn);
            pump();
            return true;
        },
        stats: () => ({ waiting: waiting.size, running: running.size }),
        /** Resolves when nothing is queued or running (tests). */
        idle: () =>
            new Promise((resolve) => {
                idleResolvers.push(resolve);
                settleIdle();
            }),
    };
};

module.exports = { createLimiter, createKeyedQueue };
