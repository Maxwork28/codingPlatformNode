const mongoose = require('mongoose');

const { ObjectId } = mongoose.Types;

const QUESTION_TYPES = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'];

/**
 * One bounded row per question the student has submitted in this class.
 * Full history lives in the Submission collection; this is only the aggregate the leaderboard needs.
 */
const questionStatSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    questionType: { type: String, enum: QUESTION_TYPES, default: 'coding' },
    bestScore: { type: Number, default: 0 },
    isCorrect: { type: Boolean, default: false }, // ever solved
    attempts: { type: Number, default: 0 }, // submit count (runs excluded)
    firstSolvedAt: { type: Date, default: null },
    lastSubmittedAt: { type: Date, default: null },
    bestSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
    bestSubmittedAt: { type: Date, default: null },
    lastPassedTestCases: { type: Number, default: 0 },
    lastTotalTestCases: { type: Number, default: 0 },
}, { _id: false });

const leaderboardSchema = new mongoose.Schema({
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    questions: [questionStatSchema],
    totalScore: { type: Number, default: 0 }, // always sum(questions.bestScore)
    correctAttempts: { type: Number, default: 0 },
    wrongAttempts: { type: Number, default: 0 },
    totalRuns: { type: Number, default: 0 },
    totalSubmits: { type: Number, default: 0 },
    activityStatus: { type: String, enum: ['active', 'inactive', 'focused'], default: 'inactive' },
    needsFocus: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now }
    // Legacy (pre-migration) documents may still carry `attempts[]` and `highestScores[]`.
    // They are not part of the schema: writes upgrade them in place (see legacyUpgradeStage) and
    // readers fall back to `highestScores` via questionRows(). scripts/migrate-leaderboard.js converts them in bulk.
});

leaderboardSchema.index({ classId: 1, totalScore: -1 });
leaderboardSchema.index({ classId: 1, studentId: 1 }, { unique: true });
leaderboardSchema.index({ activityStatus: 1 });
leaderboardSchema.index({ needsFocus: 1 });

/* ------------------------------------------------------------------ */
/* Aggregation-expression helpers (all writes are single atomic        */
/* pipeline updates: no read-modify-write, no VersionError retries).   */
/* ------------------------------------------------------------------ */

const lit = (v) => ({ $literal: v });
const num = (expr) => ({ $ifNull: [expr, 0] });
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v?._id ?? v)));

/** activityStatus derived from needsFocus / totalSubmits (call after totals are final). */
const activityStatusExpr = {
    $cond: [
        { $eq: ['$needsFocus', true] },
        'focused',
        { $cond: [{ $gt: [num('$totalSubmits'), 0] }, 'active', 'inactive'] },
    ],
};

/**
 * Pipeline stages that convert a legacy document (attempts[] / highestScores[]) into the bounded
 * `questions[]` shape and recompute its totals from the legacy history. No-op on new-shape documents.
 * Shared by every write path and by scripts/migrate-leaderboard.js.
 */
