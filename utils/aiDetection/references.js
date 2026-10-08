'use strict';

/**
 * AI reference solution generation (question-derived prompts only; student code is never sent).
 *
 *  - startExamGeneration: teacher-triggered, every coding question × language × enabled provider ×
 *    prompt variant of one exam. Progress lives in AiGenerationJob 'exam:<id>' (polled by the UI).
 *  - maybeAutoGenerate: the first exam answer for a question + language with no references starts a
 *    generation for just that pair. De-duplicated in-process (one promise per pair, so 60 answers at
 *    once start one generation) and across processes (AiGenerationJob 'auto:<q>:<lang>' lock).
 */

const AiReference = require('../../models/AiReference');
const AiGenerationJob = require('../../models/AiGenerationJob');
const { callProvider, enabledProviders } = require('./providers');
const { buildPrompts, extractCode } = require('./prompts');

const ALL_LANGUAGES = AiReference.LANGUAGES;
const FALLBACK_LANGUAGES = ['python', 'javascript', 'cpp', 'java'];
const LOCK_MS = 15 * 60 * 1000;
const AUTO_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const MIN_CODE_CHARS = 15;
/** Question fields a prompt is built from (student-visible material only). */
const PROMPT_FIELDS = 'title description type inputFormat outputFormat constraints sampleIo examples testCases languages starterCode templateCode driverCode codeSnippet functionSignature';

/** Load a question for prompting; hidden test cases are dropped so they can never reach a provider. */
const loadPromptQuestion = async (questionId) => {
    const Question = require('../../models/Question');
    const q = await Question.findById(questionId).select(PROMPT_FIELDS).lean();
    if (!q) return null;
    return { ...q, testCases: (q.testCases || []).filter((t) => t?.isPublic) };
};

let settings = null;
const ai = () => {
    if (!settings) settings = require('../../config/env').ai;
    return settings;
};
const log = (...args) => console.warn('[ai-refs]', ...args);

/** Languages to generate for: the question's allowed languages, else the ones it has code for. */
const questionLanguages = (question, observed = []) => {
    const valid = (list) => [...new Set((list || []).filter((l) => ALL_LANGUAGES.includes(l)))];
    const allowed = valid(question.languages);
    if (allowed.length) return allowed;
    const withCode = valid([...(question.starterCode || []), ...(question.templateCode || []), ...(question.driverCode || [])].map((r) => r?.language));
    if (withCode.length) return withCode;
    const seen = valid(observed);
    return seen.length ? seen : FALLBACK_LANGUAGES;
};

/**
 * Claim a job key. Returns the job document, or null when another (unexpired) run holds it.
 */
