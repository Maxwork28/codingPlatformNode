'use strict';

/**
 * Student-safe view of a Question.
 *
 * Students must never receive: hidden test cases (input or expected output), solution text/code,
 * correct options / answers, explanation (until after a correct submit), hints beyond what the
 * teacher marked public, driver code, or exam-only flags. Everything else is whitelisted here.
 */

const STUDENT_FIELDS = [
    '_id',
    'title',
    'description',
    'difficulty',
    'tags',
    'points',
    'type',
    'options',
    'codeSnippet',
    'starterCode',
    'templateCode',
    'functionSignature',
    'constraints',
    'inputFormat',
    'outputFormat',
    'sampleIo',
    'examples',
    'languages',
    'timeLimit',
    'memoryLimit',
    'maxAttempts',
    'level',
    'createdAt',
    'updatedAt',
    'status',
];

/** Mongo projection string for queries that only serve students. */
const STUDENT_SELECT = [...STUDENT_FIELDS, 'classes', 'testCases', 'hints'].join(' ');

const publicTestCases = (testCases) =>
    (testCases || [])
        .filter((tc) => tc && tc.isPublic)
        .map((tc) => ({
            _id: tc._id,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            isPublic: true,
            isLargeTestCase: !!tc.isLargeTestCase,
        }));

/**
 * @param {object} question mongoose doc or plain object
 * @param {{classId?: string, includeHints?: boolean, extra?: object}} opts
 */
const sanitizeQuestionForStudent = (question, opts = {}) => {
    if (!question) return null;
    const q = typeof question.toObject === 'function' ? question.toObject() : question;
    const out = {};
    for (const key of STUDENT_FIELDS) {
        if (q[key] !== undefined) out[key] = q[key];
    }
    out.testCases = publicTestCases(q.testCases);
    out.hiddenTestCaseCount = (q.testCases || []).filter((tc) => tc && !tc.isPublic).length;
    out.hasDriverCode = Array.isArray(q.driverCode) && q.driverCode.some((d) => d && d.code);
    if (opts.includeHints) out.hints = q.hints || [];
    if (opts.classId) {
        const entry = (q.classes || []).find((c) => String(c.classId?._id || c.classId) === String(opts.classId));
        if (entry) {
            out.classSettings = {
                classId: entry.classId,
                isPublished: !!entry.isPublished,
                isDisabled: !!entry.isDisabled,
                publishedAt: entry.publishedAt,
            };
        }
    }
    return Object.assign(out, opts.extra || {});
};

module.exports = { sanitizeQuestionForStudent, publicTestCases, STUDENT_FIELDS, STUDENT_SELECT };
