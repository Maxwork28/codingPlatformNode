'use strict';

/**
 * Staff endpoints for AI-generated-code detection on exam coding answers.
 * Every handler requires a teacher who manages the exam's class (or an admin). Students never reach
 * these routes, and AI scores are never added to any student payload.
 */

const mongoose = require('mongoose');
const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const AiReference = require('../models/AiReference');
const { assertClassManager, isAdmin, idEq, httpError, notFound, sendError } = require('../utils/access');
const { checker, references: refs, providers } = require('../utils/aiDetection');

const { CODING_TYPES, QUESTION_FIELDS, latestExamSubmissions, recheckExam, scoreCode, comparableCode } = checker;
const LANGUAGES = AiReference.LANGUAGES;
const MAX_CODE = 100000;
const SOURCE_NAMES = { openai: 'ChatGPT', gemini: 'Gemini', anthropic: 'Claude', manual: 'Teacher-pasted' };

const fail = (res, err, tag) => sendError(res, err, 'AI check request failed', `aiCheck:${tag}`);

/** Exam (read-only) + authorization: class manager, admin, or the creator of a template exam. */
const loadExam = async (req) => {
    const exam = await Exam.findById(req.params.examId).select('title classId questions template createdBy').lean();
    if (!exam) throw notFound('Exam not found');
    if (isAdmin(req.user)) return exam;
    if (exam.template?.isTemplate && idEq(exam.createdBy, req.user._id)) return exam;
    await assertClassManager(req.user, exam.classId, 'teachers createdBy');
    return exam;
};

/** The exam's coding questions, in exam order. */
const codingQuestions = async (exam, extraFields = '') => {
    const order = new Map((exam.questions || []).map((q, i) => [String(q.questionId), (q.order ?? 0) * 10000 + i]));
    const docs = await Question.find({ _id: { $in: [...order.keys()] }, type: { $in: CODING_TYPES } })
        .select(`${QUESTION_FIELDS} ${extraFields}`)
        .lean();
    return docs.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
};

