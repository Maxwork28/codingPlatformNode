'use strict';

/**
 * What each judge job kind does once a worker has claimed it: load the tests, run the judge,
 * write Submissions / leaderboard / exam answers, and build the client-facing result (the same
 * payload the synchronous endpoints used to return) plus the Socket.IO events to send.
 *
 * Handlers return { result, events } or throw JobError(status, message).
 */

const mongoose = require('mongoose');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Class = require('../models/Class');
const Leaderboard = require('../models/Leaderboard');
const ExamAttempt = require('../models/ExamAttempt');
const { runJudge, compactTestResultsForStorage } = require('../utils/judge');
const { sanitizeTestResultsForStudent, overallStatus } = require('../utils/judgeResults');
const { JobError } = require('./judgeJobs');

const CLOSED_STATUSES = ['submitted', 'auto_submitted', 'terminated', 'expired'];

// ---------------------------------------------------------------------------
// Test data (cached per question version so big test sets are not re-read for every job)
// ---------------------------------------------------------------------------

const TEST_CACHE_MAX_BYTES = (Number.parseInt(process.env.JUDGE_TEST_MEMORY_CACHE_MB, 10) || 64) * 1024 * 1024;
const testCache = new Map(); // questionId -> { version, testCases, checker, bytes }
let testCacheBytes = 0;

const sizeOfTests = (tests) => tests.reduce((n, t) => n + String(t.input ?? '').length + String(t.expectedOutput ?? '').length, 0);

const loadQuestionTests = async (questionId) => {
    const meta = await Question.findById(questionId).select('updatedAt').lean();
    if (!meta) throw new JobError(404, 'Question not found');
    const version = String(meta.updatedAt?.getTime?.() ?? meta.updatedAt ?? '');
    const id = String(questionId);
    const hit = testCache.get(id);
    if (hit && hit.version === version) {
        testCache.delete(id); // refresh LRU order
        testCache.set(id, hit);
        return hit;
    }
    const doc = await Question.findById(questionId).select('testCases checker updatedAt').lean();
    if (!doc) throw new JobError(404, 'Question not found');
    const testCases = (doc.testCases || []).map((t) => ({ input: t.input, expectedOutput: t.expectedOutput, isPublic: t.isPublic !== false }));
    const entry = { version, testCases, checker: doc.checker || null, bytes: sizeOfTests(testCases) };
    if (hit) testCacheBytes -= hit.bytes;
    if (entry.bytes <= TEST_CACHE_MAX_BYTES / 4) {
        testCache.set(id, entry);
        testCacheBytes += entry.bytes;
        for (const [key, value] of testCache) {
            if (testCacheBytes <= TEST_CACHE_MAX_BYTES) break;
            testCache.delete(key);
            testCacheBytes -= value.bytes;
        }
    } else {
        testCache.delete(id);
    }
    return entry;
};

/**
 * spec.testSet: 'public' | 'all' | 'probe' (first public test, for teacher benchmarks) | 'custom'
 * Custom-input runs use spec.customTests; the question's checker still applies.
 */
const resolveTests = async (spec) => {
    const q = spec.questionId ? await loadQuestionTests(spec.questionId) : { testCases: [], checker: null };
    const checker = spec.checker || q.checker || null;
    if (spec.testSet === 'custom') return { tests: spec.customTests || [], checker };
    const all = q.testCases;
    if (spec.testSet === 'public') {
        const pub = all.filter((t) => t.isPublic);
        if (!pub.length) {
            if (spec.publicFallbackToAll && all.length) return { tests: all, checker };
            throw new JobError(400, spec.noTestsMessage || 'No public test cases available for this question');
        }
        return { tests: pub, checker };
    }
    if (spec.testSet === 'probe') {
        const probe = all.find((t) => t.isPublic) || all[0];
        if (!probe) throw new JobError(400, 'Question has no test cases. Please add at least one test case.');
        return { tests: [probe], checker };
    }
    if (!all.length) throw new JobError(400, 'Question has no test cases. Please add at least one test case.');
    return { tests: all, checker };
};

