'use strict';

/**
 * Scores exam coding submissions against the AI reference solutions for their question + language
 * and stores the result on Submission.aiCheck. Runs in an in-process queue with bounded concurrency;
 * nothing here ever throws into the request that triggered it.
 */

const mongoose = require('mongoose');
const Submission = require('../../models/Submission');
const Question = require('../../models/Question');
const AiReference = require('../../models/AiReference');
const ExamAttempt = require('../../models/ExamAttempt');
const { buildFillTheCodeProgram } = require('../answerText');
const { createKeyedQueue } = require('./queue');
const { buildBoilerplate, prepare, comparePrepared, VERSION } = require('./similarity');
const { boilerplateSources } = require('./prompts');

const CODING_TYPES = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'];
const QUESTION_FIELDS = 'title type languages starterCode templateCode driverCode codeSnippet functionSignature';

let settings = null;
const ai = () => {
    if (!settings) settings = require('../../config/env').ai;
    return settings;
};

const log = (...args) => console.warn('[ai-check]', ...args);

let queue = null;
const getQueue = () =>
    queue ||
    (queue = createKeyedQueue({
        concurrency: ai().checkConcurrency || 2,
        onError: (err, key) => log(`task ${key} failed:`, err?.message || err),
    }));

/** The text that is actually compared (fill-the-code answers are expanded into the full program). */
const comparableCode = (question, language, code) => {
    const text = typeof code === 'string' ? code : code == null ? '' : String(code);
    if (question.type === 'fillInTheBlanksCoding') {
        try {
            return buildFillTheCodeProgram(question, text, language);
        } catch {
            return text;
        }
    }
    return text;
};

/**
 * Score one code text against references (all for the same question + language).
 * @returns {{status, percent, matchedReferenceId, matchedSource, matchedModel, perSource, matches, tokens, referenceCount, scores}}
 */
const scoreCode = (question, language, code, references, { withMatches = true, minTokens } = {}) => {
    const bp = buildBoilerplate(boilerplateSources(question, language), language);
    const student = prepare(comparableCode(question, language, code), language, bp);
    const min = minTokens ?? ai().minTokens ?? 25;
    if (student.ids.length < min) {
        return { status: 'too_short', percent: null, tokens: student.ids.length, referenceCount: references.length, scores: [], student };
    }
    const scores = [];
    let best = null;
    const perSource = {};
    for (const ref of references) {
        const r = prepare(comparableCode(question, language, ref.code), language, bp);
        if (r.ids.length < Math.min(min, 10)) continue; // a reference that is all boilerplate says nothing
        const result = comparePrepared(student, r, { withMatches });
        scores.push({ reference: ref, prepared: r, ...result });
        perSource[ref.source] = Math.max(perSource[ref.source] ?? 0, result.percent);
        if (!best || result.percent > best.result.percent) best = { ref, result };
    }
    if (!best) return { status: 'no_references', percent: null, tokens: student.ids.length, referenceCount: 0, scores, student };
    return {
        status: 'done',
        percent: best.result.percent,
        matchedReferenceId: best.ref._id,
        matchedSource: best.ref.source,
        matchedModel: best.ref.model || null,
        perSource,
        matches: best.result.matches,
        tokens: student.ids.length,
        referenceCount: scores.length,
        scores,
        student,
    };
};

const saveCheck = (submissionId, aiCheck) =>
    Submission.updateOne({ _id: submissionId }, { $set: { aiCheck: { ...aiCheck, checkedAt: new Date(), version: VERSION } } });

/** Check one submission now. */
const checkSubmission = async (submissionId) => {
    const sub = await Submission.findById(submissionId).select('questionId language answer examAttemptId isRun +aiCheck').lean();
    if (!sub || !sub.examAttemptId || sub.isRun) return null;
    const question = await Question.findById(sub.questionId).select(QUESTION_FIELDS).lean();
    if (!question || !CODING_TYPES.includes(question.type)) return null;
    const language = sub.language;
    if (!language) {
        await saveCheck(sub._id, { status: 'error', message: 'Submission has no language' });
        return null;
    }
    const references = await AiReference.find({ questionId: question._id, language }).select('source model code createdAt').lean();
    if (!references.length) {
        const { maybeAutoGenerate } = require('./references');
        const started = await maybeAutoGenerate(question, language).catch((err) => {
            log('auto-generation could not start:', err?.message);
            return false;
        });
        await saveCheck(
            sub._id,
            started
                ? { status: 'pending', message: 'Generating AI reference solutions…' }
                : { status: 'no_references', message: `No AI reference solutions for ${language} yet` }
        );
        return null;
    }
    const result = scoreCode(question, language, sub.answer, references);
    const { scores: _scores, student: _student, ...stored } = result;
    await saveCheck(sub._id, stored);
    return stored;
};

