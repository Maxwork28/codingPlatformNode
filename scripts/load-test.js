#!/usr/bin/env node
'use strict';

/**
 * Load test: how many students and teachers can use the API at the same time, and how fast.
 *
 *   node scripts/load-test.js                 # defaults: 300 students, 20 teachers
 *   STUDENTS=500 TEACHERS=40 node scripts/load-test.js
 *   OUT=results.json node scripts/load-test.js
 *
 * Boots the real API on a throw-away LOCAL MongoDB (smoke-load_<ts>) with rate limits lifted,
 * seeds users / classes / questions through the models, logs everyone in, then runs concurrency
 * ladders per scenario and records latency percentiles, throughput and error rates.
 * Results are written as JSON (default: load-test-results.json next to this script).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MONGO_HOST = process.env.LOAD_MONGO || 'mongodb://127.0.0.1:27017';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(MONGO_HOST)) {
    console.error('LOAD_MONGO must point at a local MongoDB');
    process.exit(2);
}
const DB = `smoke_load_${Date.now()}`;
const MONGO_URI = `${MONGO_HOST.replace(/\/$/, '')}/${DB}`;
const PORT = 5200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'load-test-secret-load-test-secret-load-test-secret';
const STUDENTS = Number(process.env.STUDENTS) || 300;
const TEACHERS = Number(process.env.TEACHERS) || 20;
const CLASSES = Number(process.env.CLASSES) || 5;
const JUDGE_CONCURRENCY = Number(process.env.JUDGE_CONCURRENCY) || Math.max(1, os.cpus().length - 1);
const OUT = process.env.OUT || path.join(__dirname, 'load-test-results.json');
const QUICK = process.env.QUICK === '1';
const LIGHT = process.env.LIGHT === '1';
const pick = (full, light, quick) => (QUICK ? quick : LIGHT ? light : full);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

const results = { meta: {}, scenarios: [] };

const api = async (method, url, { token, body, timeoutMs = 120_000 } = {}) => {
    const t0 = performance.now();
    try {
        const res = await fetch(`${BASE}${url}`, {
            method,
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: res.status, json, ms: performance.now() - t0 };
    } catch (err) {
        return { status: 0, json: null, ms: performance.now() - t0, error: err.name === 'TimeoutError' ? 'timeout' : err.message };
    }
};

/**
 * Run `concurrency` workers for `durationMs` (or `iterations` per worker). Each worker loops calling
 * `step(ctx)`; step returns an array of request samples {label, status, ms} (or one sample).
 */
const runScenario = async ({ name, group, concurrency, durationMs, iterations, contexts, step, note }) => {
    const samples = [];
    const start = performance.now();
    let active = 0;
    const worker = async (i) => {
        const ctx = contexts[i % contexts.length];
        let n = 0;
        while (iterations ? n < iterations : performance.now() - start < durationMs) {
            active += 1;
            const out = await step(ctx, n, i);
            active -= 1;
            for (const s of Array.isArray(out) ? out : [out]) if (s) samples.push(s);
            n += 1;
        }
    };
    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
    const elapsed = (performance.now() - start) / 1000;
    const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
    const lat = ok.map((s) => s.ms);
    const byStatus = {};
    for (const s of samples) byStatus[s.status || 'net'] = (byStatus[s.status || 'net'] || 0) + 1;
    const byLabel = {};
    for (const s of samples) {
        const b = (byLabel[s.label] ||= { count: 0, ok: 0, lat: [] });
        b.count += 1;
        if (s.status >= 200 && s.status < 300) { b.ok += 1; b.lat.push(s.ms); }
    }
    const row = {
        name,
        group,
        concurrency,
        durationSec: round(elapsed),
        requests: samples.length,
        rps: round(samples.length / elapsed),
        okPct: round((ok.length / Math.max(1, samples.length)) * 100),
        p50: round(pct(lat, 50)),
        p95: round(pct(lat, 95)),
        p99: round(pct(lat, 99)),
        max: round(lat.length ? Math.max(...lat) : null),
        mean: round(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null),
        statuses: byStatus,
        endpoints: Object.fromEntries(
            Object.entries(byLabel).map(([k, v]) => [k, { count: v.count, okPct: round((v.ok / v.count) * 100), p50: round(pct(v.lat, 50)), p95: round(pct(v.lat, 95)) }])
        ),
        note,
    };
    results.scenarios.push(row);
    console.log(
        `${name.padEnd(34)} c=${String(concurrency).padStart(4)}  req=${String(row.requests).padStart(6)}  rps=${String(row.rps).padStart(7)}  ok=${String(row.okPct).padStart(5)}%  p50=${String(row.p50).padStart(7)}ms  p95=${String(row.p95).padStart(7)}ms  p99=${String(row.p99).padStart(7)}ms  max=${String(row.max).padStart(7)}ms  ${JSON.stringify(byStatus)}`
    );
    return row;
};