const legacyUpgradeStages = () => {
    const subs = { $filter: { input: { $ifNull: ['$attempts', []] }, as: 'a', cond: { $ne: ['$$a.isRun', true] } } };
    const legacy = { $or: [{ $isArray: '$attempts' }, { $isArray: '$highestScores' }] };
    // With history: one row per question that has at least one submit (run-only questions are dropped).
    // Without history (highestScores only): one row per highestScores entry.
    const qIds = {
        $setUnion: [
            {
                $cond: [
                    { $isArray: '$attempts' },
                    { $map: { input: subs, as: 'a', in: '$$a.questionId' } },
                    { $map: { input: { $ifNull: ['$highestScores', []] }, as: 'h', in: '$$h.questionId' } },
                ],
            },
        ],
    };
    const rowFor = {
        $let: {
            vars: {
                qs: { $filter: { input: subs, as: 'a', cond: { $eq: ['$$a.questionId', '$$qid'] } } },
                hs: { $arrayElemAt: [{ $filter: { input: { $ifNull: ['$highestScores', []] }, as: 'h', cond: { $eq: ['$$h.questionId', '$$qid'] } } }, 0] },
            },
            in: {
                $let: {
                    vars: {
                        solved: { $filter: { input: '$$qs', as: 'a', cond: { $eq: ['$$a.isCorrect', true] } } },
                        best: {
                            // highest score, latest on ties (same rule as the old pre-save hook)
                            $reduce: {
                                input: '$$qs',
                                initialValue: null,
                                in: {
                                    $cond: [
                                        {
                                            $or: [
                                                { $eq: ['$$value', null] },
                                                { $gt: [num('$$this.score'), num('$$value.score')] },
                                                {
                                                    $and: [
                                                        { $eq: [num('$$this.score'), num('$$value.score')] },
                                                        { $gte: ['$$this.submittedAt', '$$value.submittedAt'] },
                                                    ],
                                                },
                                            ],
                                        },
                                        '$$this',
                                        '$$value',
                                    ],
                                },
                            },
                        },
                        last: {
                            $reduce: {
                                input: '$$qs',
                                initialValue: null,
                                in: {
                                    $cond: [
                                        { $or: [{ $eq: ['$$value', null] }, { $gte: ['$$this.submittedAt', '$$value.submittedAt'] }] },
                                        '$$this',
                                        '$$value',
                                    ],
                                },
                            },
                        },
                        has: { $gt: [{ $size: '$$qs' }, 0] },
                    },
                    in: {
                        questionId: '$$qid',
                        questionType: {
                            $let: {
                                vars: { t: { $ifNull: ['$$last.questionType', 'coding'] } },
                                in: { $cond: [{ $in: ['$$t', QUESTION_TYPES] }, '$$t', 'coding'] },
                            },
                        },
                        bestScore: { $cond: ['$$has', num('$$best.score'), num('$$hs.score')] },
                        isCorrect: {
                            $cond: ['$$has', { $gt: [{ $size: '$$solved' }, 0] }, { $eq: ['$$hs.isCorrect', true] }],
                        },
                        attempts: { $cond: ['$$has', { $size: '$$qs' }, 1] },
                        firstSolvedAt: {
                            $cond: [
                                '$$has',
                                { $ifNull: [{ $min: '$$solved.submittedAt' }, null] },
                                { $cond: [{ $eq: ['$$hs.isCorrect', true] }, { $ifNull: ['$$hs.submittedAt', null] }, null] },
                            ],
                        },
                        lastSubmittedAt: { $cond: ['$$has', { $ifNull: ['$$last.submittedAt', null] }, { $ifNull: ['$$hs.submittedAt', null] }] },
                        bestSubmissionId: { $cond: ['$$has', '$$best.submissionId', '$$hs.submissionId'] },
                        bestSubmittedAt: { $cond: ['$$has', { $ifNull: ['$$best.submittedAt', null] }, { $ifNull: ['$$hs.submittedAt', null] }] },
                        lastPassedTestCases: num('$$last.passedTestCases'),
                        lastTotalTestCases: num('$$last.totalTestCases'),
                    },
                },
            },
        },
    };
    const hasHistory = { $isArray: '$attempts' };
    const countSubs = (cond) => ({ $size: { $filter: { input: subs, as: 'a', cond } } });
    return [
        {
            $set: {
                questions: { $cond: [legacy, { $map: { input: qIds, as: 'qid', in: rowFor } }, { $ifNull: ['$questions', []] }] },
                correctAttempts: { $cond: [hasHistory, countSubs({ $eq: ['$$a.isCorrect', true] }), num('$correctAttempts')] },
                wrongAttempts: { $cond: [hasHistory, countSubs({ $ne: ['$$a.isCorrect', true] }), num('$wrongAttempts')] },
                totalSubmits: { $cond: [hasHistory, { $size: subs }, num('$totalSubmits')] },
                totalRuns: {
                    $cond: [
                        hasHistory,
                        // runs were never pushed by recent code; keep the larger of history vs counter
                        { $max: [num('$totalRuns'), { $size: { $filter: { input: '$attempts', as: 'a', cond: { $eq: ['$$a.isRun', true] } } } }] },
                        num('$totalRuns'),
                    ],
                },
                needsFocus: { $eq: ['$needsFocus', true] },
            },
        },
        { $unset: ['attempts', 'highestScores'] },
    ];
};

