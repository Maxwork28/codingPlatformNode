#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test against a LOCAL MongoDB and the real Docker judge.
 *
 *   node scripts/smoke-test.js
 *
 * It boots the API on a random port with its own throw-away database (smoke_<timestamp>),
 * seeds one admin / teacher / student / class / coding question through the models, then drives
 * the HTTP + Socket.IO API as each role and asserts the security and judge behaviour that the
 * audit found broken. The database is dropped at the end. It refuses to run against a non-local
 * MONGO host.
 */

const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MONGO_HOST = process.env.SMOKE_MONGO || 'mongodb://127.0.0.1:27017';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(MONGO_HOST)) {
    console.error('SMOKE_MONGO must point at a local MongoDB (mongodb://127.0.0.1:27017)');
    process.exit(2);
}
const DB = `smoke_${Date.now()}`;
const MONGO_URI = `${MONGO_HOST.replace(/\/$/, '')}/${DB}`;
const PORT = 5000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'smoke-test-secret-smoke-test-secret-smoke-test-secret';

const results = [];
const check = (name, ok, extra) => {
    results.push({ name, ok, extra });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

const api = async (method, url, { token, body, raw } = {}) => {
    const res = await fetch(`${BASE}${url}`, {
        signal: AbortSignal.timeout(120_000),
        method,
        headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:5173',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    if (raw) return { status: res.status, json, headers: res.headers };
    return { status: res.status, json };
};

const waitForServer = async (child) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
        try {
            const r = await fetch(`${BASE}/health/live`);
            if (r.ok) return;
        } catch {
            /* not yet */
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('server did not start in 60s');
};

(async () => {
    process.env.MONGO_URI = MONGO_URI;
    process.env.JWT_SECRET = JWT_SECRET;
    const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcrypt'));
    const User = require(path.join(ROOT, 'models', 'User'));
    const Class = require(path.join(ROOT, 'models', 'Class'));
    const Question = require(path.join(ROOT, 'models', 'Question'));
    const Submission = require(path.join(ROOT, 'models', 'Submission'));

    await mongoose.connect(MONGO_URI);
    console.log(`seeding ${DB}`);
    const pw = await bcrypt.hash('Passw0rd!smoke', 4);
    const [admin, teacher, teacher2, student, student2] = await User.create([
        { name: 'Admin', email: 'admin@smoke.test', role: 'admin', password: pw },
        { name: 'Teacher', email: 'teacher@smoke.test', role: 'teacher', password: pw, canCreateQuestion: true },
        { name: 'Other Teacher', email: 'teacher2@smoke.test', role: 'teacher', password: pw, canCreateQuestion: true },
        { name: 'Student', email: 'student@smoke.test', role: 'student', password: pw, number: '9999999999' },
        { name: 'Outsider', email: 'student2@smoke.test', role: 'student', password: pw },
    ]);
    const cls = await Class.create({ name: 'Smoke Class', createdBy: admin._id, teachers: [teacher._id], students: [student._id] });
    const question = await Question.create({
        title: 'Echo',
        description: '<p>Print the input.</p>',
        difficulty: 'easy',
        type: 'coding',
        createdBy: teacher._id,
        points: 10,
        languages: ['python', 'javascript'],
        timeLimit: 2,
        memoryLimit: 128,
        solutionCode: 'print(input())  # SECRET SOLUTION',
        explanation: 'SECRET EXPLANATION',
        testCases: [
            { input: '1', expectedOutput: '1', isPublic: true },
            { input: '2', expectedOutput: '2', isPublic: true },
            { input: 'HIDDEN_INPUT_42', expectedOutput: 'HIDDEN_INPUT_42', isPublic: false },
        ],
        classes: [{ classId: cls._id, isPublished: true, isDisabled: false }],
    });
    cls.questions.push(question._id);
    await cls.save();

    // Boot the real server as a child process with the smoke env.
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'development',
            PORT: String(PORT),
            MONGO_URI,
            JWT_SECRET,
            CORS_ORIGINS: 'http://localhost:5173',
            LOG_LEVEL: 'warn',
            JUDGE_CONCURRENCY: '2',
            JUDGE_MAX_QUEUE: '3',
            RATE_AUTH_MAX: '100',
            // AI detection block: never call real AI providers from the smoke test (manual references only).
            OPENAI_API_KEY: '',
            GEMINI_API_KEY: '',
            ANTHROPIC_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => (serverLog += d));
    child.stderr.on('data', (d) => (serverLog += d));

    try {
        await waitForServer(child);
        console.log(`server up on ${BASE}`);

        // ---- health
        {
            const r = await api('GET', '/health');
            check('GET /health reports mongo+docker+judge', r.status === 200 && r.json.mongo === 'up' && r.json.docker === 'up' && r.json.judge, JSON.stringify(r.json.judge));
        }

        // ---- auth
        const login = async (email) => {
            const r = await api('POST', '/auth/login', { body: { email, password: 'Passw0rd!smoke' } });
            assert.strictEqual(r.status, 200, `login ${email}: ${JSON.stringify(r.json)}`);
            return r.json.token;
        };
        {
            const bad = await api('POST', '/auth/login', { body: { email: 'student@smoke.test', password: 'wrong' } });
            check('login with wrong password → 401', bad.status === 401);
            const inj = await api('POST', '/auth/login', { body: { email: { $regex: '^s' }, password: 'Passw0rd!smoke' } });
            check('login with $regex email is rejected', inj.status === 400 || inj.status === 401, `status ${inj.status}`);
            const noTok = await api('GET', '/auth/me');
            check('GET /auth/me without token → 401', noTok.status === 401);
            const forged = await api('GET', '/auth/me', {
                token: require(path.join(ROOT, 'node_modules', 'jsonwebtoken')).sign({ id: admin._id, role: 'admin' }, 'abcdefghijkl111'),
            });
            check('token signed with old fallback secret is rejected', forged.status === 401);
            const forgot = await api('POST', '/auth/forgot-password', { body: { email: 'nobody@smoke.test' } });
            check('forgot-password does not reveal account existence', forgot.status === 200 && /if an account exists/i.test(forgot.json.message));
        }
        const studentTok = await login('student@smoke.test');
        const student2Tok = await login('student2@smoke.test');
        const teacherTok = await login('teacher@smoke.test');
        const teacher2Tok = await login('teacher2@smoke.test');
        const adminTok = await login('admin@smoke.test');
        {
            const me = await api('GET', '/auth/me', { token: studentTok });
            check('GET /auth/me returns mustChangePassword flag', me.status === 200 && 'mustChangePassword' in me.json);
        }

        // ---- student question projection
        {
            const r = await api('GET', `/questions/${question._id}?classId=${cls._id}`, { token: studentTok });
            const q = r.json.question || r.json;
            const body = JSON.stringify(r.json);
            check('student GET question → 200', r.status === 200, `status ${r.status}`);
            check('student response has no hidden test case input', !body.includes('HIDDEN_INPUT_42'));
            check('student response has no solutionCode / explanation', !body.includes('SECRET SOLUTION') && !body.includes('SECRET EXPLANATION'));
            check('student response includes public test cases only', Array.isArray(q.testCases) && q.testCases.length === 2, `got ${q.testCases?.length}`);
            const outsider = await api('GET', `/questions/${question._id}?classId=${cls._id}`, { token: student2Tok });
            check('non-enrolled student GET question → 403', outsider.status === 403, `status ${outsider.status}`);
            const list = await api('GET', `/questions/classes/${cls._id}/questions`, { token: studentTok });
            check('student class question list hides hidden tests', list.status === 200 && !JSON.stringify(list.json).includes('HIDDEN_INPUT_42'));
            const listOut = await api('GET', `/questions/classes/${cls._id}/questions`, { token: student2Tok });
            check('non-enrolled student class list → 403', listOut.status === 403, `status ${listOut.status}`);
            const all = await api('GET', '/questions', { token: studentTok });
            check('student GET /questions (all) → 403', all.status === 403, `status ${all.status}`);
        }

        // ---- teacher IDOR
        {
            const sol = await api('GET', `/questions/${question._id}/solution`, { token: teacher2Tok });
            check('unrelated teacher cannot view solution', sol.status === 403, `status ${sol.status}`);
            const edit = await api('PUT', `/questions/${question._id}`, { token: teacher2Tok, body: { title: 'Hijacked' } });
            check('unrelated teacher cannot edit question', edit.status === 403, `status ${edit.status}`);
            const own = await api('GET', `/questions/${question._id}/solution`, { token: teacherTok });
            check('assigned teacher can view solution', own.status === 200, `status ${own.status}`);
            const students = await api('GET', `/admin/classes/${cls._id}/students`, { token: teacher2Tok });
            check('unrelated teacher cannot list class students', students.status === 403 || students.status === 404, `status ${students.status}`);
            const massAssign = await api('PUT', `/questions/${question._id}`, { token: teacherTok, body: { title: 'Echo', createdBy: teacher2._id, isExamOnly: true } });
            const after = await Question.findById(question._id).lean();
            check('edit cannot overwrite createdBy / isExamOnly', String(after.createdBy) === String(teacher._id) && !after.isExamOnly, `status ${massAssign.status}`);
        }

        // ---- run / submit through the judge
        {
            const run = await api('POST', `/questions/${question._id}/run`, {
                token: studentTok,
                body: { answer: 'print(input())', classId: String(cls._id), language: 'python' },
            });
            check('student run → 200 with passing public tests', run.status === 200 && run.json.testResults?.every((t) => t.passed), JSON.stringify(run.json).slice(0, 160));
            const runOutsider = await api('POST', `/questions/${question._id}/run`, {
                token: student2Tok,
                body: { answer: 'print(input())', classId: String(cls._id), language: 'python' },
            });
            check('non-enrolled student run → 403', runOutsider.status === 403, `status ${runOutsider.status}`);

            const t0 = Date.now();
            const sub = await api('POST', `/questions/${question._id}/submit`, {
                token: studentTok,
                body: { answer: 'print(input())', classId: String(cls._id), language: 'python' },
            });
            const ms = Date.now() - t0;
            check('student submit → accepted', sub.status === 200 && sub.json.submission?.isCorrect === true, `${ms} ms, status ${sub.status}`);
            check('submit response hides hidden test input', !JSON.stringify(sub.json).includes('HIDDEN_INPUT_42'));
            const saved = await Submission.findOne({ studentId: student._id, isRun: false }).select('+testResults').lean();
            check('full testResults stored on Submission', Array.isArray(saved?.testResults) && saved.testResults.length === 3, `len ${saved?.testResults?.length}`);

            const tle0 = Date.now();
            const tle = await api('POST', `/questions/${question._id}/submit`, {
                token: studentTok,
                body: { answer: 'while True: pass', classId: String(cls._id), language: 'python' },
            });
            check('infinite loop submit returns tle (no hang)', tle.status === 200 && tle.json.submission?.status === 'tle', `${Date.now() - tle0} ms, status=${tle.json.submission?.status}`);

            // Saturate the judge: concurrency 2 + queue 3 → the 6th+ concurrent request must get 429.
            const burst = await Promise.all(
                Array.from({ length: 8 }, () =>
                    api('POST', `/questions/${question._id}/run`, {
                        token: studentTok,
                        body: { answer: 'import time\ntime.sleep(1)\nprint(input())', classId: String(cls._id), language: 'python' },
                    })
                )
            );
            const codes = burst.map((b) => b.status);
            check('judge saturation returns 429 instead of OOM/500', codes.includes(429) && !codes.includes(500), codes.join(','));

            const view = await api('GET', `/questions/submissions/${saved._id}/code`, { token: teacherTok });
            check('teacher view submission uses stored results (no re-judge)', view.status === 200 && Array.isArray(view.json.testResults), `status ${view.status}`);
            const viewOther = await api('GET', `/questions/submissions/${saved._id}/code`, { token: teacher2Tok });
            check('unrelated teacher cannot view submission', viewOther.status === 403, `status ${viewOther.status}`);
        }

        // ---- leaderboard privacy
        {
            const lb = await api('GET', `/questions/classes/${cls._id}/leaderboard`, { token: studentTok });
            const body = JSON.stringify(lb.json);
            check('student leaderboard → 200', lb.status === 200, `status ${lb.status}`);
            check('student leaderboard has no emails', !body.includes('@smoke.test'));
            const lbOut = await api('GET', `/questions/classes/${cls._id}/leaderboard`, { token: student2Tok });
            check('non-enrolled student leaderboard → 403', lbOut.status === 403, `status ${lbOut.status}`);
        }

        // ==== leaderboard: bounded per-question aggregates + atomic writes (leaderboard refactor checks) ====
        {
            const Leaderboard = require(path.join(ROOT, 'models', 'Leaderboard'));
            await User.create({ name: 'LB Student', email: 'lbstudent@smoke.test', role: 'student', password: pw });
            const lbStudent = await User.findOne({ email: 'lbstudent@smoke.test' }).select('_id').lean();
            const mcq = await Question.create({
                title: 'LB MCQ',
                description: '<p>Pick B</p>',
                difficulty: 'easy',
                type: 'singleCorrectMcq',
                createdBy: teacher._id,
                points: 5,
                options: ['A', 'B', 'C'],
                correctOption: 1,
                classes: [{ classId: cls._id, isPublished: true, isDisabled: false }],
            });
            await Class.updateOne({ _id: cls._id }, { $addToSet: { students: lbStudent._id, questions: mcq._id } });
            const lbTok = await login('lbstudent@smoke.test');
            const lbDoc = () => Leaderboard.findOne({ classId: cls._id, studentId: lbStudent._id }).lean();

            // 10 concurrent submits by one student on one question (5 right, 5 wrong): no VersionError / 500.
            const burst = await Promise.all(
                Array.from({ length: 10 }, (_, i) =>
                    api('POST', `/questions/${mcq._id}/submit`, { token: lbTok, body: { answer: i % 2 ? 1 : 0, classId: String(cls._id) } })
                )
            );
            const after = await lbDoc();
            const row = after?.questions?.[0];
            check(
                'leaderboard: 10 concurrent submits → all 200, totalSubmits=10, one aggregate row',
                burst.every((b) => b.status === 200) && after?.totalSubmits === 10 && after.questions.length === 1 &&
                    row.attempts === 10 && row.isCorrect === true && row.bestScore === 5 &&
                    after.correctAttempts === 5 && after.wrongAttempts === 5 && after.totalScore === 5 && !('attempts' in after),
                `codes ${burst.map((b) => b.status).join(',')} submits=${after?.totalSubmits} rows=${after?.questions?.length} c/w=${after?.correctAttempts}/${after?.wrongAttempts}`
            );

            // Run only bumps totalRuns; a wrong coding submit marked correct by staff updates row + totals atomically.
            const run = await api('POST', `/questions/${question._id}/run`, { token: lbTok, body: { answer: 'print(input())', classId: String(cls._id), language: 'python' } });
            const wrong = await api('POST', `/questions/${question._id}/submit`, { token: lbTok, body: { answer: 'print(0)', classId: String(cls._id), language: 'python' } });
            const mark = wrong.json.submission?._id
                ? await api('POST', `/questions/submissions/${wrong.json.submission._id}/mark-correct`, { token: teacherTok })
                : { status: 0 };
            const marked = await lbDoc();
            const codingRow = marked?.questions?.find((r) => String(r.questionId) === String(question._id));
            check(
                'leaderboard: run → totalRuns only; mark-correct → row solved + totals updated',
                run.status === 200 && wrong.status === 200 && mark.status === 200 &&
                    marked.totalRuns === 1 && marked.totalSubmits === 11 && marked.questions.length === 2 &&
                    codingRow?.isCorrect === true && codingRow.bestScore === 10 && codingRow.attempts === 1 && codingRow.firstSolvedAt &&
                    marked.correctAttempts === 6 && marked.wrongAttempts === 5 && marked.totalScore === 15,
                `run ${run.status} submit ${wrong.status} mark ${mark.status} runs=${marked?.totalRuns} submits=${marked?.totalSubmits} score=${marked?.totalScore} c/w=${marked?.correctAttempts}/${marked?.wrongAttempts}`
            );

            // Every leaderboard doc in the class: ≤ 1 row per question and totalScore = Σ bestScore.
            const docs = await Leaderboard.find({ classId: cls._id }).lean();
            const bad = docs.filter((d) => {
                const ids = (d.questions || []).map((r) => String(r.questionId));
                const sum = (d.questions || []).reduce((s, r) => s + (r.bestScore || 0), 0);
                return new Set(ids).size !== ids.length || sum !== d.totalScore || 'attempts' in d || 'highestScores' in d;
            });
            const main = docs.find((d) => String(d.studentId) === String(student._id));
            check(
                'leaderboard: ≤1 row per question and totalScore = Σ bestScore for every doc',
                docs.length >= 2 && bad.length === 0 && main?.questions?.length === 1 && main.totalSubmits >= 2,
                `docs=${docs.length} bad=${bad.length} mainRows=${main?.questions?.length} mainSubmits=${main?.totalSubmits}`
            );

            // Response-shape compatibility: own row keeps highestScores / attempts (last N from Submission) / problemsSolved.
            const lb = await api('GET', `/questions/classes/${cls._id}/leaderboard`, { token: lbTok });
            const self = (lb.json.leaderboard || []).find((r) => String(r.studentId?._id) === String(lbStudent._id));
            const other = (lb.json.leaderboard || []).find((r) => String(r.studentId?._id) !== String(lbStudent._id));
            const qs = await api('GET', `/questions/classes/${cls._id}/questions`, { token: lbTok });
            const mcqView = (qs.json.questions || []).find((q) => String(q._id) === String(mcq._id));
            check(
                'leaderboard: API keeps highestScores / attempts / problemsSolved / studentAttemptStatus',
                lb.status === 200 && self?.problemsSolved === 2 && self.totalScore === 15 &&
                    Array.isArray(self.highestScores) && self.highestScores.length === 2 &&
                    Array.isArray(self.attempts) && self.attempts.length === 11 && self.attempts.every((a) => a.submissionId && a.isRun === false) &&
                    (!other || other.attempts === undefined) && mcqView?.studentAttemptStatus === 'attempted',
                `status ${lb.status} solved=${self?.problemsSolved} hs=${self?.highestScores?.length} attempts=${self?.attempts?.length} mcqStatus=${mcqView?.studentAttemptStatus}`
            );
        }
        // ==== end leaderboard refactor checks ====

        // ---- admin: bulk create returns random credentials once, never a shared default
        {
            const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Students');
            ws.addRow(['Name', 'Email', 'Number']);
            ws.addRow(['Bulk One', 'bulk1@smoke.test', '']);
            ws.addRow(['Bulk Two', 'bulk2@smoke.test', '']);
            const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());
            const importAs = async (token) => {
                const form = new FormData();
                form.append('role', 'student');
                form.append('file', new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'students.xlsx');
                const res = await fetch(`${BASE}/admin/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:5173' }, body: form });
                return { status: res.status, json: await res.json().catch(() => ({})) };
            };
            const r = await importAs(adminTok);
            const body = JSON.stringify(r.json);
            check('admin spreadsheet import → 200', r.status === 200, `status ${r.status} ${body.slice(0, 160)}`);
            check('import never uses Password123!', !body.includes('Password123'));
            check('admin receives one-time random credentials', Array.isArray(r.json.credentials) && r.json.credentials.length === 2 && r.json.credentials.every((c) => c.password && c.password.length >= 10), `credentials: ${JSON.stringify(r.json.credentials?.map((c) => c.email))}`);
            const u = await User.findOne({ email: 'bulk1@smoke.test' }).lean();
            check('imported user has mustChangePassword=true', u ? u.mustChangePassword === true : false, u ? '' : 'user not created');
            if (r.json.credentials?.[0]) {
                const creds = r.json.credentials[0];
                const lg = await api('POST', '/auth/login', { body: { email: creds.email, password: creds.password } });
                check('imported user can log in with one-time password and is flagged', lg.status === 200 && lg.json.mustChangePassword === true, `status ${lg.status}`);
                const chg = await api('POST', '/auth/change-password', { token: lg.json.token, body: { oldPassword: creds.password, newPassword: 'NewPassw0rd!x' } });
                check('change-password clears the flag and returns a new token', chg.status === 200 && chg.json.token && chg.json.mustChangePassword === false, `status ${chg.status}`);
                const oldTok = await api('GET', '/auth/me', { token: lg.json.token });
                check('old token is rejected after password change', oldTok.status === 401, `status ${oldTok.status}`);
            }
            const asTeacher = await importAs(teacherTok);
            check('teacher import does not receive plaintext credentials', asTeacher.status !== 200 || !Array.isArray(asTeacher.json.credentials) || asTeacher.json.credentials.length === 0, `status ${asTeacher.status}`);
            const teacherCanAdd = await api('POST', `/admin/classes/${cls._id}/students`, { token: teacherTok, body: { emails: 'bulk2@smoke.test' } });
            check('assigned teacher adds an existing student to the class', teacherCanAdd.status === 200, `status ${teacherCanAdd.status} ${JSON.stringify(teacherCanAdd.json).slice(0, 100)}`);
            const otherTeacherAdd = await api('POST', `/admin/classes/${cls._id}/students`, { token: teacher2Tok, body: { emails: 'bulk1@smoke.test' } });
            check('unrelated teacher cannot add students to the class', otherTeacherAdd.status === 403, `status ${otherTeacherAdd.status}`);
        }

        // ---- exam flow
        {
            const create = await api('POST', '/exams', {
                token: teacherTok,
                body: {
                    title: 'Smoke Exam',
                    classId: String(cls._id),
                    questions: [{ questionId: String(question._id), points: 10 }],
                    proctoring: { durationMinutes: 30 },
                    status: 'scheduled',
                },
            });
            const examId = create.json.exam?._id || create.json._id;
            check('teacher creates exam', create.status < 300 && examId, `status ${create.status} ${JSON.stringify(create.json).slice(0, 120)}`);
            if (examId) {
                const badDate = await api('PUT', `/exams/${examId}`, { token: teacherTok, body: { title: 'Smoke Exam', proctoring: { durationMinutes: 30, startTime: '2026-10-07T10:00' } } });
                check('offset-less datetime is rejected', badDate.status === 400, `status ${badDate.status}`);
                const start = await api('POST', `/exams/${examId}/start`, { token: studentTok });
                const attemptId = start.json.attempt?._id;
                check('student starts exam', start.status === 200 && attemptId, `status ${start.status}`);
                check('exam questions hide hidden tests', !JSON.stringify(start.json).includes('HIDDEN_INPUT_42'));
                const ans = await api('POST', `/exams/${examId}/submit-answer`, {
                    token: studentTok,
                    body: { attemptId, questionId: String(question._id), answer: 'print(input())', language: 'python' },
                });
                check('exam answer graded', ans.status === 200 && ans.json.passedTestCases === 3, `status ${ans.status} ${JSON.stringify(ans.json).slice(0, 120)}`);
                const ev = await api('POST', `/exams/${examId}/events`, { token: studentTok, body: { attemptId, type: 'tab_switch', details: { huge: 'x'.repeat(5000) } } });
                check('proctoring event with oversized details accepted and bounded', ev.status === 200);
                const fin = await api('POST', `/exams/${examId}/submit`, { token: studentTok, body: { attemptId } });
                check('student submits exam', fin.status === 200, `status ${fin.status}`);
                const late = await api('POST', `/exams/${examId}/submit-answer`, {
                    token: studentTok,
                    body: { attemptId, questionId: String(question._id), answer: 'print(1)', language: 'python' },
                });
                check('answer after submit is rejected', late.status === 409 || late.status === 403 || late.status === 400, `status ${late.status}`);
                const res = await api('GET', `/exams/${examId}/results`, { token: studentTok });
                check('results exclude answer keys while exam window still open', res.status === 200 && !JSON.stringify(res.json).includes('"correctAnswer"'), `status ${res.status}`);
                const outsider = await api('POST', `/exams/${examId}/start`, { token: student2Tok });
                check('non-enrolled student cannot start exam', outsider.status === 403, `status ${outsider.status}`);
            }
        }

        // ---- exam: server-anchored section / question timers
        // One section (4 s) holding one MCQ question (3 s). The client never reports time; the server
        // must expire both on its own clock, and the legacy PATCH routes must not be able to add time.
        {
            const ExamAttempt = require(path.join(ROOT, 'models', 'ExamAttempt'));
            const mcq = await Question.create({
                title: 'Timed MCQ',
                description: '<p>Pick b.</p>',
                difficulty: 'easy',
                type: 'singleCorrectMcq',
                createdBy: teacher._id,
                points: 5,
                options: ['a', 'b'],
                correctOption: 1,
            });
            const qid = String(mcq._id);
            const create = await api('POST', '/exams', {
                token: teacherTok,
                body: {
                    title: 'Smoke Timed Exam',
                    classId: String(cls._id),
                    sections: [{ sectionId: 'timed', title: 'Timed', durationSeconds: 4 }],
                    questions: [{ questionId: qid, points: 5, sectionId: 'timed', timeLimitSeconds: 3 }],
                    proctoring: { durationMinutes: 30 },
                    status: 'scheduled',
                },
            });
            const examId = create.json.exam?._id;
            check('timers: teacher creates exam with a 4 s section and a 3 s question', create.status === 201 && examId, `status ${create.status}`);
            if (examId) {
                const qTimerOf = (a) => (a?.questionTimers || []).find((t) => String(t.questionId) === qid);
                const sTimerOf = (a) => (a?.sectionTimers || []).find((t) => t.sectionId === 'timed');
                const start = await api('POST', `/exams/${examId}/start`, { token: studentTok });
                const attemptId = start.json.attempt?._id;
                const q0 = qTimerOf(start.json.attempt);
                const s0 = sTimerOf(start.json.attempt);
                check(
                    'timers: start returns running server-computed timers + serverTime',
                    start.status === 200 && start.json.serverTime && q0?.running && q0.remainingSeconds <= 3 && q0.endsAt && s0?.running && s0.remainingSeconds <= 4,
                    JSON.stringify({ q0, s0 })
                );
                const nav = await api('POST', `/exams/${examId}/navigate`, { token: studentTok, body: { attemptId, questionId: qid } });
                check('timers: navigate returns authoritative timer state', nav.status === 200 && nav.json.serverTime && qTimerOf(nav.json)?.running === true, `status ${nav.status} ${JSON.stringify(nav.json).slice(0, 200)}`);
                const early = await api('POST', `/exams/${examId}/submit-answer`, { token: studentTok, body: { attemptId, questionId: qid, answer: 1 } });
                check('timers: answer inside the question time is accepted', early.status === 200, `status ${early.status} ${JSON.stringify(early.json)}`);

                const patchQ = await api('PATCH', `/exams/${examId}/question-timer`, { token: studentTok, body: { attemptId, questionId: qid, remainingSeconds: 9999 } });
                const patchS = await api('PATCH', `/exams/${examId}/section-timer`, {
                    token: studentTok,
                    body: { attemptId, sectionId: 'timed', currentQuestionId: qid, remainingSeconds: 9999 },
                });
                const afterPatch = await api('GET', `/exams/${examId}/attempt`, { token: studentTok });
                const qp = qTimerOf(afterPatch.json.attempt);
                const sp = sTimerOf(afterPatch.json.attempt);
                check(
                    'timers: legacy PATCH cannot increase remaining time',
                    patchQ.status === 200 && patchS.status === 200 && qp.remainingSeconds <= 3 && sp.remainingSeconds <= 4 && qTimerOf(patchQ.json).remainingSeconds <= 3,
                    `question ${qp?.remainingSeconds}s, section ${sp?.remainingSeconds}s`
                );

                // No client traffic at all while the clock runs out.
                await new Promise((r) => setTimeout(r, 5500));

                const late = await api('POST', `/exams/${examId}/submit-answer`, { token: studentTok, body: { attemptId, questionId: qid, answer: 0 } });
                check('timers: answer after the question time ran out → 403 time over', late.status === 403 && /time .*over/i.test(late.json.error || ''), `status ${late.status} ${late.json.error}`);
                const got = await api('GET', `/exams/${examId}/attempt`, { token: studentTok });
                const q1 = qTimerOf(got.json.attempt);
                const s1 = sTimerOf(got.json.attempt);
                check(
                    'timers: getAttempt reports question + section timers completed at 0',
                    got.status === 200 && q1?.completed && q1.remainingSeconds === 0 && !q1.running && s1?.completed && s1.remainingSeconds === 0,
                    JSON.stringify({ q1, s1 })
                );
                const revive = await api('PATCH', `/exams/${examId}/question-timer`, { token: studentTok, body: { attemptId, questionId: qid, remainingSeconds: 9999, completed: false } });
                const stillLate = await api('POST', `/exams/${examId}/submit-answer`, { token: studentTok, body: { attemptId, questionId: qid, answer: 0 } });
                check(
                    'timers: legacy PATCH cannot reopen an expired question',
                    revive.status === 200 && qTimerOf(revive.json)?.completed && qTimerOf(revive.json).remainingSeconds === 0 && stillLate.status === 403,
                    `patch ${revive.status}, answer ${stillLate.status}`
                );
                const run = await api('POST', `/exams/${examId}/run`, { token: studentTok, body: { attemptId, questionId: qid, answer: 'x', language: 'python' } });
                check('timers: run after the question time ran out → 403', run.status === 403, `status ${run.status}`);
                const saved = await ExamAttempt.findById(attemptId).lean();
                const stored = (saved?.questionTimers || []).find((t) => String(t.questionId) === qid);
                check('timers: stored timer is folded (completed, 0 s, not running)', stored?.completed === true && stored.remainingSeconds === 0 && !stored.startedAt, JSON.stringify(stored));
            }
        }

        // =====================================================================================
        // ---- Safe Exam Browser (SEB) [SEB feature block: keep self-contained]
        // =====================================================================================
        {
            const sebUtil = require(path.join(ROOT, 'utils', 'seb'));
            const SEB_UA = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 SEB/3.9.0';
            const sebApi = async (method, url, { token, body, headers = {}, ua } = {}) => {
                const res = await fetch(`${BASE}${url}`, {
                    signal: AbortSignal.timeout(60_000),
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        Origin: 'http://localhost:5173',
                        ...(ua ? { 'User-Agent': ua } : {}),
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                        ...headers,
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
                const buf = Buffer.from(await res.arrayBuffer());
                let json = null;
                try {
                    json = JSON.parse(buf.toString('utf8'));
                } catch {
                    json = null;
                }
                return { status: res.status, json: json || {}, buf, headers: res.headers };
            };
            const leaks = (payload, secrets) => {
                const text = JSON.stringify(payload);
                return /sebEntryPassword|sebExitPassword|sebConfigToken|sebConfigKeyOverride/.test(text) || secrets.some((s) => s && text.includes(s));
            };

            // A second enrolled student for the throttle checks.
            const sebStudent = await User.create({ name: 'SEB Student', email: 'sebstudent@smoke.test', role: 'student', password: pw });
            await Class.updateOne({ _id: cls._id }, { $addToSet: { students: sebStudent._id } });
            const sebStudentTok = await login('sebstudent@smoke.test');

            const create = await sebApi('POST', '/exams', {
                token: teacherTok,
                body: {
                    title: 'SEB Smoke Exam',
                    classId: String(cls._id),
                    questions: [{ questionId: String(question._id), points: 10 }],
                    proctoring: { durationMinutes: 30, sebRequired: true, sebEntryPassword: 'CLIENTSET', sebExitPassword: 'CLIENTSET' },
                    status: 'scheduled',
                },
            });
            const examId = create.json.exam?._id;
            check('seb: teacher creates an exam with "Require Safe Exam Browser"', create.status === 201 && examId, `status ${create.status} ${JSON.stringify(create.json).slice(0, 160)}`);
            if (examId) {
                const details = await sebApi('GET', `/exams/${examId}`, { token: teacherTok });
                const s = details.json.exam?.seb || {};
                const p = details.json.exam?.proctoring || {};
                const pwOk = (v) => typeof v === 'string' && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(v);
                check(
                    'seb: staff payload has generated entry/exit passwords (client values ignored)',
                    pwOk(s.entryPassword) && pwOk(s.exitPassword) && p.sebEntryPassword === s.entryPassword && s.entryPassword !== 'CLIENTSET',
                    `${s.entryPassword}/${s.exitPassword}`
                );
                const linkRe = new RegExp(`^seb://localhost:${PORT}/exams/${examId}/seb-config/[A-Za-z0-9_-]{20,}$`);
                check('seb: staff payload has a seb:// launch link and a Config Key', linkRe.test(s.launchLink || '') && /^[0-9a-f]{64}$/.test(s.configKey || ''), s.launchLink);
                const report = await sebApi('GET', `/exams/${examId}/report`, { token: teacherTok });
                check('seb: report payload includes the passwords for staff', report.json.exam?.seb?.entryPassword === s.entryPassword && report.json.exam?.seb?.exitPassword === s.exitPassword);
                const token = p.sebConfigToken;
                const secrets = [s.entryPassword, s.exitPassword];

                // Student-facing payloads never carry the passwords.
                const summary = await sebApi('GET', `/exams/${examId}/summary`, { token: studentTok });
                check(
                    'seb: student summary has sebRequired + sebLink but no passwords',
                    summary.status === 200 && summary.json.exam?.proctoring?.sebRequired === true && summary.json.sebLink === s.launchLink && !leaks(summary.json, secrets),
                    `status ${summary.status}`
                );
                const classList = await sebApi('GET', `/exams/class/${cls._id}`, { token: studentTok });
                check('seb: student class exam list leaks no SEB secrets', classList.status === 200 && !leaks(classList.json, [...secrets, token]));

                // Enforcement on student routes.
                const plain = await sebApi('POST', `/exams/${examId}/start`, { token: studentTok, body: { entryPassword: s.entryPassword } });
                check('seb: start from a normal browser → 403 SEB_REQUIRED', plain.status === 403 && plain.json.code === 'SEB_REQUIRED', `${plain.status} ${plain.json.code}`);
                const plainAttempt = await sebApi('GET', `/exams/${examId}/attempt`, { token: studentTok });
                check('seb: GET attempt from a normal browser → 403 SEB_REQUIRED', plainAttempt.status === 403 && plainAttempt.json.code === 'SEB_REQUIRED');
                const noPw = await sebApi('POST', `/exams/${examId}/start`, { token: studentTok, ua: SEB_UA });
                check('seb: start in SEB without entry password → 403 SEB_ENTRY_PASSWORD', noPw.status === 403 && noPw.json.code === 'SEB_ENTRY_PASSWORD', `${noPw.status} ${noPw.json.code}`);
                const wrong = await sebApi('POST', `/exams/${examId}/start`, { token: studentTok, ua: SEB_UA, body: { entryPassword: 'WRONG234' } });
                check('seb: start in SEB with a wrong password → 403 SEB_ENTRY_PASSWORD', wrong.status === 403 && wrong.json.code === 'SEB_ENTRY_PASSWORD' && wrong.json.triesLeft === 4, `${wrong.status} ${JSON.stringify(wrong.json)}`);

                // Throttle: 5 wrong tries within 10 minutes lock the student for 10 minutes.
                const tries = [];
                for (let i = 0; i < 6; i += 1) {
                    tries.push(await sebApi('POST', `/exams/${examId}/start`, { token: sebStudentTok, ua: SEB_UA, body: { entryPassword: `NOPE${i}XYZ` } }));
                }
                check(
                    'seb: wrong tries 1-4 → 403, 5th and 6th → 429 SEB_ENTRY_LOCKED',
                    tries.slice(0, 4).every((r) => r.status === 403) && tries[4].status === 429 && tries[5].status === 429 && tries[5].json.code === 'SEB_ENTRY_LOCKED' && Number(tries[5].headers.get('retry-after')) > 500,
                    tries.map((r) => r.status).join(',')
                );
                const lockedRight = await sebApi('POST', `/exams/${examId}/start`, { token: sebStudentTok, ua: SEB_UA, body: { entryPassword: s.entryPassword } });
                check('seb: even the right password → 429 while locked', lockedRight.status === 429, `status ${lockedRight.status}`);

                // Right password (trimmed, lower case) starts the exam; resuming needs no password.
                const ok = await sebApi('POST', `/exams/${examId}/start`, { token: studentTok, ua: SEB_UA, body: { entryPassword: `  ${s.entryPassword.toLowerCase()} ` } });
                check('seb: right password in SEB → 200', ok.status === 200 && ok.json.attempt?._id, `${ok.status} ${JSON.stringify(ok.json).slice(0, 160)}`);
                check('seb: start payload leaks no SEB secrets', ok.status === 200 && !leaks(ok.json, [...secrets, token]));
                const resume = await sebApi('POST', `/exams/${examId}/start`, { token: studentTok, ua: SEB_UA });
                check('seb: resuming an in-progress attempt needs no password', resume.status === 200, `status ${resume.status}`);
                const att = await sebApi('GET', `/exams/${examId}/attempt`, { token: studentTok, ua: SEB_UA });
                check('seb: GET attempt in SEB → 200 without secrets', att.status === 200 && !leaks(att.json, [...secrets, token]), `status ${att.status}`);

                // .seb download (no bearer auth, token in the URL).
                const badTok = await sebApi('GET', `/exams/${examId}/seb-config/not-the-token`);
                check('seb: config download with a wrong token → 404', badTok.status === 404, `status ${badTok.status}`);
                const head = await fetch(`${BASE}/exams/${examId}/seb-config/${token}`, { method: 'HEAD', headers: { 'User-Agent': 'SEB/3.9.0' } });
                check('seb: HEAD on the config URL → 200 (SEB probes with HEAD first)', head.status === 200, `status ${head.status}`);
                const file = await sebApi('GET', `/exams/${examId}/seb-config/${token}`, { ua: 'SEB/3.9.0' });
                const xml = file.status === 200 ? sebUtil.decodeSebFile(file.buf) : '';
                check(
                    'seb: config download with the right token → gzip("plnd"+gzip(plist)) as an attachment',
                    file.status === 200 &&
                        file.buf[0] === 0x1f &&
                        file.buf[1] === 0x8b &&
                        /application\/seb/.test(file.headers.get('content-type') || '') &&
                        /attachment; filename="SEB Smoke Exam\.seb"/.test(file.headers.get('content-disposition') || ''),
                    `${file.status} ${file.headers.get('content-type')} ${file.headers.get('content-disposition')}`
                );
                check(
                    'seb: plist has startURL and hashedQuitPassword = SHA-256(exit password)',
                    xml.includes(`<key>startURL</key>\n\t<string>${s.startUrl}</string>`) &&
                        xml.includes(`<key>hashedQuitPassword</key>\n\t<string>${sebUtil.sha256Hex(s.exitPassword)}</string>`) &&
                        !xml.includes(s.exitPassword) &&
                        !xml.includes(s.entryPassword),
                    s.startUrl
                );
                const staffFile = await sebApi('GET', `/exams/${examId}/seb-config`, { token: teacherTok });
                const studentFile = await sebApi('GET', `/exams/${examId}/seb-config`, { token: studentTok });
                check('seb: staff download → 200, student → 403', staffFile.status === 200 && studentFile.status === 403, `${staffFile.status}/${studentFile.status}`);

                // Strict mode: the Config Key hash decides, the User-Agent alone is not enough.
                const strict = await sebApi('PUT', `/exams/${examId}`, { token: teacherTok, body: { proctoring: { sebVerifyMode: 'strict' } } });
                const after = await sebApi('GET', `/exams/${examId}`, { token: teacherTok });
                const key = after.json.exam?.seb?.configKey;
                check(
                    'seb: switching to strict keeps passwords and Config Key',
                    strict.status === 200 && after.json.exam?.seb?.verifyMode === 'strict' && after.json.exam.seb.entryPassword === s.entryPassword && key === s.configKey,
                    `status ${strict.status}`
                );
                const attemptUrl = `/exams/${examId}/attempt`;
                const goodHash = sebUtil.sha256Hex(`${BASE}${attemptUrl}` + key);
                const uaOnly = await sebApi('GET', attemptUrl, { token: studentTok, ua: SEB_UA });
                check('seb strict: SEB User-Agent without a Config Key hash → 403', uaOnly.status === 403 && uaOnly.json.code === 'SEB_REQUIRED', `status ${uaOnly.status}`);
                const good = await sebApi('GET', attemptUrl, { token: studentTok, ua: SEB_UA, headers: { 'X-SafeExamBrowser-ConfigKeyHash': goodHash } });
                check('seb strict: correct X-SafeExamBrowser-ConfigKeyHash → 200', good.status === 200, `status ${good.status} ${JSON.stringify(good.json).slice(0, 120)}`);
                const bad = await sebApi('GET', attemptUrl, { token: studentTok, ua: SEB_UA, headers: { 'X-SafeExamBrowser-ConfigKeyHash': sebUtil.sha256Hex('nope') } });
                check('seb strict: wrong X-SafeExamBrowser-ConfigKeyHash → 403', bad.status === 403 && bad.json.code === 'SEB_REQUIRED', `status ${bad.status}`);
                const otherUrl = await sebApi('GET', attemptUrl, { token: studentTok, ua: SEB_UA, headers: { 'X-SafeExamBrowser-ConfigKeyHash': sebUtil.sha256Hex(`${BASE}/exams/${examId}/summary` + key) } });
                check('seb strict: hash computed for another URL → 403', otherUrl.status === 403, `status ${otherUrl.status}`);
                // Cross-host API: the frontend forwards SEB's JavaScript API value for the page URL.
                const jsHash = sebUtil.sha256Hex(s.startUrl + key);
                const js = await sebApi('GET', attemptUrl, { token: studentTok, ua: SEB_UA, headers: { 'X-SafeExamBrowser-ConfigKeyHash': `jsapi;${jsHash};${encodeURIComponent(s.startUrl)}` } });
                check('seb strict: JS-API hash for the exam page URL → 200', js.status === 200, `status ${js.status}`);
                const foreign = 'https://evil.example/student/exams/x';
                const jsForeign = await sebApi('GET', attemptUrl, {
                    token: studentTok,
                    ua: SEB_UA,
                    headers: { 'X-SafeExamBrowser-ConfigKeyHash': `jsapi;${sebUtil.sha256Hex(foreign + key)};${encodeURIComponent(foreign)}` },
                });
                check('seb strict: JS-API hash for a page outside the app → 403', jsForeign.status === 403, `status ${jsForeign.status}`);
                const checkUrl = `/exams/${examId}/seb-check`;
                const diag = await sebApi('GET', checkUrl, { token: studentTok, ua: SEB_UA, headers: { 'X-SafeExamBrowser-ConfigKeyHash': sebUtil.sha256Hex(`${BASE}${checkUrl}` + key) } });
                check(
                    'seb: seb-check reports inSeb + valid Config Key hash',
                    diag.status === 200 && diag.json.inSeb && diag.json.uaMatched && diag.json.configKeyHashPresent && diag.json.configKeyHashValid && diag.json.expectedMode === 'strict' && !leaks(diag.json, [...secrets, key]),
                    JSON.stringify(diag.json).slice(0, 200)
                );
                const diagStaff = await sebApi('GET', checkUrl, { token: teacherTok });
                check('seb: seb-check for staff from a normal browser → not in SEB, shows expected key', diagStaff.status === 200 && diagStaff.json.inSeb === false && diagStaff.json.effectiveConfigKey === key);

                // Regenerate: new passwords, entry lockouts cleared, old Config Key no longer valid.
                const regenStudent = await sebApi('POST', `/exams/${examId}/seb/regenerate`, { token: studentTok });
                const regen = await sebApi('POST', `/exams/${examId}/seb/regenerate`, { token: teacherTok });
                const r = regen.json.seb || {};
                check(
                    'seb: regenerate (staff only) rotates both passwords and the Config Key, keeps the link',
                    regenStudent.status === 403 && regen.status === 200 && pwOk(r.entryPassword) && r.entryPassword !== s.entryPassword && r.exitPassword !== s.exitPassword && r.configKey !== key && r.launchLink === s.launchLink,
                    `${regenStudent.status}/${regen.status}`
                );
                const stale = await sebApi('GET', attemptUrl, { token: studentTok, ua: SEB_UA, headers: { 'X-SafeExamBrowser-ConfigKeyHash': goodHash } });
                check('seb strict: hash for the old Config Key → 403 after regenerate', stale.status === 403, `status ${stale.status}`);
                const unlockedHash = sebUtil.sha256Hex(`${BASE}/exams/${examId}/start` + r.configKey);
                const unlocked = await sebApi('POST', `/exams/${examId}/start`, {
                    token: sebStudentTok,
                    ua: SEB_UA,
                    headers: { 'X-SafeExamBrowser-ConfigKeyHash': unlockedHash },
                    body: { entryPassword: r.entryPassword },
                });
                check('seb: locked student starts with the new password after regenerate', unlocked.status === 200, `${unlocked.status} ${JSON.stringify(unlocked.json).slice(0, 120)}`);

                // Turning SEB off: config URL disappears, normal browsers work again.
                await sebApi('PUT', `/exams/${examId}`, { token: teacherTok, body: { proctoring: { sebRequired: false } } });
                const off = await sebApi('GET', `/exams/${examId}/seb-config/${token}`);
                const offAttempt = await sebApi('GET', attemptUrl, { token: studentTok });
                check('seb: after turning SEB off the config URL is 404 and normal browsers pass', off.status === 404 && offAttempt.status === 200, `${off.status}/${offAttempt.status}`);
            }
        }

        // =====================================================================================
        // ---- AI-generated-code detection [AI detection block: keep self-contained]
        // Provider keys are blanked in the server env, so only teacher-pasted references are used.
        // =====================================================================================
        {
            const AiReference = require(path.join(ROOT, 'models', 'AiReference'));
            const AI_REF = [
                'import sys',
                '',
                'def max_subarray(nums):',
                '    best = nums[0]',
                '    current = 0',
                '    for x in nums:',
                '        current = max(x, current + x)',
                '        best = max(best, current)',
                '    return best',
                '',
                'def main():',
                '    data = sys.stdin.read().split()',
                '    n = int(data[0])',
                '    nums = [int(v) for v in data[1:n + 1]]',
                '    print(max_subarray(nums))',
                '',
                'if __name__ == "__main__":',
                '    main()',
                '',
            ].join('\n');
            // Same program: every identifier renamed, reformatted, comments added.
            const AI_RENAMED = [
                'import sys',
                '# my own solution, honest',
                'def kadane(arr):',
                '    ans = arr[0]  # best so far',
                '    run = 0',
                '    for el in arr:',
                '        run = max(el,   run + el)',
                '        ans = max(ans, run)',
                '    return ans',
                '',
                'def go():',
                "    tokens = sys.stdin.read().split()",
                '    size = int(tokens[0])',
                '    arr = [int(t) for t in tokens[1:size + 1]]',
                '    print(kadane(arr))',
                '',
                "if __name__ == '__main__':",
                '    go()',
                '',
            ].join('\n');
            // A genuinely different solution (O(n^2) brute force).
            const AI_DIFFERENT = [
                'n = int(input())',
                'arr = list(map(int, input().split()))',
                'answer = arr[0]',
                'for start in range(n):',
                '    total = 0',
                '    for end in range(start, n):',
                '        total += arr[end]',
                '        if total > answer:',
                '            answer = total',
                'print(answer)',
                '',
            ].join('\n');

            const [aiA, aiB] = await User.create([
                { name: 'AI Student A', email: 'aistudenta@smoke.test', role: 'student', password: pw },
                { name: 'AI Student B', email: 'aistudentb@smoke.test', role: 'student', password: pw },
            ]);
            await Class.updateOne({ _id: cls._id }, { $addToSet: { students: { $each: [aiA._id, aiB._id] } } });
            const aiTokA = await login('aistudenta@smoke.test');
            const aiTokB = await login('aistudentb@smoke.test');
            const aiCoding = await Question.create({
                title: 'AI Max Subarray',
                description: '<p>Read n and n integers; print the maximum subarray sum.</p>',
                difficulty: 'easy',
                type: 'coding',
                createdBy: teacher._id,
                points: 10,
                languages: ['python'],
                timeLimit: 2,
                memoryLimit: 128,
                testCases: [
                    { input: '5\n1 -2 3 4 -1', expectedOutput: '7', isPublic: true },
                    { input: '3\n-1 -2 -3', expectedOutput: '-1', isPublic: false },
                ],
            });
            const aiMcq = await Question.create({
                title: 'AI MCQ',
                description: '<p>Pick b.</p>',
                difficulty: 'easy',
                type: 'singleCorrectMcq',
                createdBy: teacher._id,
                points: 5,
                options: ['a', 'b'],
                correctOption: 1,
            });
            const qid = String(aiCoding._id);
            const mcqId = String(aiMcq._id);
            const create = await api('POST', '/exams', {
                token: teacherTok,
                body: {
                    title: 'AI Smoke Exam',
                    classId: String(cls._id),
                    questions: [
                        { questionId: qid, points: 10 },
                        { questionId: mcqId, points: 5 },
                    ],
                    proctoring: { durationMinutes: 30 },
                    status: 'scheduled',
                },
            });
            const examId = create.json.exam?._id;
            check('ai: teacher creates an exam with a coding and an MCQ question', create.status === 201 && examId, `status ${create.status}`);
            if (examId) {
                const cfg = await api('GET', '/ai-check/config', { token: teacherTok });
                check(
                    'ai: config lists providers (none enabled here) and never exposes keys',
                    cfg.status === 200 && cfg.json.anyProvider === false && cfg.json.providers?.length === 3 && !/apikey|sk-/i.test(JSON.stringify(cfg.json)),
                    `status ${cfg.status}`
                );
                const gen = await api('POST', `/ai-check/exams/${examId}/generate`, { token: teacherTok, body: {} });
                check('ai: "Generate with AI" without provider keys → 400 with an explanation', gen.status === 400 && /provider/i.test(gen.json.error || ''), `status ${gen.status} ${gen.json.error}`);

                // A decoy reference first (different algorithm): the check must pick the closest one, not the first.
                const AI_DECOY = [
                    'import sys',
                    'def best(a, lo, hi):',
                    '    if lo == hi:',
                    '        return a[lo]',
                    '    mid = (lo + hi) // 2',
                    '    s, left = 0, float("-inf")',
                    '    for k in range(mid, lo - 1, -1):',
                    '        s += a[k]',
                    '        left = max(left, s)',
                    '    s, right = 0, float("-inf")',
                    '    for k in range(mid + 1, hi + 1):',
                    '        s += a[k]',
                    '        right = max(right, s)',
                    '    return max(best(a, lo, mid), best(a, mid + 1, hi), left + right)',
                    'vals = list(map(int, sys.stdin.read().split()))',
                    'print(best(vals[1:], 0, vals[0] - 1))',
                    '',
                ].join('\n');
                const decoy = await api('POST', `/ai-check/exams/${examId}/references`, { token: teacherTok, body: { questionId: qid, language: 'python', code: AI_DECOY, label: 'Gemini' } });
                const decoyId = decoy.json.reference?._id;
                const add = await api('POST', `/ai-check/exams/${examId}/references`, { token: teacherTok, body: { questionId: qid, language: 'python', code: AI_REF, label: 'ChatGPT' } });
                const refId = add.json.reference?._id;
                check('ai: staff adds manual (pasted) references', decoy.status === 201 && add.status === 201 && refId && add.json.reference.source === 'manual', `status ${add.status} ${JSON.stringify(add.json).slice(0, 120)}`);
                const addMcq = await api('POST', `/ai-check/exams/${examId}/references`, { token: teacherTok, body: { questionId: mcqId, language: 'python', code: AI_REF } });
                check('ai: references are refused for non-coding questions', addMcq.status === 400, `status ${addMcq.status}`);
                const other = await api('GET', `/ai-check/exams/${examId}`, { token: teacher2Tok });
                check('ai: unrelated teacher cannot read the exam AI report', other.status === 403, `status ${other.status}`);

                const startA = await api('POST', `/exams/${examId}/start`, { token: aiTokA });
                const startB = await api('POST', `/exams/${examId}/start`, { token: aiTokB });
                const attemptA = startA.json.attempt?._id;
                const attemptB = startB.json.attempt?._id;
                const [subA, subB] = await Promise.all([
                    api('POST', `/exams/${examId}/submit-answer`, { token: aiTokA, body: { attemptId: attemptA, questionId: qid, answer: AI_RENAMED, language: 'python' } }),
                    api('POST', `/exams/${examId}/submit-answer`, { token: aiTokB, body: { attemptId: attemptB, questionId: qid, answer: AI_DIFFERENT, language: 'python' } }),
                ]);
                const mcqA = await api('POST', `/exams/${examId}/submit-answer`, { token: aiTokA, body: { attemptId: attemptA, questionId: mcqId, answer: 1 } });
                check(
                    'ai: both coding answers are graded by the judge and the MCQ is saved',
                    subA.status === 200 && subA.json.passedTestCases === 2 && subB.status === 200 && subB.json.passedTestCases === 2 && mcqA.status === 200,
                    `${subA.status}/${subA.json.passedTestCases} ${subB.status}/${subB.json.passedTestCases} ${mcqA.status}`
                );
                check('ai: submit-answer response carries no AI data', !JSON.stringify(subA.json).includes('aiCheck') && !JSON.stringify(subB.json).includes('aiCheck'));

                const pollAi = async (done) => {
                    const deadline = Date.now() + 15_000;
                    let r;
                    while (Date.now() < deadline) {
                        r = await api('GET', `/ai-check/exams/${examId}`, { token: teacherTok });
                        if (r.status === 200 && done(r.json)) return r;
                        await new Promise((resolve) => setTimeout(resolve, 400));
                    }
                    return r;
                };
                const t0 = Date.now();
                const report = await pollAi((j) => j.byAttempt?.[attemptA]?.[qid]?.status === 'done' && j.byAttempt?.[attemptB]?.[qid]?.status === 'done');
                const a = report?.json.byAttempt?.[attemptA]?.[qid];
                const b = report?.json.byAttempt?.[attemptB]?.[qid];
                check('ai: renamed copy of the reference → ≥ 80 %, matched to the closest reference (#2, not the decoy)', a?.status === 'done' && a.percent >= 80 && a.matchedSource === 'manual' && /reference #2/.test(a.matchedLabel || '') && String(a.matchedReferenceId) === String(refId), `${a?.status} ${a?.percent}% ${a?.matchedLabel} after ${Date.now() - t0} ms`);
                check('ai: genuinely different solution → lower %', b?.status === 'done' && b.percent < a?.percent && b.percent < 50, `${b?.status} ${b?.percent}%`);
                const qRow = (report?.json.questions || []).find((q) => String(q.questionId) === qid);
                check(
                    'ai: report has reference counts and cohort medians (question + others-only per attempt)',
                    qRow?.references?.total === 2 && qRow.references.bySource?.manual === 2 && Number.isFinite(qRow.cohortMedian) && a?.cohortMedian === b?.percent && b?.cohortMedian === a?.percent,
                    JSON.stringify({ q: qRow?.cohortMedian, a: a?.cohortMedian, b: b?.cohortMedian })
                );
                const mcqSub = await Submission.findOne({ questionId: aiMcq._id, examAttemptId: attemptA }).select('+aiCheck').lean();
                check('ai: MCQ answers produce no aiCheck', mcqSub && mcqSub.aiCheck === undefined && !report?.json.byAttempt?.[attemptA]?.[mcqId] && (report?.json.questions || []).every((q) => String(q.questionId) !== mcqId));

                const cmp = await api('GET', `/ai-check/submissions/${a?.submissionId}`, { token: teacherTok });
                check(
                    'ai: compare view returns student code, matched reference and highlight ranges',
                    cmp.status === 200 && cmp.json.submission?.code?.includes('kadane') && cmp.json.selected?.code?.includes('max_subarray') && cmp.json.selected.matches?.length > 0 && cmp.json.selected.percent >= 80,
                    `status ${cmp.status} ranges ${cmp.json.selected?.matches?.length}`
                );

                const forbidden = await Promise.all([
                    api('GET', '/ai-check/config', { token: aiTokA }),
                    api('GET', `/ai-check/exams/${examId}`, { token: aiTokA }),
                    api('GET', `/ai-check/exams/${examId}/references`, { token: aiTokA }),
                    api('POST', `/ai-check/exams/${examId}/references`, { token: aiTokA, body: { questionId: qid, language: 'python', code: AI_REF } }),
                    api('DELETE', `/ai-check/exams/${examId}/references/${refId}`, { token: aiTokA }),
                    api('POST', `/ai-check/exams/${examId}/generate`, { token: aiTokA, body: {} }),
                    api('POST', `/ai-check/exams/${examId}/recheck`, { token: aiTokA }),
                    api('GET', `/ai-check/submissions/${a?.submissionId}`, { token: aiTokA }),
                ]);
                check('ai: students get 403 on every /ai-check endpoint', forbidden.every((r) => r.status === 403), forbidden.map((r) => r.status).join(','));
                const studentViews = await Promise.all([
                    api('GET', `/exams/${examId}/attempt`, { token: aiTokA }),
                    api('GET', `/exams/${examId}/summary`, { token: aiTokA }),
                    api('GET', `/exams/${examId}/results`, { token: aiTokA }),
                ]);
                check('ai: student exam payloads contain no AI scores', studentViews.every((r) => !/aiCheck|matchedSource|cohortMedian/.test(JSON.stringify(r.json))), studentViews.map((r) => r.status).join(','));

                const rc = await api('POST', `/ai-check/exams/${examId}/recheck`, { token: teacherTok });
                const after = await pollAi((j) => j.byAttempt?.[attemptA]?.[qid]?.status === 'done' && j.byAttempt?.[attemptB]?.[qid]?.status === 'done');
                check('ai: re-check all → 202, both answers re-scored identically', rc.status === 202 && rc.json.queued === 2 && after?.json.byAttempt?.[attemptA]?.[qid]?.percent === a?.percent, `status ${rc.status} queued ${rc.json.queued}`);

                const delDecoy = await api('DELETE', `/ai-check/exams/${examId}/references/${decoyId}`, { token: teacherTok });
                const del = await api('DELETE', `/ai-check/exams/${examId}/references/${refId}`, { token: teacherTok });
                const gone = await pollAi((j) => j.byAttempt?.[attemptA]?.[qid]?.status === 'no_references');
                check('ai: deleting all references → answers become "no references" (no stale %)', delDecoy.status === 200 && del.status === 200 && gone?.json.byAttempt?.[attemptA]?.[qid]?.percent === null, `status ${del.status} → ${gone?.json.byAttempt?.[attemptA]?.[qid]?.status}`);
                const left = await AiReference.countDocuments({ questionId: aiCoding._id });
                check('ai: reference removed from the database', left === 0, `${left} left`);
            }
        }
        // ==== end AI detection block ====

        // ---- socket.io auth
        {
            const { io } = require(path.join(ROOT, 'node_modules', 'socket.io-client'));
            const connect = (opts) =>
                new Promise((resolve) => {
                    const s = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 5000, ...opts });
                    s.on('connect', () => resolve({ ok: true, socket: s }));
                    s.on('connect_error', (e) => {
                        s.close();
                        resolve({ ok: false, error: e.message });
                    });
                });
            const anon = await connect({});
            check('socket without token is refused', !anon.ok, anon.error);
            const authed = await connect({ auth: { token: student2Tok } });
            check('socket with token connects', authed.ok);
            if (authed.ok) {
                const ack = await new Promise((r) => authed.socket.emit('joinClass', String(cls._id), r));
                check('non-member joinClass is refused', ack && ack.ok === false, JSON.stringify(ack));
                authed.socket.close();
            }
            const member = await connect({ auth: { token: studentTok } });
            if (member.ok) {
                const ack = await new Promise((r) => member.socket.emit('joinClass', String(cls._id), r));
                check('member joinClass is accepted', ack && ack.ok === true, JSON.stringify(ack));
                member.socket.close();
            }
        }

        // ---- security headers / 404
        {
            const r = await api('GET', '/nope', { raw: true });
            check('unknown route → JSON 404', r.status === 404 && r.json.error);
            check('helmet headers present', r.headers.get('x-content-type-options') === 'nosniff' && !r.headers.get('x-powered-by'));
        }
    } catch (err) {
        const where = (err.stack || '').split(/\r?\n/)[1] || '';
        console.error('SMOKE TEST ABORTED:', err.message, err.cause ? `cause: ${err.cause.code || ''} ${err.cause.message || ''}` : '', where);
        results.push({ name: 'aborted', ok: false, extra: err.message });
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 1500));
        try {
            await mongoose.connection.db.dropDatabase();
        } catch {
            /* ignore */
        }
        await mongoose.disconnect();
        const failed = results.filter((r) => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        if (failed.length) {
            console.log('Failed:');
            failed.forEach((f) => console.log(`  - ${f.name}${f.extra ? ` (${f.extra})` : ''}`));
            if (process.env.SMOKE_VERBOSE) console.log('\n--- server log ---\n' + serverLog.slice(-8000));
        }
        process.exit(failed.length ? 1 : 0);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