const claimJob = async (key, fields) => {
    const now = new Date();
    try {
        return await AiGenerationJob.findOneAndUpdate(
            { key, $or: [{ status: { $ne: 'running' } }, { lockedUntil: { $lt: now } }] },
            {
                $set: {
                    ...fields,
                    status: 'running',
                    completed: 0,
                    failed: 0,
                    created: 0,
                    errorMessages: [],
                    startedAt: now,
                    finishedAt: null,
                    lockedUntil: new Date(now.getTime() + LOCK_MS),
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (err) {
        if (err?.code === 11000) return null; // someone else is running it
        throw err;
    }
};

const bumpJob = (jobId, inc, error) =>
    AiGenerationJob.updateOne(
        { _id: jobId },
        {
            $inc: inc,
            $set: { lockedUntil: new Date(Date.now() + LOCK_MS) },
            ...(error ? { $push: { errorMessages: { $each: [String(error).slice(0, 480)], $slice: -20 } } } : {}),
        }
    ).catch(() => {});

/** One provider call → one stored reference. Returns the reference or throws. */
const generateOne = async ({ question, language, provider, prompt, examId, userId }) => {
    const reply = await callProvider(provider, prompt);
    const code = extractCode(reply);
    if (!code || code.trim().length < MIN_CODE_CHARS) throw new Error(`${provider}: reply contained no usable code`);
    return AiReference.create({
        questionId: question._id,
        language,
        source: provider,
        model: ai()[provider]?.model,
        variant: prompt.variant,
        code: code.slice(0, 100000),
        examId: examId || undefined,
        createdBy: userId || undefined,
    });
};

/**
 * Work units for questions × languages × providers × variants, skipping (q, lang, provider) groups
 * that already have enough references unless `replace`.
 */
const planUnits = async ({ questions, languagesFor, providers, replace }) => {
    const variants = ai().variantsPerProvider || 3;
    const existing = await AiReference.aggregate([
        { $match: { questionId: { $in: questions.map((q) => q._id) }, source: { $in: providers } } },
        { $group: { _id: { q: '$questionId', l: '$language', s: '$source' }, n: { $sum: 1 } } },
    ]);
    const have = new Map(existing.map((e) => [`${e._id.q}:${e._id.l}:${e._id.s}`, e.n]));
    const units = [];
    const groups = [];
    for (const question of questions) {
        for (const language of languagesFor(question)) {
            const prompts = buildPrompts(question, language, variants);
            for (const provider of providers) {
                const count = have.get(`${question._id}:${language}:${provider}`) || 0;
                if (!replace && count >= prompts.length) continue;
                groups.push({ questionId: question._id, language, provider });
                const todo = replace ? prompts : prompts.slice(count);
                todo.forEach((prompt) => units.push({ question, language, provider, prompt }));
            }
        }
    }
    return { units, groups };
};

/**
 * Start generating references for an exam. Resolves once the job is claimed and planned:
 *   { job, total } — work continues in the background;
 * or throws an Error with .status (400 nothing to do / too many calls, 409 already running).
 */
const startExamGeneration = async ({ examId, questions, languages, replace = false, userId, observedLanguages = {} }) => {
    const providers = enabledProviders();
    if (!providers.length) throw Object.assign(new Error('No AI provider is configured on the server. Paste reference solutions instead.'), { status: 400 });
    const languagesFor = (q) => {
        const list = questionLanguages(q, observedLanguages[String(q._id)] || []);
        return languages?.length ? list.filter((l) => languages.includes(l)) : list;
    };
    const { units, groups } = await planUnits({ questions, languagesFor, providers, replace });
    if (!units.length) throw Object.assign(new Error('Every coding question already has AI references for its languages. Use "replace" to regenerate.'), { status: 400 });
    const cap = ai().maxCallsPerJob || 150;
    if (units.length > cap) {
        throw Object.assign(
            new Error(`That would make ${units.length} AI requests (limit ${cap}). Pick fewer questions or languages, or lower AI_REF_VARIANTS.`),
            { status: 400 }
        );
    }
    const job = await claimJob(`exam:${examId}`, { examId, total: units.length, providers, startedBy: userId });
    if (!job) throw Object.assign(new Error('AI references are already being generated for this exam'), { status: 409 });

    setImmediate(() => runExamJob({ job, units, groups, replace, examId, userId }).catch((err) => log('exam job crashed:', err?.message)));
    return { job, total: units.length };
};

const runExamJob = async ({ job, units, groups, replace, examId, userId }) => {
    if (replace) {
        // Drop the old generated references only for the groups being regenerated (never manual ones).
        await Promise.all(groups.map((g) => AiReference.deleteMany({ questionId: g.questionId, language: g.language, source: g.provider })));
    }
    let created = 0;
    await Promise.all(
        units.map((u) =>
            generateOne({ ...u, examId, userId })
                .then(() => {
                    created += 1;
                    return bumpJob(job._id, { completed: 1, created: 1 });
                })
                .catch((err) => bumpJob(job._id, { completed: 1, failed: 1 }, err?.message || err))
        )
    );
    await AiGenerationJob.updateOne(
        { _id: job._id },
        { $set: { status: created ? 'done' : 'error', finishedAt: new Date(), lockedUntil: null } }
    ).catch(() => {});
    // Re-score the exam's latest submissions against the new references.
    try {
        const { recheckExam, CODING_TYPES } = require('./checker');
        const Question = require('../../models/Question');
        const Exam = require('../../models/Exam');
        const exam = await Exam.findById(examId).select('questions').lean();
        if (exam) {
            const coding = await Question.find({ _id: { $in: exam.questions.map((q) => q.questionId) }, type: { $in: CODING_TYPES } }).select('_id').lean();
            await recheckExam(examId, coding.map((q) => q._id));
        }
    } catch (err) {
        log('recheck after generation failed:', err?.message);
    }
};

const autoInflight = new Map(); // key -> Promise<boolean> (decision), kept while this process generates

const runAuto = async ({ job, question, language, units }) => {
    let created = 0;
    await Promise.all(
        units.map((u) =>
            generateOne({ question, language, ...u })
                .then(() => {
                    created += 1;
                    return bumpJob(job._id, { completed: 1, created: 1 });
                })
                .catch((err) => bumpJob(job._id, { completed: 1, failed: 1 }, err?.message || err))
        )
    );
    await AiGenerationJob.updateOne({ _id: job._id }, { $set: { status: created ? 'done' : 'error', finishedAt: new Date(), lockedUntil: null } });
    const { recheckWaiting } = require('./checker');
    await recheckWaiting(question._id, language);
};

/**
 * Auto-generate references for one question + language if providers are configured, auto-generation
 * is on, and no generation for this pair ran recently. Resolves true when a generation is running
 * (started now, or already running here or in another process), false otherwise.
 * Concurrent calls for the same pair share one decision, so a burst of answers starts one generation.
 */
const maybeAutoGenerate = (question, language) => {
    const s = ai();
    const providers = enabledProviders();
    if (!s.autoGenerate || !providers.length) return Promise.resolve(false);
    const key = `auto:${question._id}:${language}`;
    if (autoInflight.has(key)) return autoInflight.get(key);

    let generatingHere = false;
    const decision = (async () => {
        const previous = await AiGenerationJob.findOne({ key }).select('status finishedAt lockedUntil').lean();
        if (previous?.status === 'running' && previous.lockedUntil && previous.lockedUntil > new Date()) return true; // another process
        if (previous?.finishedAt && Date.now() - new Date(previous.finishedAt).getTime() < AUTO_RETRY_AFTER_MS) return false;
        const full = await loadPromptQuestion(question._id);
        if (!full) return false;
        const prompts = buildPrompts(full, language, s.variantsPerProvider || 3);
        const units = providers.flatMap((provider) => prompts.map((prompt) => ({ provider, prompt })));
        const job = await claimJob(key, { questionId: question._id, language, total: units.length, providers });
        if (!job) return true; // claimed by another process a moment ago
        generatingHere = true;
        runAuto({ job, question: full, language, units })
            .catch((err) => log(`auto-generation ${key} failed:`, err?.message))
            .finally(() => autoInflight.delete(key));
        return true;
    })();
    autoInflight.set(key, decision);
    decision.then(
        () => {
            if (!generatingHere) autoInflight.delete(key);
        },
        () => autoInflight.delete(key)
    );
    return decision;
};

/** Current progress of an exam's generation job (or null). */
const examJobStatus = async (examId) => {
    const job = await AiGenerationJob.findOne({ key: `exam:${examId}` }).lean();
    if (!job) return null;
    const stale = job.status === 'running' && job.lockedUntil && job.lockedUntil < new Date();
    return {
        status: stale ? 'error' : job.status,
        total: job.total,
        completed: job.completed,
        failed: job.failed,
        created: job.created,
        errors: (job.errorMessages || []).slice(-5),
        providers: job.providers,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
    };
};

module.exports = { questionLanguages, startExamGeneration, maybeAutoGenerate, examJobStatus, planUnits, loadPromptQuestion, PROMPT_FIELDS };