/** Final stage: totalScore = sum(bestScore), activityStatus, updatedAt. */
const finalizeStages = (now) => [
    { $set: { totalScore: { $sum: '$questions.bestScore' }, updatedAt: now } },
    { $set: { activityStatus: activityStatusExpr } },
];

/** Replace the row for `qid` (or append one built from `{}`) using `build(prevExpr)`. */
const upsertRowStage = (qid, build) => ({
    $set: {
        questions: {
            $cond: [
                { $in: [qid, '$questions.questionId'] },
                {
                    $map: {
                        input: '$questions',
                        as: 'r',
                        in: { $cond: [{ $eq: ['$$r.questionId', qid] }, build('$$r'), '$$r'] },
                    },
                },
                { $concatArrays: ['$questions', [build({ $literal: {} })]] },
            ],
        },
    },
});

/* ------------------------------------------------------------------ */
/* Statics                                                             */
/* ------------------------------------------------------------------ */

/**
 * Record one practice submit atomically (upsert). Safe under any concurrency: the server applies the
 * whole pipeline to the document in one write, so totals and the per-question row never diverge.
 */
leaderboardSchema.statics.recordSubmit = async function recordSubmit({
    classId, studentId, questionId, questionType, submissionId, score, isCorrect, submittedAt,
    passedTestCases = 0, totalTestCases = 0,
}) {
    const qid = oid(questionId);
    const now = new Date();
    const at = submittedAt ? new Date(submittedAt) : now;
    const s = Number(score) || 0;
    const ok = Boolean(isCorrect);
    const type = QUESTION_TYPES.includes(questionType) ? questionType : 'coding';
    const build = (p) => ({
        $let: {
            vars: { p },
            in: {
                questionId: qid,
                questionType: lit(type),
                bestScore: { $max: [num('$$p.bestScore'), s] },
                isCorrect: { $or: [{ $eq: ['$$p.isCorrect', true] }, ok] },
                attempts: { $add: [num('$$p.attempts'), 1] },
                firstSolvedAt: ok
                    ? { $cond: [{ $gt: ['$$p.firstSolvedAt', null] }, { $min: ['$$p.firstSolvedAt', at] }, at] }
                    : { $ifNull: ['$$p.firstSolvedAt', null] },
                lastSubmittedAt: { $cond: [{ $gt: ['$$p.lastSubmittedAt', null] }, { $max: ['$$p.lastSubmittedAt', at] }, at] },
                bestSubmissionId: {
                    $cond: [{ $or: [{ $not: [{ $gt: ['$$p.bestSubmissionId', null] }] }, { $gte: [s, num('$$p.bestScore')] }] }, oid(submissionId), '$$p.bestSubmissionId'],
                },
                bestSubmittedAt: {
                    $cond: [{ $or: [{ $not: [{ $gt: ['$$p.bestSubmissionId', null] }] }, { $gte: [s, num('$$p.bestScore')] }] }, at, { $ifNull: ['$$p.bestSubmittedAt', null] }],
                },
                // "last" test-case counts follow the latest submission even if writes land out of order
                lastPassedTestCases: {
                    $cond: [{ $gt: [{ $ifNull: ['$$p.lastSubmittedAt', null] }, at] }, num('$$p.lastPassedTestCases'), Number(passedTestCases) || 0],
                },
                lastTotalTestCases: {
                    $cond: [{ $gt: [{ $ifNull: ['$$p.lastSubmittedAt', null] }, at] }, num('$$p.lastTotalTestCases'), Number(totalTestCases) || 0],
                },
            },
        },
    });
    const pipeline = [
        ...legacyUpgradeStages(),
        upsertRowStage(qid, build),
        {
            $set: {
                totalSubmits: { $add: [num('$totalSubmits'), 1] },
                correctAttempts: { $add: [num('$correctAttempts'), ok ? 1 : 0] },
                wrongAttempts: { $add: [num('$wrongAttempts'), ok ? 0 : 1] },
            },
        },
        ...finalizeStages(now),
    ];
    return upsertWithRetry(this, { classId, studentId }, pipeline);
};