const runSpec = (spec, tests, checker, extra = {}) =>
    runJudge({
        language: spec.language,
        code: spec.code,
        tests,
        timeLimit: spec.timeLimit,
        memoryLimit: spec.memoryLimit,
        wrapStdin: !!spec.wrapStdin,
        repeats: spec.repeats,
        stopOnFirstFail: !!spec.stopOnFirstFail,
        checker,
        ...extra,
    });

/** Practice runs are kept RUN_RETENTION_DAYS (default 30; 0 = forever). Submits and exam answers are permanent. */
const runExpiresAt = () => {
    const days = Number(process.env.RUN_RETENTION_DAYS ?? 30);
    return Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000) : undefined;
};

const staffRoom = (classId) => `class:${classId}:staff`;

const submissionJson = (submission) => {
    const json = submission.toObject();
    delete json.testResults;
    delete json.aiCheck;
    return json;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const practiceRun = async (job) => {
    const { spec, context: c } = job;
    const { tests, checker } = await resolveTests(spec);
    let testResults;
    try {
        testResults = await runSpec(spec, tests, checker);
    } catch (err) {
        throw new JobError(500, 'Code execution failed');
    }
    const passedCount = testResults.filter((t) => t.passed).length;
    const isCorrect = testResults.length > 0 && testResults.every((t) => t.passed);
    const sanitized = compactTestResultsForStorage(sanitizeTestResultsForStudent(testResults));

    const submission = await Submission.create({
        questionId: c.questionId,
        classId: c.classId,
        studentId: c.studentId,
        answer: c.answer,
        language: spec.language,
        isCorrect,
        score: 0,
        output: JSON.stringify(sanitized),
        isRun: true,
        passedTestCases: passedCount,
        totalTestCases: testResults.length,
        status: overallStatus(testResults),
        testResults: sanitized,
        expiresAt: runExpiresAt(),
    });
    await Class.updateOne({ _id: c.classId }, { $inc: { totalRuns: 1 } });
    await Leaderboard.recordRun({ classId: c.classId, studentId: c.studentId });

    return {
        result: {
            message: 'Code run successfully',
            submission: submissionJson(submission),
            testResults: sanitized,
            passedTestCases: passedCount,
            totalTestCases: testResults.length,
            publicTestCases: testResults.filter((t) => t.isPublic).length,
            hiddenTestCases: testResults.filter((t) => !t.isPublic).length,
            isCorrect,
            explanation: c.explanation,
        },
        events: [
            { room: staffRoom(c.classId), event: 'analyticsUpdated', payload: { classId: c.classId } },
            {
                room: staffRoom(c.classId),
                event: 'codeRun',
                payload: { classId: c.classId, studentId: c.studentId, submissionId: submission._id, isCorrect, passedTestCases: passedCount, totalTestCases: testResults.length },
            },
        ],
    };
};

const practiceCustom = async (job) => {
    const { spec, context: c } = job;
    const { tests, checker } = await resolveTests(spec);
    let testResults;
    try {
        testResults = await runSpec(spec, tests, checker);
    } catch (err) {
        throw new JobError(500, 'Code execution failed');
    }
    const compact = compactTestResultsForStorage(testResults);
    const customResult = compact[0];
    const submission = await Submission.create({
        questionId: c.questionId,
        classId: c.classId,
        studentId: c.studentId,
        answer: c.answer,
        language: spec.language,
        isCorrect: Boolean(customResult?.passed) && c.hasExpectedOutput,
        score: 0,
        output: JSON.stringify(compact),
        isRun: true,
        isCustomInput: true,
        passedTestCases: customResult?.passed ? 1 : 0,
        totalTestCases: 1,
        status: overallStatus(testResults),
        testResults: compact,
        expiresAt: runExpiresAt(),
    });
    await Class.updateOne({ _id: c.classId }, { $inc: { totalRuns: 1 } });
    await Leaderboard.recordRun({ classId: c.classId, studentId: c.studentId });

    return {
        result: {
            message: 'Code run with custom input successfully',
            submission: submissionJson(submission),
            testResults: customResult,
            actualOutput: customResult?.output,
            timeMs: customResult?.timeMs ?? null,
            memoryKb: customResult?.memoryKb ?? null,
            explanation: c.explanation,
        },
        // Staff only; the student's custom input is not broadcast.
        events: [{ room: staffRoom(c.classId), event: 'customInputRun', payload: { classId: c.classId, studentId: c.studentId, submissionId: submission._id } }],
    };
};

const practiceSubmit = async (job) => {
    const { spec, context: c } = job;
    const { tests, checker } = await resolveTests(spec);
    const points = Number(c.points) || 0;
    let isCorrect = false;
    let score = 0;
    let passedTestCases = 0;
    let totalTestCases = tests.length;
    let status;
    let output;
    let testResults = null;
    try {
        testResults = await runSpec(spec, tests, checker);
        totalTestCases = testResults.length;
        passedTestCases = testResults.filter((t) => t.passed).length;
        isCorrect = totalTestCases > 0 && testResults.every((t) => t.passed);
        score = isCorrect ? points : totalTestCases ? Math.floor((passedTestCases / totalTestCases) * points) : 0;
        status = overallStatus(testResults);
        output = JSON.stringify(compactTestResultsForStorage(sanitizeTestResultsForStudent(testResults)));
    } catch (err) {
        const lower = String(err?.message || '').toLowerCase();
        status = lower.includes('timeout') ? 'tle' : lower.includes('memory') || lower.includes('oom') || lower.includes('killed') ? 'mle' : 'runtime_error';
        output = 'Error: code execution failed';
        passedTestCases = 0;
    }

    const submission = await Submission.create({
        questionId: c.questionId,
        classId: c.classId,
        studentId: c.studentId,
        answer: c.answer,
        language: spec.language,
        isCorrect,
        score,
        output,
        isRun: false,
        passedTestCases,
        totalTestCases,
        status: status || (isCorrect ? 'accepted' : 'wrong_answer'),
        testResults: testResults ? compactTestResultsForStorage(testResults) : undefined,
    });
    await Class.updateOne({ _id: c.classId }, { $inc: { totalSubmits: 1 } });
    await Leaderboard.recordSubmit({
        classId: c.classId,
        studentId: c.studentId,
        questionId: c.questionId,
        questionType: c.questionType,
        submissionId: submission._id,
        isCorrect,
        score,
        submittedAt: submission.submittedAt,
        passedTestCases,
        totalTestCases,
    });

    const sanitized = testResults ? compactTestResultsForStorage(sanitizeTestResultsForStudent(testResults)) : null;
    return {
        result: {
            message: 'Answer submitted successfully',
            submission: submissionJson(submission),
            passedTestCases,
            totalTestCases,
            explanation: c.explanation,
            ...(sanitized
                ? {
                    testResults: sanitized,
                    publicTestCases: testResults.filter((t) => t.isPublic).length,
                    hiddenTestCases: testResults.filter((t) => !t.isPublic).length,
                }
                : {}),
        },
        events: [
            { room: staffRoom(c.classId), event: 'analyticsUpdated', payload: { classId: c.classId } },
            {
                room: staffRoom(c.classId),
                event: 'submissionUpdate',
                payload: { classId: c.classId, studentId: c.studentId, submissionId: submission._id, isCorrect, passedTestCases, totalTestCases },
            },
        ],
    };
};

const examRun = async (job) => {
    const { spec } = job;
    const { tests, checker } = await resolveTests(spec);
    let rows;
    try {
        rows = await runSpec(spec, tests, checker);
    } catch (err) {
        throw new JobError(422, `Your code could not be run: ${err.message}`);
    }
    return { result: { custom: spec.testSet === 'custom', questionId: job.context.questionId, testResults: compactTestResultsForStorage(sanitizeTestResultsForStudent(rows)) } };
};

const toId = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * Grade a saved exam answer. The answer itself was stored instantly by submit-answer; this fills in
 * the score. A newer save of the same question replaced the answer entry (different submissionId),
 * so a superseded grade only updates its own Submission. Closed attempts get their total recomputed.
 */
const examGrade = async (job) => {
    const { spec, context: c } = job;
    const maxScore = Number(c.maxScore) || 0;
    let graded;
    try {
        const { tests, checker } = await resolveTests(spec);
        const rows = await runSpec(spec, tests, checker);
        const passed = rows.filter((t) => t.passed).length;
        const total = rows.length;
        const isCorrect = total > 0 && passed === total;
        const shown = compactTestResultsForStorage(sanitizeTestResultsForStudent(rows));
        graded = {
            isCorrect,
            score: isCorrect ? maxScore : total ? Math.floor((passed / total) * maxScore) : 0,
            passedTestCases: passed,
            totalTestCases: total,
            status: overallStatus(rows),
            output: JSON.stringify(shown),
            testResults: shown,
            rawResults: compactTestResultsForStorage(rows),
            gradingStatus: 'done',
            gradingError: null,
        };
    } catch (err) {
        if (err instanceof JobError && err.status === 404) throw err;
        graded = {
            isCorrect: false,
            score: 0,
            passedTestCases: 0,
            totalTestCases: Number(c.totalTestCases) || 0,
            status: 'runtime_error',
            output: `Error: ${err.message}`,
            testResults: null,
            rawResults: undefined,
            gradingStatus: 'error',
            gradingError: 'Your code could not be run. Check it compiles and try again.',
        };
    }

    await Submission.updateOne(
        { _id: c.submissionId },
        {
            $set: {
                isCorrect: graded.isCorrect,
                score: graded.score,
                output: graded.output,
                passedTestCases: graded.passedTestCases,
                totalTestCases: graded.totalTestCases,
                status: graded.status,
                ...(graded.rawResults ? { testResults: graded.rawResults } : {}),
            },
        }
    );

    // Raw driver updates: bump the optimistic-concurrency version so a concurrent document save
    // (finalize / another answer) reloads instead of overwriting this grade.
    const attempts = ExamAttempt.collection;
    const applied = await attempts.updateOne(
        { _id: toId(c.attemptId), 'answers.submissionId': toId(c.submissionId) },
        {
            $set: {
                'answers.$.score': graded.score,
                'answers.$.isCorrect': graded.isCorrect,
                'answers.$.passedTestCases': graded.passedTestCases,
                'answers.$.totalTestCases': graded.totalTestCases,
                'answers.$.gradingStatus': graded.gradingStatus,
                'answers.$.gradingError': graded.gradingError,
                updatedAt: new Date(),
            },
            $inc: { __v: 1 },
        }
    );
    if (applied.modifiedCount) {
        await attempts.updateOne({ _id: toId(c.attemptId), status: { $in: CLOSED_STATUSES } }, [
            { $set: { totalScore: { $sum: '$answers.score' }, __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] } } },
        ]);
    }

    return {
        result: {
            examId: c.examId,
            attemptId: c.attemptId,
            questionId: c.questionId,
            submissionId: c.submissionId,
            gradingStatus: graded.gradingStatus,
            passedTestCases: graded.passedTestCases,
            totalTestCases: graded.totalTestCases,
            testResults: graded.testResults,
            executionError: graded.gradingError,
            superseded: !applied.modifiedCount,
        },
    };
};

/** Staff tools: just run and hand back the (compacted) rows; the controller shapes the response. */
const rawRun = async (job) => {
    const { spec } = job;
    const { tests, checker } = await resolveTests(spec);
    const repeatSummaries = [];
    let rows;
    try {
        rows = await runSpec(spec, tests, checker, spec.repeats > 1 ? { repeatSummaries } : {});
    } catch (err) {
        const missingImage = /No such image|not found\. Build the judge images/i.test(err?.message || '');
        throw new JobError(500, missingImage ? 'Code execution failed: Docker image not found. Please build Docker images first.' : 'Code execution failed');
    }
    return { result: { testResults: compactTestResultsForStorage(rows), repeatSummaries: spec.repeats > 1 ? repeatSummaries : undefined } };
};

const handlers = {
    'practice-run': practiceRun,
    'practice-custom': practiceCustom,
    'practice-submit': practiceSubmit,
    'exam-run': examRun,
    'exam-grade': examGrade,
    'teacher-test': rawRun,
    'teacher-custom': rawRun,
    'staff-rejudge': rawRun,
};

module.exports = { handlers, resolveTests, loadQuestionTests };