const waitForServer = async (child) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
        try {
            const r = await fetch(`${BASE}/health/live`);
            if (r.ok) return;
        } catch { /* not yet */ }
        await sleep(300);
    }
    throw new Error('server did not start');
};

const healthSnapshot = async () => (await api('GET', '/health')).json;

// ---------------------------------------------------------------------------
(async () => {
    process.env.MONGO_URI = MONGO_URI;
    process.env.JWT_SECRET = JWT_SECRET;
    const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
    const User = require(path.join(ROOT, 'models', 'User'));
    const Class = require(path.join(ROOT, 'models', 'Class'));
    const Question = require(path.join(ROOT, 'models', 'Question'));
    const Exam = require(path.join(ROOT, 'models', 'Exam'));

    results.meta = {
        date: new Date().toISOString(),
        host: { platform: os.platform(), release: os.release(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: round(os.totalmem() / 1e9), node: process.version },
        students: STUDENTS, teachers: TEACHERS, classes: CLASSES, judgeConcurrency: JUDGE_CONCURRENCY,
        note: 'Single machine: load generator, API, MongoDB and Docker judge all share these CPUs. Treat absolute numbers as a lower bound for a dedicated EC2 instance.',
    };

    // ---- seed
    await mongoose.connect(MONGO_URI);
    console.log(`seeding ${DB}: ${STUDENTS} students, ${TEACHERS} teachers, ${CLASSES} classes`);
    const PASSWORD = 'LoadTest!2026';
    const hash = await bcrypt.hash(PASSWORD, 10); // typical production cost; one hash reused for seeding speed
    const admin = await User.create({ name: 'Load Admin', email: 'admin@load.test', role: 'admin', password: hash });
    const teachers = await User.insertMany(Array.from({ length: TEACHERS }, (_, i) => ({ name: `Teacher ${i}`, email: `teacher${i}@load.test`, role: 'teacher', password: hash, canCreateQuestion: true })));
    const students = await User.insertMany(Array.from({ length: STUDENTS }, (_, i) => ({ name: `Student ${i}`, email: `student${i}@load.test`, role: 'student', password: hash })));
    const classes = [];
    for (let c = 0; c < CLASSES; c += 1) {
        const cls = await Class.create({
            name: `Load Class ${c}`,
            createdBy: admin._id,
            teachers: teachers.filter((_, i) => i % CLASSES === c).map((t) => t._id),
            students: students.filter((_, i) => i % CLASSES === c).map((s) => s._id),
        });
        const owner = teachers[c % teachers.length];
        const qs = await Question.insertMany([
            ...Array.from({ length: 6 }, (_, i) => ({
                title: `MCQ ${i} (class ${c})`, description: '<p>Pick the right option.</p>', difficulty: 'easy', type: 'singleCorrectMcq',
                createdBy: owner._id, points: 5, options: ['A', 'B', 'C', 'D'], correctOption: i % 4,
                classes: [{ classId: cls._id, isPublished: true }],
            })),
            ...Array.from({ length: 2 }, (_, i) => ({
                title: `Coding ${i} (class ${c})`, description: '<p>Print the input.</p>', difficulty: 'easy', type: 'coding',
                createdBy: owner._id, points: 10, languages: ['python', 'javascript'], timeLimit: 2, memoryLimit: 128,
                solutionCode: 'print(input())',
                testCases: [
                    { input: '1', expectedOutput: '1', isPublic: true },
                    { input: '2', expectedOutput: '2', isPublic: true },
                    { input: '3', expectedOutput: '3', isPublic: false },
                    { input: '4', expectedOutput: '4', isPublic: false },
                ],
                classes: [{ classId: cls._id, isPublished: true }],
            })),
        ]);
        cls.questions = qs.map((q) => q._id);
        await cls.save();
        const exam = await Exam.create({
            title: `Load Exam ${c}`, classId: cls._id, createdBy: owner._id, status: 'scheduled',
            questions: qs.slice(0, 6).map((q, order) => ({ questionId: q._id, points: 5, order, sectionId: 'main' })),
            sections: [{ sectionId: 'main', title: 'Main', durationSeconds: 0, allowRevisit: true, order: 0 }],
            proctoring: { durationMinutes: 60, autoSubmitOnEnd: true, tabSwitchLimit: 0, allowRunCode: true },
        });
        classes.push({ cls, questions: qs, exam, teacherIds: cls.teachers.map(String), studentIds: cls.students.map(String) });
    }

    // ---- boot API
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: String(PORT),
            MONGO_URI,
            JWT_SECRET,
            CORS_ORIGINS: 'http://localhost:5173',
            LOG_LEVEL: 'warn',
            JUDGE_CONCURRENCY: String(JUDGE_CONCURRENCY),
            JUDGE_MAX_QUEUE: '200',
            JUDGE_TEMP_DIR: process.env.JUDGE_TEMP_DIR || '',
            // Lift per-IP/per-user limits: every virtual user shares one IP here.
            RATE_AUTH_MAX: '1000000', RATE_JUDGE_MAX: '1000000', RATE_API_MAX: '1000000',
            TRUST_PROXY: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => (serverLog += d));
    child.stderr.on('data', (d) => (serverLog += d));

    try {
        await waitForServer(child);
        console.log(`API up on ${BASE} (judge concurrency ${JUDGE_CONCURRENCY})\n`);

        // ---- login everyone (also a login throughput measurement: bcrypt cost 10 per request)
        const tokens = new Map();
        const loginCtx = [...students.map((u) => ({ email: u.email, id: String(u._id), role: 'student' })), ...teachers.map((u) => ({ email: u.email, id: String(u._id), role: 'teacher' })), { email: admin.email, id: String(admin._id), role: 'admin' }];
        let cursor = 0;
        await runScenario({
            name: 'Login (bcrypt cost 10)', group: 'auth', concurrency: 25, iterations: Math.ceil(loginCtx.length / 25), contexts: [{}],
            step: async () => {
                const u = loginCtx[cursor++];
                if (!u) return null;
                const r = await api('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
                if (r.status === 200) tokens.set(u.id, r.json.token);
                return { label: 'POST /auth/login', status: r.status, ms: r.ms };
            },
            note: 'All users log in once; concurrency 25. bcrypt dominates CPU here.',
        });
        const studentCtx = students.map((s, i) => {
            const c = classes[i % CLASSES];
            return { id: String(s._id), token: tokens.get(String(s._id)), cls: c, classId: String(c.cls._id), mcq: c.questions.slice(0, 6), coding: c.questions.slice(6) };
        }).filter((c) => c.token);
        const teacherCtx = teachers.map((t, i) => {
            const c = classes[i % CLASSES];
            return { id: String(t._id), token: tokens.get(String(t._id)), cls: c, classId: String(c.cls._id) };
        }).filter((c) => c.token);
        console.log(`logged in: ${studentCtx.length} students, ${teacherCtx.length} teachers\n`);

        const dur = pick(15_000, 12_000, 6_000);

        // ---- Scenario A: student browsing (read APIs)
        const browse = async (ctx) => {
            const q = ctx.mcq[Math.floor(Math.random() * ctx.mcq.length)];
            const out = [];
            let r = await api('GET', '/auth/me', { token: ctx.token }); out.push({ label: 'GET /auth/me', status: r.status, ms: r.ms });
            r = await api('GET', '/admin/classes', { token: ctx.token }); out.push({ label: 'GET /admin/classes', status: r.status, ms: r.ms });
            r = await api('GET', `/questions/classes/${ctx.classId}/questions`, { token: ctx.token }); out.push({ label: 'GET class questions', status: r.status, ms: r.ms });
            r = await api('GET', `/questions/${q._id}?classId=${ctx.classId}`, { token: ctx.token }); out.push({ label: 'GET question', status: r.status, ms: r.ms });
            r = await api('GET', `/questions/classes/${ctx.classId}/leaderboard`, { token: ctx.token }); out.push({ label: 'GET leaderboard', status: r.status, ms: r.ms });
            r = await api('GET', `/exams/class/${ctx.classId}`, { token: ctx.token }); out.push({ label: 'GET class exams', status: r.status, ms: r.ms });
            await sleep(LIGHT ? 300 + Math.random() * 500 : 200 + Math.random() * 300); // think time
            return out;
        };
        for (const c of pick([25, 50, 100, 200, 300], [25, 50, 100, 150, 200], [50, 200])) {
            await runScenario({ name: 'Students browsing', group: 'browse', concurrency: Math.min(c, studentCtx.length), durationMs: dur, contexts: studentCtx, step: browse, note: '6 read requests per loop + 200-500 ms think time' });
        }

        // ---- Scenario B: teachers on dashboards / reports
        const teach = async (ctx) => {
            const q = ctx.cls.questions[0];
            const out = [];
            let r = await api('GET', '/admin/dashboard?tz=Asia%2FKolkata', { token: ctx.token }); out.push({ label: 'GET /admin/dashboard', status: r.status, ms: r.ms });
            r = await api('GET', '/admin/classes', { token: ctx.token }); out.push({ label: 'GET /admin/classes', status: r.status, ms: r.ms });
            r = await api('GET', `/admin/classes/${ctx.classId}/overview`, { token: ctx.token }); out.push({ label: 'GET class overview', status: r.status, ms: r.ms });
            r = await api('GET', `/admin/classes/${ctx.classId}/participant-stats`, { token: ctx.token }); out.push({ label: 'GET participant-stats', status: r.status, ms: r.ms });
            r = await api('GET', `/questions/classes/${ctx.classId}/leaderboard`, { token: ctx.token }); out.push({ label: 'GET leaderboard', status: r.status, ms: r.ms });
            r = await api('GET', `/questions/classes/${ctx.classId}/questions/${q._id}/report`, { token: ctx.token }); out.push({ label: 'GET question report', status: r.status, ms: r.ms });
            r = await api('GET', '/exams', { token: ctx.token }); out.push({ label: 'GET /exams', status: r.status, ms: r.ms });
            await sleep(300 + Math.random() * 400);
            return out;
        };
        for (const c of pick([5, 10, 20], [5, 10, 20], [10])) {
            await runScenario({ name: 'Teachers on dashboards/reports', group: 'teacher', concurrency: Math.min(c, teacherCtx.length), durationMs: dur, contexts: teacherCtx, step: teach, note: '7 aggregate/report requests per loop + think time' });
        }

        // ---- Scenario C: MCQ submits (write path: Submission + Class $inc + Leaderboard save/retry)
        const mcqSubmit = async (ctx, n) => {
            const q = ctx.mcq[n % ctx.mcq.length];
            const r = await api('POST', `/questions/${q._id}/submit`, { token: ctx.token, body: { answer: n % 4, classId: ctx.classId } });
            await sleep(100 + Math.random() * 200);
            return { label: 'POST submit (MCQ)', status: r.status, ms: r.ms };
        };
        for (const c of pick([50, 100, 200, 300], [50, 100, 150], [100])) {
            await runScenario({ name: 'Students submitting MCQ answers', group: 'mcq', concurrency: Math.min(c, studentCtx.length), durationMs: dur, contexts: studentCtx, step: mcqSubmit, note: 'Writes Submission, Class counters ($inc) and Leaderboard (optimistic concurrency with retry)' });
        }

        // ---- Scenario D: coding runs through the Docker judge (one wave per level)
        const codeRun = async (ctx, n, i) => {
            const q = ctx.coding[i % ctx.coding.length];
            const r = await api('POST', `/questions/${q._id}/run`, { token: ctx.token, body: { answer: 'print(input())', classId: ctx.classId, language: 'python' }, timeoutMs: 180_000 });
            return { label: 'POST run (python)', status: r.status, ms: r.ms };
        };
        const codeSubmit = async (ctx, n, i) => {
            const q = ctx.coding[i % ctx.coding.length];
            const r = await api('POST', `/questions/${q._id}/submit`, { token: ctx.token, body: { answer: 'print(input())', classId: ctx.classId, language: 'python' }, timeoutMs: 180_000 });
            return { label: 'POST submit (coding, 4 tests)', status: r.status, ms: r.ms };
        };
        for (const c of pick([1, 7, 14, 28, 56], [1, 4, 8, 16, 28], [7, 20])) {
            const h0 = await healthSnapshot();
            const row = await runScenario({ name: 'Students running code (judge)', group: 'judge', concurrency: Math.min(c, studentCtx.length), iterations: 1, contexts: studentCtx, step: codeRun, note: `one run each, simultaneously; judge concurrency ${JUDGE_CONCURRENCY}, queue 200` });
            const h1 = await healthSnapshot();
            row.judge = { peakActive: h1?.judge?.peakActive, peakQueued: h1?.judge?.peakQueued, rejected: (h1?.judge?.rejected || 0) - (h0?.judge?.rejected || 0) };
        }
        for (const c of pick([7, 28], [4, 16], [14])) {
            await runScenario({ name: 'Students submitting code (judge)', group: 'judge', concurrency: Math.min(c, studentCtx.length), iterations: 1, contexts: studentCtx, step: codeSubmit, note: 'one submit each (all 4 tests), simultaneously' });
        }

        // ---- Scenario E: exam session (start, 3 saves, heartbeat, submit) per student, simultaneously
        const examSession = async (ctx) => {
            const exam = ctx.cls.exam;
            const out = [];
            let r = await api('POST', `/exams/${exam._id}/start`, { token: ctx.token }); out.push({ label: 'POST exam start', status: r.status, ms: r.ms });
            const attemptId = r.json?.attempt?._id;
            if (!attemptId) return out;
            for (let k = 0; k < 3; k += 1) {
                const q = ctx.mcq[k];
                r = await api('POST', `/exams/${exam._id}/submit-answer`, { token: ctx.token, body: { attemptId, questionId: String(q._id), answer: k % 4 } }); out.push({ label: 'POST exam save answer', status: r.status, ms: r.ms });
                r = await api('POST', `/exams/${exam._id}/events`, { token: ctx.token, body: { attemptId, type: 'heartbeat' } }); out.push({ label: 'POST exam heartbeat', status: r.status, ms: r.ms });
                await sleep(100);
            }
            r = await api('GET', `/exams/${exam._id}/attempt`, { token: ctx.token }); out.push({ label: 'GET exam attempt', status: r.status, ms: r.ms });
            r = await api('POST', `/exams/${exam._id}/submit`, { token: ctx.token, body: { attemptId } }); out.push({ label: 'POST exam submit', status: r.status, ms: r.ms });
            return out;
        };
        // each student may only attempt once: use disjoint slices per level
        let examOffset = 0;
        for (const c of pick([50, 100], [50, 100], [50])) {
            const slice = studentCtx.slice(examOffset, examOffset + c);
            examOffset += c;
            if (!slice.length) break;
            await runScenario({ name: 'Students taking an exam', group: 'exam', concurrency: slice.length, iterations: 1, contexts: slice, step: examSession, note: 'start → 3 answer saves + heartbeats → attempt → submit, all students at once' });
        }

        // ---- Scenario F: mixed realistic classroom
        {
            const mixSamples = [];
            const start = performance.now();
            const until = start + pick(30_000, 25_000, 10_000);
            const MIX = LIGHT ? { browse: 100, mcq: 30, code: 8, teach: 8 } : { browse: 150, mcq: 50, code: 14, teach: 10 };
            const loop = async (fn, ctx) => { let n = 0; while (performance.now() < until) { const out = await fn(ctx, n, n); for (const s of Array.isArray(out) ? out : [out]) if (s) mixSamples.push(s); n += 1; } };
            const browsing = studentCtx.slice(0, MIX.browse).map((ctx) => loop(browse, ctx));
            const submitting = studentCtx.slice(MIX.browse, MIX.browse + MIX.mcq).map((ctx) => loop(mcqSubmit, ctx));
            const coding = studentCtx.slice(MIX.browse + MIX.mcq, MIX.browse + MIX.mcq + MIX.code).map((ctx) => loop(async (c2, n, i) => { const s = await codeRun(c2, n, i); await sleep(2000); return s; }, ctx));
            const teaching = teacherCtx.slice(0, MIX.teach).map((ctx) => loop(teach, ctx));
            await Promise.all([...browsing, ...submitting, ...coding, ...teaching]);
            const elapsed = (performance.now() - start) / 1000;
            const ok = mixSamples.filter((s) => s.status >= 200 && s.status < 300);
            const lat = ok.map((s) => s.ms);
            const byLabel = {};
            for (const s of mixSamples) { const b = (byLabel[s.label] ||= { count: 0, ok: 0, lat: [] }); b.count += 1; if (s.status >= 200 && s.status < 300) { b.ok += 1; b.lat.push(s.ms); } }
            const byStatus = {};
            for (const s of mixSamples) byStatus[s.status || 'net'] = (byStatus[s.status || 'net'] || 0) + 1;
            const row = {
                name: `Mixed classroom (${MIX.browse} browse + ${MIX.mcq} MCQ + ${MIX.code} coding + ${MIX.teach} teachers)`, group: 'mixed', concurrency: MIX.browse + MIX.mcq + MIX.code + MIX.teach, durationSec: round(elapsed),
                requests: mixSamples.length, rps: round(mixSamples.length / elapsed), okPct: round((ok.length / Math.max(1, mixSamples.length)) * 100),
                p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), p99: round(pct(lat, 99)), max: round(lat.length ? Math.max(...lat) : null), mean: round(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null),
                statuses: byStatus,
                endpoints: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, { count: v.count, okPct: round((v.ok / v.count) * 100), p50: round(pct(v.lat, 50)), p95: round(pct(v.lat, 95)) }])),
                note: `All user types at once for ${Math.round(pick(30, 25, 10))} s`,
            };
            results.scenarios.push(row);
            console.log(`${row.name.padEnd(34)} c=${String(row.concurrency).padStart(4)}  req=${String(row.requests).padStart(6)}  rps=${String(row.rps).padStart(7)}  ok=${String(row.okPct).padStart(5)}%  p50=${String(row.p50).padStart(7)}ms  p95=${String(row.p95).padStart(7)}ms  p99=${String(row.p99).padStart(7)}ms  max=${String(row.max).padStart(7)}ms  ${JSON.stringify(byStatus)}`);
        }

        results.meta.finalHealth = await healthSnapshot();
        results.meta.serverMemoryMb = null;
    } catch (err) {
        console.error('LOAD TEST ABORTED:', err.message);
        results.error = err.message;
    } finally {
        child.kill('SIGTERM');
        await sleep(1500);
        try { await mongoose.connection.db.dropDatabase(); } catch { /* ignore */ }
        await mongoose.disconnect();
        fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
        console.log(`\nresults written to ${OUT}`);
        const errLines = serverLog.split('\n').filter((l) => /"level":(50|60)/.test(l)).slice(-5);
        if (errLines.length) console.log('server errors:\n' + errLines.join('\n'));
        process.exit(results.error ? 1 : 0);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