/** Record one practice run: only bumps totalRuns (no history kept on the leaderboard). */
leaderboardSchema.statics.recordRun = async function recordRun({ classId, studentId }) {
    const now = new Date();
    return upsertWithRetry(this, { classId, studentId }, [
        {
            $set: {
                totalRuns: { $add: [num('$totalRuns'), 1] },
                totalSubmits: num('$totalSubmits'),
                totalScore: num('$totalScore'),
                correctAttempts: num('$correctAttempts'),
                wrongAttempts: num('$wrongAttempts'),
                needsFocus: { $eq: ['$needsFocus', true] },
                updatedAt: now,
            },
        },
        { $set: { activityStatus: activityStatusExpr } },
    ]);
};

/**
 * Staff marked a stored (non-run) submission correct. Atomically: the question row becomes solved,
 * bestScore/firstSolvedAt are updated, one wrong attempt becomes a correct one, totalScore is recomputed.
 * No-op when the student has no row for that question (same as before: no attempt → nothing to fix).
 */
leaderboardSchema.statics.markSubmissionCorrect = async function markSubmissionCorrect({
    classId, studentId, questionId, submissionId, score, submittedAt, totalTestCases = 0,
}) {
    const qid = oid(questionId);
    const now = new Date();
    const at = submittedAt ? new Date(submittedAt) : now;
    const s = Number(score) || 0;
    const tc = Number(totalTestCases) || 0;
    const build = (p) => ({
        $let: {
            vars: { p },
            in: {
                $mergeObjects: [
                    '$$p',
                    {
                        bestScore: { $max: [num('$$p.bestScore'), s] },
                        isCorrect: true,
                        firstSolvedAt: { $cond: [{ $gt: ['$$p.firstSolvedAt', null] }, { $min: ['$$p.firstSolvedAt', at] }, at] },
                        bestSubmissionId: { $cond: [{ $gte: [s, num('$$p.bestScore')] }, oid(submissionId), '$$p.bestSubmissionId'] },
                        bestSubmittedAt: { $cond: [{ $gte: [s, num('$$p.bestScore')] }, at, { $ifNull: ['$$p.bestSubmittedAt', null] }] },
                        ...(tc > 0
                            ? {
                                lastPassedTestCases: { $cond: [{ $gt: [{ $ifNull: ['$$p.lastSubmittedAt', null] }, at] }, num('$$p.lastPassedTestCases'), tc] },
                                lastTotalTestCases: { $cond: [{ $gt: [{ $ifNull: ['$$p.lastSubmittedAt', null] }, at] }, num('$$p.lastTotalTestCases'), tc] },
                            }
                            : {}),
                    },
                ],
            },
        },
    });
    const pipeline = [
        ...legacyUpgradeStages(),
        { $set: { _lbHasRow: { $in: [qid, '$questions.questionId'] } } },
        {
            $set: {
                questions: {
                    $map: { input: '$questions', as: 'r', in: { $cond: [{ $eq: ['$$r.questionId', qid] }, build('$$r'), '$$r'] } },
                },
                correctAttempts: { $add: [num('$correctAttempts'), { $cond: ['$_lbHasRow', 1, 0] }] },
                wrongAttempts: {
                    $max: [0, { $subtract: [num('$wrongAttempts'), { $cond: ['$_lbHasRow', 1, 0] }] }],
                },
            },
        },
        { $unset: '_lbHasRow' },
        ...finalizeStages(now),
    ];
    return this.updateOne({ classId, studentId }, pipeline);
};

