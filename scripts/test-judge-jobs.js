#!/usr/bin/env node
'use strict';

/**
 * Judge job queue checks against a throw-away LOCAL MongoDB (+ Docker for the exam part):
 *   node scripts/test-judge-jobs.js
 *
 * Part 1 (queue mechanics, fake handlers): priority order, idempotent enqueue, crash recovery
 *   (exam grading re-queued, practice failed), expiry of stale interactive jobs, practice queue limit.
 * Part 2 (real server + judge): exam time-up - 8 students save a slow coding answer at the same
 *   moment with a 1-slot judge and the attempts are closed right away: every answer is saved, then
 *   graded in the background, and the closed attempts' totals are updated. A re-save supersedes the
 *   earlier grade.
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MONGO_HOST = process.env.TEST_MONGO || 'mongodb://127.0.0.1:27017';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(MONGO_HOST)) {
    console.error('TEST_MONGO must point at a local MongoDB');
    process.exit(2);
}
const DB = `judge_jobs_test_${Date.now()}`;
const MONGO_URI = `${MONGO_HOST.replace(/\/$/, '')}/${DB}`;
process.env.MONGO_URI = MONGO_URI; // never the .env database
process.env.JWT_SECRET = 'judge-jobs-test-secret-judge-jobs-test-secret';
const PORT = 6100 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${BASE}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        json = null;
    }
    return { status: res.status, json };
};

(async () => {
    await mongoose.connect(MONGO_URI);
    const JudgeJob = require('../models/JudgeJob');
    await JudgeJob.syncIndexes();
    const jobs = require('../services/judgeJobs');
    const owner = new mongoose.Types.ObjectId();

    // ================= Part 1: queue mechanics with fake handlers
    {
        const order = [];
        const fake = async (job) => {
            order.push(job.kind);
            await sleep(30);
            return { result: { ok: job.kind } };
        };
        const handlers = Object.fromEntries(Object.keys(jobs.PRIORITY).map((k) => [k, fake]));
        for (const kind of ['practice-custom', 'practice-run', 'practice-submit', 'exam-grade', 'exam-run']) {
            await jobs.enqueue({ kind, ownerId: owner, spec: {} });
        }
        const worker = new jobs.JobWorker({ handlers, mode: 'inline', concurrency: 1, logger: { info() {}, warn() {}, debug() {}, error() {} } });
        await worker.start();
        for (let i = 0; i < 100 && order.length < 5; i += 1) await sleep(50);
        check('jobs run by priority: exam run > exam grading > submit > run > custom', order.join(',') === 'exam-run,exam-grade,practice-submit,practice-run,practice-custom', order.join(','));

        const a = await jobs.enqueue({ kind: 'practice-run', ownerId: owner, clientRequestId: 'same-click-0001', spec: {} });
        const b = await jobs.enqueue({ kind: 'practice-run', ownerId: owner, clientRequestId: 'same-click-0001', spec: {} });
        check('same clientRequestId -> same job, flagged duplicate', String(a.job._id) === String(b.job._id) && b.duplicate === true);
        const done = await jobs.waitForJob(a.job._id, 5000);
        check('waitForJob resolves with the finished job', done?.status === 'done' && done.result?.ok === 'practice-run');
        check('finished job drops the student code and gets an expiry', done && done.spec?.code === undefined && done.expireAt instanceof Date);
        await worker.stop(2000);

        // crash recovery: running jobs whose worker stopped heart-beating
        const old = new Date(Date.now() - 60_000);
        const grade = await JudgeJob.create({ kind: 'exam-grade', priority: 80, ownerId: owner, spec: {}, status: 'running', attempts: 1, workerId: 'dead:1', heartbeatAt: old, startedAt: old });
        const prac = await JudgeJob.create({ kind: 'practice-submit', priority: 50, ownerId: owner, spec: {}, status: 'running', attempts: 1, workerId: 'dead:1', heartbeatAt: old, startedAt: old });
        const stale = await JudgeJob.create({ kind: 'practice-run', priority: 40, ownerId: owner, spec: {}, status: 'queued', createdAt: new Date(Date.now() - 10 * 60_000) });
        const staleGrade = await JudgeJob.create({ kind: 'exam-grade', priority: 80, ownerId: owner, spec: {}, status: 'queued', createdAt: new Date(Date.now() - 60 * 60_000) });
        const sweeper = new jobs.JobWorker({ handlers: {}, concurrency: 1, logger: { info() {}, warn() {}, debug() {}, error() {} } });
        await sweeper.sweep();
        const [g, p, s, sg] = await Promise.all([grade, prac, stale, staleGrade].map((j) => JudgeJob.findById(j._id).lean()));
        check('crashed worker: exam grading is re-queued', g.status === 'queued' && !g.workerId, g.status);
        check('crashed worker: practice submit fails with "try again" (never judged twice)', p.status === 'failed' && p.error?.status === 503, `${p.status} ${p.error?.message}`);
        check('stale queued Run expires as "judge busy"', s.status === 'failed' && s.error?.status === 429, s.status);
        check('queued exam grading never expires', sg.status === 'queued');
        await JudgeJob.deleteMany({});

        // practice queue limit
        process.env.JUDGE_MAX_QUEUE = '2';
        await jobs.enqueue({ kind: 'practice-run', ownerId: owner, spec: {} });
        await jobs.enqueue({ kind: 'practice-run', ownerId: owner, spec: {} });
        let busy = null;
        try {
            await jobs.enqueue({ kind: 'practice-run', ownerId: owner, spec: {} });
        } catch (err) {
            busy = err;
        }
        const examOk = await jobs.enqueue({ kind: 'exam-grade', ownerId: owner, spec: {} }).then(() => true, () => false);
        check('full practice queue -> 429 JUDGE_BUSY; exam grading still accepted', busy?.status === 429 && examOk, busy?.message);
        delete process.env.JUDGE_MAX_QUEUE;
        await JudgeJob.deleteMany({});
    }

    // ================= Part 2: exam time-up through the real server
    const User = require('../models/User');
    const Class = require('../models/Class');
    const Question = require('../models/Question');
    const ExamAttempt = require('../models/ExamAttempt');
    const hash = await bcrypt.hash('Passw0rd!jobs', 10);
    const teacher = await User.create({ name: 'T', email: 't@jobs.test', role: 'teacher', password: hash, canCreateQuestion: true });
    const students = await User.insertMany(Array.from({ length: 8 }, (_, i) => ({ name: `S${i}`, email: `s${i}@jobs.test`, role: 'student', password: hash })));
    const cls = await Class.create({ name: 'Jobs', createdBy: teacher._id, teachers: [teacher._id], students: students.map((s) => s._id) });
    const q = await Question.create({
        title: 'Echo slow', description: '<p>x</p>', difficulty: 'easy', type: 'coding', createdBy: teacher._id, points: 10,
        languages: ['python'], timeLimit: 2, memoryLimit: 128,
        testCases: [{ input: '1', expectedOutput: '1', isPublic: true }, { input: '2', expectedOutput: '2', isPublic: false }],
        classes: [{ classId: cls._id, isPublished: true }],
    });
    cls.questions = [q._id];
    await cls.save();

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), MONGO_URI, JWT_SECRET: process.env.JWT_SECRET, CORS_ORIGINS: 'http://localhost:5173', LOG_LEVEL: 'warn', JUDGE_CONCURRENCY: '1', RATE_AUTH_MAX: '1000', RATE_JUDGE_MAX: '1000', REDIS_URL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    try {
        for (let i = 0; i < 120; i += 1) {
            try {
                if ((await fetch(`${BASE}/health/live`)).ok) break;
            } catch {
                /* starting */
            }
            await sleep(300);
        }
        const login = async (email) => (await api('POST', '/auth/login', { body: { email, password: 'Passw0rd!jobs' } })).json.token;
        const tTok = await login('t@jobs.test');
        const sToks = await Promise.all(students.map((s) => login(s.email)));
        const create = await api('POST', '/exams', { token: tTok, body: { title: 'Time-up', classId: String(cls._id), questions: [{ questionId: String(q._id), points: 10 }], proctoring: { durationMinutes: 30 }, status: 'scheduled' } });
        const examId = create.json.exam?._id || create.json._id;
        const starts = await Promise.all(sToks.map((tok) => api('POST', `/exams/${examId}/start`, { token: tok })));
        const attemptIds = starts.map((r) => r.json.attempt?._id);
        check('8 students started the exam', attemptIds.every(Boolean), starts.map((r) => r.status).join(','));

        // Student 0 saves twice: the second save must win.
        const slow = 'import time\ntime.sleep(0.4)\nprint(input())';
        const first = await api('POST', `/exams/${examId}/submit-answer`, { token: sToks[0], body: { attemptId: attemptIds[0], questionId: String(q._id), answer: 'print(0)', language: 'python' } });

        const t0 = Date.now();
        const saves = await Promise.all(sToks.map((tok, i) => api('POST', `/exams/${examId}/submit-answer`, { token: tok, body: { attemptId: attemptIds[i], questionId: String(q._id), answer: slow, language: 'python' } })));
        const saveMs = Date.now() - t0;
        check('8 last-second coding saves all succeed at once (no judge wait)', saves.every((r) => r.status === 200 && r.json.gradingStatus === 'pending'), `${saves.map((r) => r.status).join(',')} in ${saveMs} ms`);
        check('saving did not wait for the judge (1 slot, 9 jobs x ~1 s)', saveMs < 3000, `${saveMs} ms`);

        const fins = await Promise.all(sToks.map((tok, i) => api('POST', `/exams/${examId}/submit`, { token: tok, body: { attemptId: attemptIds[i] } })));
        check('attempts closed immediately after the saves', fins.every((r) => r.status === 200), fins.map((r) => r.status).join(','));
        const closedEarly = await ExamAttempt.find({ _id: { $in: attemptIds } }).lean();
        check('closed attempts keep the latest code with grading pending', closedEarly.every((a) => a.answers[0]?.answer === slow && a.answers[0]?.gradingStatus === 'pending'), closedEarly.map((a) => a.answers[0]?.gradingStatus).join(','));

        let graded = [];
        for (let i = 0; i < 240; i += 1) {
            graded = await ExamAttempt.find({ _id: { $in: attemptIds } }).lean();
            if (graded.every((a) => a.answers[0]?.gradingStatus === 'done')) break;
            await sleep(500);
        }
        check('every answer graded in the background after the exam closed', graded.every((a) => a.answers[0]?.gradingStatus === 'done' && a.answers[0].score === 10), graded.map((a) => `${a.answers[0]?.gradingStatus}/${a.answers[0]?.score}`).join(','));
        check('closed attempts total updated to the graded score', graded.every((a) => a.totalScore === 10), graded.map((a) => a.totalScore).join(','));
        const firstJob = await JudgeJob.findById(first.json.jobId).lean();
        check('the superseded first save was graded but did not overwrite the newer answer', firstJob?.result?.superseded === true && graded[0].answers[0].score === 10, JSON.stringify(firstJob?.result || {}).slice(0, 80));
        const report = await api('GET', `/exams/${examId}/report`, { token: tTok });
        const rows = report.json?.participants || report.json?.attempts || [];
        check('teacher report: totals 10 and no answers pending grading', report.status === 200 && rows.length === 8 && rows.every((r) => r.pendingGrading === 0 && r.totalScore === 10), `status ${report.status} rows ${rows.length} ${rows.map((r) => r.pendingGrading + '/' + r.totalScore).join(',')}`);
    } finally {
        child.kill('SIGTERM');
        await sleep(1000);
        await mongoose.connection.db.dropDatabase().catch(() => {});
        await mongoose.disconnect();
        if (failed && process.env.VERBOSE) console.log(log.slice(-4000));
        console.log(`\n${passed}/${passed + failed} checks passed`);
        process.exit(failed ? 1 : 0);
    }
})().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