const median = (values) => {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** Median of `values` without one occurrence of `own` (the student's own score). */
const medianExcluding = (values, own) => {
    if (own == null) return median(values);
    const i = values.indexOf(own);
    if (i < 0) return median(values);
    return median([...values.slice(0, i), ...values.slice(i + 1)]);
};

/** Reference id → "ChatGPT reference #2" (numbered per question + language + source, oldest first). */
const referenceLabels = (list) => {
    const counters = new Map();
    const labels = new Map();
    [...list]
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .forEach((r) => {
            const k = `${r.questionId}:${r.language}:${r.source}`;
            const n = (counters.get(k) || 0) + 1;
            counters.set(k, n);
            labels.set(String(r._id), `${SOURCE_NAMES[r.source] || r.source} reference #${n}`);
        });
    return labels;
};

// ---------------------------------------------------------------------------
// GET /ai-check/config
// ---------------------------------------------------------------------------
exports.getConfig = async (req, res) => {
    try {
        const settings = require('../config/env').ai;
        const status = providers.providerStatus();
        res.json({
            providers: status,
            anyProvider: status.some((p) => p.enabled),
            autoGenerate: settings.autoGenerate && status.some((p) => p.enabled),
            variantsPerProvider: settings.variantsPerProvider,
            minTokens: settings.minTokens,
            languages: LANGUAGES,
        });
    } catch (err) {
        fail(res, err, 'config');
    }
};

// ---------------------------------------------------------------------------
// GET /ai-check/exams/:examId  — per-attempt AI summaries for the exam report
// ---------------------------------------------------------------------------
exports.getExamAiReport = async (req, res) => {
    try {
        const exam = await loadExam(req);
        const questions = await codingQuestions(exam);
        const qIds = questions.map((q) => q._id);
        const attempts = await ExamAttempt.find({ examId: exam._id }).select('_id').lean();
        const [rows, refList, generation] = await Promise.all([
            latestExamSubmissions(exam._id, qIds, { withCheck: true, attemptIds: attempts.map((a) => a._id) }),
            qIds.length ? AiReference.find({ questionId: { $in: qIds } }).select('questionId language source model createdAt').lean() : [],
            refs.examJobStatus(exam._id),
        ]);
        const labels = referenceLabels(refList);

        const done = new Map(); // questionId -> [percent]
        rows.forEach((r) => {
            if (r.aiCheck?.status === 'done' && Number.isFinite(r.aiCheck.percent)) {
                const k = String(r.questionId);
                if (!done.has(k)) done.set(k, []);
                done.get(k).push(r.aiCheck.percent);
            }
        });

        const byAttempt = {};
        rows.forEach((r) => {
            const c = r.aiCheck || {};
            const qk = String(r.questionId);
            const percent = c.status === 'done' && Number.isFinite(c.percent) ? c.percent : null;
            (byAttempt[String(r.examAttemptId)] ||= {})[qk] = {
                submissionId: r._id,
                language: r.language || null,
                submittedAt: r.submittedAt,
                status: c.status || 'not_checked',
                percent,
                matchedReferenceId: percent != null ? c.matchedReferenceId || null : null,
                matchedSource: percent != null ? c.matchedSource || null : null,
                matchedModel: percent != null ? c.matchedModel || null : null,
                matchedLabel: percent != null && c.matchedReferenceId ? labels.get(String(c.matchedReferenceId)) || null : null,
                perSource: percent != null ? c.perSource || {} : {},
                tokens: c.tokens ?? null,
                referenceCount: c.referenceCount ?? null,
                message: c.message || null,
                checkedAt: c.checkedAt || null,
                cohortMedian: medianExcluding(done.get(qk) || [], percent),
            };
        });

        res.json({
            examId: exam._id,
            byAttempt,
            questions: questions.map((q) => {
                const mine = refList.filter((r) => idEq(r.questionId, q._id));
                const bySource = {};
                const byLanguage = {};
                mine.forEach((r) => {
                    bySource[r.source] = (bySource[r.source] || 0) + 1;
                    byLanguage[r.language] = (byLanguage[r.language] || 0) + 1;
                });
                const qRows = rows.filter((r) => idEq(r.questionId, q._id));
                return {
                    questionId: q._id,
                    title: q.title,
                    type: q.type,
                    references: { total: mine.length, bySource, byLanguage },
                    cohortMedian: median(done.get(String(q._id)) || []),
                    checked: (done.get(String(q._id)) || []).length,
                    pending: qRows.filter((r) => r.aiCheck?.status === 'pending').length,
                    answers: qRows.length,
                };
            }),
            generation,
            anyProvider: providers.enabledProviders().length > 0,
            serverTime: new Date(),
        });
    } catch (err) {
        fail(res, err, 'report');
    }
};

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Languages students actually used per question in this exam (from their latest answers). */
const observedLanguages = async (exam, qIds) => {
    const rows = await latestExamSubmissions(exam._id, qIds);
    const out = {};
    rows.forEach((r) => {
        if (!r.language) return;
        const k = String(r.questionId);
        (out[k] ||= new Set()).add(r.language);
    });
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
};

exports.listReferences = async (req, res) => {
    try {
        const exam = await loadExam(req);
        const questions = await codingQuestions(exam);
        const qIds = questions.map((q) => q._id);
        const [list, observed, generation] = await Promise.all([
            AiReference.find({ questionId: { $in: qIds } }).sort({ createdAt: 1 }).populate('createdBy', 'name').lean(),
            observedLanguages(exam, qIds),
            refs.examJobStatus(exam._id),
        ]);
        const labels = referenceLabels(list);
        res.json({
            questions: questions.map((q) => {
                const used = observed[String(q._id)] || [];
                const mine = list.filter((r) => idEq(r.questionId, q._id));
                const languages = [...new Set([...refs.questionLanguages(q, used), ...used, ...mine.map((r) => r.language)])];
                return {
                    questionId: q._id,
                    title: q.title,
                    type: q.type,
                    languages,
                    answeredLanguages: used,
                    references: mine.map((r) => ({
                        _id: r._id,
                        language: r.language,
                        source: r.source,
                        model: r.model || null,
                        variant: r.variant ?? null,
                        label: labels.get(String(r._id)),
                        code: r.code,
                        createdAt: r.createdAt,
                        createdBy: r.createdBy ? { _id: r.createdBy._id, name: r.createdBy.name } : null,
                    })),
                };
            }),
            generation,
            providers: providers.providerStatus(),
        });
    } catch (err) {
        fail(res, err, 'listReferences');
    }
};

exports.addReference = async (req, res) => {
    try {
        const exam = await loadExam(req);
        const { questionId, language, code, label } = req.body || {};
        if (!mongoose.isValidObjectId(String(questionId || ''))) throw httpError(400, 'questionId is required');
        if (!LANGUAGES.includes(language)) throw httpError(400, 'Pick a valid language');
        if (typeof code !== 'string' || code.trim().length < 10) throw httpError(400, 'Paste the reference code (at least a few lines)');
        if (code.length > MAX_CODE) throw httpError(413, 'Reference code is too long');
        if (label !== undefined && label !== null && typeof label !== 'string') throw httpError(400, 'label must be text');
        const questions = await codingQuestions(exam);
        const question = questions.find((q) => idEq(q._id, questionId));
        if (!question) throw httpError(400, 'That question is not a coding question in this exam');

        const reference = await AiReference.create({
            questionId: question._id,
            language,
            source: 'manual',
            model: label ? String(label).trim().slice(0, 60) || undefined : undefined,
            code: code.replace(/\r\n?/g, '\n'),
            examId: exam._id,
            createdBy: req.user._id,
        });
        const rechecking = await recheckExam(exam._id, questions.map((q) => q._id), { questionId: question._id, language });
        res.status(201).json({
            reference: { _id: reference._id, questionId: reference.questionId, language, source: 'manual', model: reference.model || null, code: reference.code, createdAt: reference.createdAt },
            rechecking,
        });
    } catch (err) {
        fail(res, err, 'addReference');
    }
};

exports.deleteReference = async (req, res) => {
    try {
        const exam = await loadExam(req);
        const reference = await AiReference.findById(req.params.referenceId).select('questionId language').lean();
        if (!reference) throw notFound('Reference not found');
        const questions = await codingQuestions(exam);
        if (!questions.some((q) => idEq(q._id, reference.questionId))) throw notFound('Reference not found');
        await AiReference.deleteOne({ _id: reference._id });
        const rechecking = await recheckExam(exam._id, questions.map((q) => q._id), { questionId: reference.questionId, language: reference.language });
        res.json({ message: 'Reference deleted', rechecking });
    } catch (err) {
        fail(res, err, 'deleteReference');
    }
};

exports.generateReferences = async (req, res) => {
    try {
        const exam = await loadExam(req);
        const { questionIds, languages, replace } = req.body || {};
        let questions = await codingQuestions(exam, refs.PROMPT_FIELDS);
        if (!questions.length) throw httpError(400, 'This exam has no coding questions');
        if (Array.isArray(questionIds) && questionIds.length) {
            const wanted = new Set(questionIds.map(String));
            questions = questions.filter((q) => wanted.has(String(q._id)));
            if (!questions.length) throw httpError(400, 'None of those questions are coding questions in this exam');
        }
        const langs = Array.isArray(languages) ? languages.filter((l) => LANGUAGES.includes(l)) : null;
        // Only public test cases may appear in prompts (samples); hidden ones are dropped here.
        questions = questions.map((q) => ({ ...q, testCases: (q.testCases || []).filter((t) => t.isPublic) }));
        const observed = await observedLanguages(exam, questions.map((q) => q._id));
        const { total } = await refs.startExamGeneration({
            examId: exam._id,
            questions,
            languages: langs && langs.length ? langs : null,
            replace: Boolean(replace),
            userId: req.user._id,
            observedLanguages: observed,
        });
        res.status(202).json({ message: `Generating ${total} AI reference solution${total === 1 ? '' : 's'}`, generation: await refs.examJobStatus(exam._id) });
    } catch (err) {
        fail(res, err, 'generate');
    }
};

exports.generationStatus = async (req, res) => {
    try {
        const exam = await loadExam(req);
        res.json({ generation: await refs.examJobStatus(exam._id) });
    } catch (err) {
        fail(res, err, 'generationStatus');
    }
};

exports.recheckExam = async (req, res) => {
    try {
        const exam = await loadExam(req);
        const questions = await codingQuestions(exam);
        const queued = await recheckExam(exam._id, questions.map((q) => q._id));
        res.status(202).json({ message: queued ? `Re-checking ${queued} answer${queued === 1 ? '' : 's'}` : 'No coding answers to check yet', queued });
    } catch (err) {
        fail(res, err, 'recheck');
    }
};

// ---------------------------------------------------------------------------
// GET /ai-check/submissions/:submissionId?referenceId=  — side-by-side comparison
// ---------------------------------------------------------------------------
exports.getSubmissionComparison = async (req, res) => {
    try {
        const sub = await Submission.findById(req.params.submissionId).select('questionId language answer examAttemptId submittedAt +aiCheck').lean();
        if (!sub || !sub.examAttemptId) throw notFound('Submission not found');
        const attempt = await ExamAttempt.findById(sub.examAttemptId).select('examId').lean();
        if (!attempt) throw notFound('Submission not found');
        req.params.examId = String(attempt.examId);
        const exam = await loadExam(req);
        if (!(exam.questions || []).some((q) => idEq(q.questionId, sub.questionId))) throw notFound('Submission not found');
        const question = await Question.findById(sub.questionId).select(QUESTION_FIELDS).lean();
        if (!question || !CODING_TYPES.includes(question.type)) throw httpError(400, 'Not a coding answer');

        const list = await AiReference.find({ questionId: question._id, language: sub.language }).select('questionId language source model code createdAt').lean();
        const labels = referenceLabels(list);
        const studentCode = comparableCode(question, sub.language, sub.answer);
        const result = list.length ? scoreCode(question, sub.language, sub.answer, list, { withMatches: true }) : { status: 'no_references', scores: [] };
        const scored = (result.scores || []).sort((a, b) => b.percent - a.percent);
        const wanted = req.query.referenceId ? String(req.query.referenceId) : null;
        const selected = (wanted && scored.find((s) => String(s.reference._id) === wanted)) || scored[0] || null;

        res.json({
            submission: { _id: sub._id, language: sub.language, submittedAt: sub.submittedAt, code: studentCode },
            question: { _id: question._id, title: question.title, type: question.type },
            status: result.status,
            tokens: result.tokens ?? null,
            stored: sub.aiCheck ? { status: sub.aiCheck.status, percent: sub.aiCheck.percent ?? null, checkedAt: sub.aiCheck.checkedAt || null } : null,
            references: scored.map((s) => ({
                _id: s.reference._id,
                source: s.reference.source,
                model: s.reference.model || null,
                label: labels.get(String(s.reference._id)),
                percent: s.percent,
            })),
            selected: selected
                ? {
                      referenceId: selected.reference._id,
                      source: selected.reference.source,
                      model: selected.reference.model || null,
                      label: labels.get(String(selected.reference._id)),
                      percent: selected.percent,
                      code: comparableCode(question, sub.language, selected.reference.code),
                      matches: selected.matches,
                      detail: { tiling: selected.tiling, containStudent: selected.containA, containReference: selected.containB },
                  }
                : null,
        });
    } catch (err) {
        fail(res, err, 'comparison');
    }
};

exports._internals = { median, medianExcluding, referenceLabels };