/** Set needsFocus (creating the row if needed) and derive activityStatus in the same write. */
leaderboardSchema.statics.setNeedsFocus = async function setNeedsFocus({ classId, studentId, needsFocus }) {
    const now = new Date();
    return upsertWithRetry(this, { classId, studentId }, [
        {
            $set: {
                needsFocus: Boolean(needsFocus),
                totalScore: num('$totalScore'),
                correctAttempts: num('$correctAttempts'),
                wrongAttempts: num('$wrongAttempts'),
                totalRuns: num('$totalRuns'),
                totalSubmits: num('$totalSubmits'),
                updatedAt: now,
            },
        },
        { $set: { activityStatus: activityStatusExpr } },
    ]);
};

/** A question was deleted: drop its row (and legacy entries) and recompute totalScore. */
leaderboardSchema.statics.removeQuestion = async function removeQuestion({ classIds, questionId }) {
    const qid = oid(questionId);
    const now = new Date();
    const without = (field) => ({
        $cond: [
            { $isArray: field },
            { $filter: { input: field, as: 'x', cond: { $ne: ['$$x.questionId', qid] } } },
            '$$REMOVE',
        ],
    });
    return this.updateMany({ classId: { $in: classIds } }, [
        { $set: { questions: without('$questions'), attempts: without('$attempts'), highestScores: without('$highestScores') } },
        {
            $set: {
                totalScore: {
                    $cond: [
                        { $gt: [{ $size: { $ifNull: ['$questions', []] } }, 0] },
                        { $sum: '$questions.bestScore' },
                        { $sum: { $ifNull: ['$highestScores.score', []] } },
                    ],
                },
                updatedAt: now,
            },
        },
    ]);
};

/**
 * Concurrent upserts on {classId, studentId} are retried by the server (the filter matches the unique
 * index), but keep one client retry for older servers / sharded clusters that surface E11000.
 */
async function upsertWithRetry(Model, filter, pipeline) {
    try {
        return await Model.updateOne(filter, pipeline, { upsert: true });
    } catch (err) {
        if (err?.code !== 11000) throw err;
        return Model.updateOne(filter, pipeline, { upsert: true });
    }
}

/* ------------------------------------------------------------------ */
/* Read helpers (tolerate un-migrated documents)                       */
/* ------------------------------------------------------------------ */

/**
 * Normalised per-question rows for a lean leaderboard document. Falls back to legacy
 * `highestScores` when the document has not been migrated (empty / missing `questions`).
 */
leaderboardSchema.statics.questionRows = function questionRows(doc) {
    if (Array.isArray(doc?.questions) && doc.questions.length) return doc.questions;
    return (doc?.highestScores || []).filter((hs) => hs && hs.questionId).map((hs) => ({
        questionId: hs.questionId,
        questionType: undefined,
        bestScore: hs.score || 0,
        isCorrect: Boolean(hs.isCorrect),
        attempts: 1,
        firstSolvedAt: hs.isCorrect ? hs.submittedAt || null : null,
        lastSubmittedAt: hs.submittedAt || null,
        bestSubmissionId: hs.submissionId,
        bestSubmittedAt: hs.submittedAt || null,
    }));
};

/** Old response shape: `highestScores[]` derived from the bounded rows. */
leaderboardSchema.statics.highestScoresFrom = function highestScoresFrom(rows) {
    return (rows || []).map((r) => ({
        questionId: r.questionId,
        submissionId: r.bestSubmissionId,
        score: r.bestScore || 0,
        isCorrect: Boolean(r.isCorrect),
        submittedAt: r.bestSubmittedAt || r.lastSubmittedAt || null,
    }));
};

/** Projection that never pulls the unbounded legacy `attempts` array off disk. */
leaderboardSchema.statics.SAFE_PROJECTION = '-attempts';

leaderboardSchema.statics.legacyUpgradeStages = legacyUpgradeStages;
leaderboardSchema.statics.finalizeStages = finalizeStages;
leaderboardSchema.statics.LEGACY_FILTER = { $or: [{ attempts: { $exists: true } }, { highestScores: { $exists: true } }] };
leaderboardSchema.statics.QUESTION_TYPES = QUESTION_TYPES;

module.exports = mongoose.model('Leaderboard', leaderboardSchema);