/** Queue a check (de-duplicated per submission). Never throws. */
const enqueueCheck = (submissionId) => {
    const key = String(submissionId);
    return getQueue().push(key, () =>
        checkSubmission(key).catch(async (err) => {
            log(`check ${key} failed:`, err?.message || err);
            await saveCheck(key, { status: 'error', message: 'The AI check failed; use Re-check to try again' }).catch(() => {});
        })
    );
};

/**
 * Called fire-and-forget right after an exam coding answer is saved. Marks it pending and queues the
 * check; returns immediately and never throws.
 */
const scheduleAiCheck = ({ submissionId } = {}) => {
    try {
        if (!submissionId || !mongoose.isValidObjectId(String(submissionId))) return;
        Submission.updateOne({ _id: submissionId, aiCheck: { $exists: false } }, { $set: { aiCheck: { status: 'pending', version: VERSION } } })
            .catch(() => {})
            .finally(() => enqueueCheck(submissionId));
    } catch (err) {
        log('schedule failed:', err?.message);
    }
};

/**
 * Latest non-run submission per (attempt, coding question) of an exam.
 * @returns {Promise<Array<{_id, examAttemptId, questionId, language, aiCheck?}>>}
 */
const latestExamSubmissions = async (examId, codingQuestionIds, { withCheck = false, attemptIds } = {}) => {
    const ids =
        attemptIds ||
        (await ExamAttempt.find({ examId }).select('_id').lean()).map((a) => a._id);
    if (!ids.length || !codingQuestionIds.length) return [];
    const rows = await Submission.aggregate([
        { $match: { examAttemptId: { $in: ids }, questionId: { $in: codingQuestionIds.map((q) => new mongoose.Types.ObjectId(String(q))) }, isRun: { $ne: true } } },
        { $sort: { submittedAt: -1, _id: -1 } },
        {
            $group: {
                _id: { a: '$examAttemptId', q: '$questionId' },
                submissionId: { $first: '$_id' },
                language: { $first: '$language' },
                submittedAt: { $first: '$submittedAt' },
                ...(withCheck ? { aiCheck: { $first: '$aiCheck' } } : {}),
            },
        },
    ]);
    return rows.map((r) => ({
        _id: r.submissionId,
        examAttemptId: r._id.a,
        questionId: r._id.q,
        language: r.language,
        submittedAt: r.submittedAt,
        ...(withCheck ? { aiCheck: r.aiCheck || null } : {}),
    }));
};

/** Re-check the latest submissions of an exam (optionally one question / language). Returns the count queued. */
const recheckExam = async (examId, codingQuestionIds, { questionId, language } = {}) => {
    let rows = await latestExamSubmissions(examId, codingQuestionIds);
    if (questionId) rows = rows.filter((r) => String(r.questionId) === String(questionId));
    if (language) rows = rows.filter((r) => r.language === language);
    if (!rows.length) return 0;
    await Submission.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { 'aiCheck.status': 'pending', 'aiCheck.version': VERSION } });
    rows.forEach((r) => enqueueCheck(r._id));
    return rows.length;
};

/** After references appear for a question + language: re-check exam submissions still waiting for them. */
const recheckWaiting = async (questionId, language) => {
    const rows = await Submission.find({
        questionId,
        language,
        examAttemptId: { $exists: true, $ne: null },
        isRun: { $ne: true },
        'aiCheck.status': { $in: ['pending', 'no_references'] },
    })
        .select('_id')
        .lean();
    rows.forEach((r) => enqueueCheck(r._id));
    return rows.length;
};

module.exports = {
    CODING_TYPES,
    QUESTION_FIELDS,
    comparableCode,
    scoreCode,
    checkSubmission,
    enqueueCheck,
    scheduleAiCheck,
    latestExamSubmissions,
    recheckExam,
    recheckWaiting,
    queueStats: () => getQueue().stats(),
    idle: () => getQueue().idle(),
};
