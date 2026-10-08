const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Class = require('../models/Class');
const Submission = require('../models/Submission');
const Question = require('../models/Question');
const { mergeDriverWithUserAnswer } = require('../utils/codingDriverMerge');
const { parseOptionalPoints } = require('../utils/optionalPoints');
const { examPhase } = require('../utils/examPhase');
const { typedAnswerMatches, buildFillTheCodeProgram, fillTemplateFor } = require('../utils/answerText');
const { scheduleAiCheck } = require('../utils/aiDetection');
const seb = require('../utils/seb');
const SebEntryThrottle = require('../models/SebEntryThrottle');
const {
    executeDockerCode,
    shouldMergeDriverForLanguage,
    shouldWrapBareArrayStdinForQuestion,
    sanitizeTestResultsForStudent
} = require('./questionController');

const { compactTestResultsForStorage } = require('../utils/judge');

const CODING_TYPES = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'];
const CLOSED_STATUSES = ['submitted', 'auto_submitted', 'terminated', 'expired'];
const VIOLATION_TYPES = ['tab_switch', 'fullscreen_exit', 'copy_paste', 'network_loss', 'heartbeat'];
const EDITABLE_STATUSES = ['draft', 'scheduled', 'completed', 'archived'];
// Requests in flight when the clock runs out are still accepted for this long.
const GRACE_MS = 15 * 1000;
const MAX_DURATION_MINUTES = 24 * 60;

const OBJECT_ID = /^[a-f\d]{24}$/i;
const isObjectId = (value) => OBJECT_ID.test(String(value ?? ''));
const idOf = (value) => String(value?._id ?? value);
const sameId = (a, b) => a != null && b != null && idOf(a) === idOf(b);
const isClosed = (attempt) => CLOSED_STATUSES.includes(attempt.status);
const toPlain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value);
const bool = (value, fallback) => (value === undefined || value === null ? fallback : Boolean(value));
const clampInt = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
// Strings must carry an explicit zone ("Z" or "+05:30"); an offset-less "2026-10-07T10:00" would be
// read in the server's zone (UTC on EC2) while the author meant local time.
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const parseDate = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !HAS_ZONE.test(value)) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * Save an attempt, retrying on optimistic-concurrency conflicts by re-reading the document and
 * re-applying `apply(fresh)`. Returns the saved document.
 */
const saveAttemptWithRetry = async (attempt, apply, tries = 3) => {
    let doc = attempt;
    for (let i = 0; i < tries; i += 1) {
        try {
            await doc.save();
            return doc;
        } catch (err) {
            if (err?.name !== 'VersionError' || i === tries - 1) throw err;
            doc = await ExamAttempt.findById(attempt._id);
            if (!doc) throw clientError('Attempt not found', 404);
            apply(doc);
        }
    }
    return doc;
};
const clientError = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status }, extra);
const sendError = (res, err, fallback, tag) => {
    if (err.status) {
        if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
        return res.status(err.status).json({ error: err.message, ...(err.body || {}) });
    }
    console.error(`[ExamController] ${tag}:`, err.message);
    return res.status(500).json({ error: fallback });
};
const releasedFor = (exam) => Boolean(exam.scoring?.immediateScoreRelease || exam.scoring?.releaseStatus === 'released');
const totalPoints = (exam) => (exam.questions || []).reduce((sum, q) => sum + (Number(q.points) || 0), 0);

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

const managesClass = (user, cls) =>
    user.role === 'admin' ||
    Boolean(cls && (sameId(cls.createdBy, user._id) || (cls.teachers || []).some((t) => sameId(t, user._id))));

const teacherClassIds = async (user) =>
    (await Class.find({ $or: [{ teachers: user._id }, { createdBy: user._id }] }).select('_id').lean()).map((c) => c._id);

const canManageExam = async (user, exam) => {
    if (user.role === 'admin') return true;
    if (user.role !== 'teacher') return false;
    if (exam.template?.isTemplate && sameId(exam.createdBy, user._id)) return true;
    const cls = await Class.findById(exam.classId).select('teachers createdBy').lean();
    return managesClass(user, cls);
};

const loadManagedExam = async (req, populate) => {
    let query = Exam.findById(req.params.examId);
    if (populate) query = query.populate(populate);
    const exam = await query;
    if (!exam) throw clientError('Exam not found', 404);
    if (!(await canManageExam(req.user, exam))) throw clientError('You do not manage this exam', 403);
    return exam;
};

const loadStudentExam = async (req, { allowArchived = false } = {}) => {
    const exam = await Exam.findById(req.params.examId);
    const hidden = !exam || exam.template?.isTemplate || exam.status === 'draft' || (!allowArchived && exam.status === 'archived');
    if (hidden) throw clientError('Exam not found', 404);
    const enrolled = await Class.exists({ _id: exam.classId, students: req.user._id });
    if (!enrolled) throw clientError('You are not enrolled in this class', 403);
    if (req.user.isBlocked?.get?.(String(exam.classId))) throw clientError('You are blocked in this class', 403);
    return exam;
};

const loadOwnAttempt = async (req, exam) => {
    const { attemptId } = req.body || {};
    if (!isObjectId(attemptId)) throw clientError('attemptId is required');
    const attempt = await ExamAttempt.findOne({ _id: attemptId, examId: exam._id, studentId: req.user._id });
    if (!attempt) throw clientError('Attempt not found', 404);
    return attempt;
};

// ---------------------------------------------------------------------------
// Exam payload normalization
// ---------------------------------------------------------------------------

const buildQuestionList = async (input) => {
    if (!Array.isArray(input) || !input.length) throw clientError('Add at least one question');
    const seen = new Set();
    const rows = [];
    for (const raw of input) {
        const item = toPlain(raw) || {};
        const questionId = idOf(item.questionId);
        if (!isObjectId(questionId)) throw clientError('One of the questions has an invalid id');
        if (seen.has(questionId)) continue;
        seen.add(questionId);
        const points = parseOptionalPoints(item.points);
        if (points === undefined) throw clientError('Points must be a number of 0 or more');
        const limit = item.timeLimitSeconds ? clampInt(item.timeLimitSeconds, 0, MAX_DURATION_MINUTES * 60, 0) : 0;
        rows.push({
            questionId,
            points,
            sectionId: item.sectionId ? String(item.sectionId) : undefined,
            timeLimitSeconds: limit || null,
        });
    }

    const docs = await Question.find({ _id: { $in: rows.map((r) => r.questionId) } })
        .select('title points status isDraft')
        .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const missing = rows.filter((r) => !byId.has(r.questionId)).length;
    if (missing) throw clientError(`${missing} selected question${missing === 1 ? ' no longer exists' : 's no longer exist'}`);
    const draft = rows.map((r) => byId.get(r.questionId)).find((d) => d.status === 'draft' || d.isDraft);
    if (draft) throw clientError(`"${draft.title}" is still a draft. Publish it before adding it to an exam.`);

    return rows.map((row, order) => ({
        ...row,
        order,
        points: row.points ?? (parseOptionalPoints(byId.get(row.questionId).points) || 0),
    }));
};

/** Section durationSeconds of 0 means the section has no own limit and shares the exam clock. */
const normalizeSections = (input, questions, examSeconds) => {
    const source = Array.isArray(input) && input.length ? input : [{ sectionId: 'section-1', title: 'Section 1' }];
    const seen = new Set();
    const sections = source.map((raw, idx) => {
        const item = toPlain(raw) || {};
        let sectionId = String(item.sectionId || `section-${idx + 1}`);
        for (let n = 2; seen.has(sectionId); n += 1) sectionId = `${item.sectionId || 'section'}-${n}`;
        seen.add(sectionId);
        const seconds = item.durationSeconds ?? (item.durationMinutes ? item.durationMinutes * 60 : 0);
        return {
            sectionId,
            title: String(item.title || '').trim().slice(0, 120) || `Section ${idx + 1}`,
            description: String(item.description || '').trim().slice(0, 1000),
            durationSeconds: clampInt(seconds, 0, examSeconds, 0),
            allowRevisit: bool(item.allowRevisit, true),
            order: idx,
        };
    });
    const fallback = sections[0].sectionId;
    questions.forEach((q) => {
        if (!q.sectionId || !seen.has(q.sectionId)) q.sectionId = fallback;
    });
    return sections;
};

/**
 * Safe Exam Browser settings from the request. Secrets are never taken from the client: they are kept
 * from `base` (only when editing that same exam) and generated whenever SEB is on and one is missing.
 */
const readSebSettings = (p, base, keepSecrets) => {
    const baseP = (keepSecrets && toPlain(base?.proctoring)) || {};
    const sebRequired = bool(p.sebRequired, false);
    const override = seb.normalizeConfigKeyOverride(p.sebConfigKeyOverride);
    if (override === null) throw clientError('The Config Key override must be the 64-character key shown by Safe Exam Browser');
    const out = {
        sebRequired,
        sebVerifyMode: p.sebVerifyMode === 'strict' ? 'strict' : 'basic',
        sebConfigKeyOverride: override,
        sebEntryPassword: baseP.sebEntryPassword || undefined,
        sebExitPassword: baseP.sebExitPassword || undefined,
        sebConfigToken: baseP.sebConfigToken || undefined,
    };
    return sebRequired ? seb.ensureSecrets(out) : out;
};

const readExamBody = async (body, base, { keepSebSecrets = false } = {}) => {
    const title = String(body.title ?? base?.title ?? '').trim();
    if (!title) throw clientError('Title is required');
    if (title.length > 200) throw clientError('Title must be 200 characters or fewer');
    const description = String(body.description ?? base?.description ?? '').trim();

    const questions = await buildQuestionList(body.questions !== undefined ? body.questions : base?.questions);

    const p = { ...(toPlain(base?.proctoring) || {}), ...(body.proctoring || {}) };
    const durationMinutes = clampInt(p.durationMinutes, 1, MAX_DURATION_MINUTES, NaN);
    if (!Number.isFinite(durationMinutes)) throw clientError('Duration must be between 1 and 1440 minutes');
    const startTime = parseDate(p.startTime);
    const endTime = parseDate(p.endTime);
    if (startTime === undefined || endTime === undefined) throw clientError('Start or end time is not a valid date');
    if (startTime && endTime && endTime <= startTime) throw clientError('End time must be after the start time');

    const sections = normalizeSections(body.sections !== undefined ? body.sections : base?.sections, questions, durationMinutes * 60);
    const s = { ...(toPlain(base?.scoring) || {}), ...(body.scoring || {}) };

    return {
        title,
        description,
        questions,
        sections,
        proctoring: {
            durationMinutes,
            startTime,
            endTime,
            autoSubmitOnEnd: bool(p.autoSubmitOnEnd, true),
            tabSwitchLimit: clampInt(p.tabSwitchLimit, 0, 100, 5),
            copyPasteDisabled: bool(p.copyPasteDisabled, true),
            fullscreenRequired: bool(p.fullscreenRequired, true),
            internetRequired: bool(p.internetRequired, true),
            allowRunCode: bool(p.allowRunCode, true),
            ...readSebSettings(p, base, keepSebSecrets),
        },
        scoring: {
            immediateScoreRelease: bool(s.immediateScoreRelease, false),
            releaseStatus: s.releaseStatus === 'released' ? 'released' : 'not_released',
            gradingMode: ['auto', 'manual', 'mixed'].includes(s.gradingMode) ? s.gradingMode : 'auto',
        },
    };
};

// ---------------------------------------------------------------------------
// Student-facing shapes
// ---------------------------------------------------------------------------

const sanitizeQuestionForExam = (q) => ({
    _id: q._id,
    title: q.title,
    description: q.description,
    difficulty: q.difficulty,
    type: q.type,
    tags: q.tags,
    options: q.options,
    codeSnippet: q.codeSnippet,
    starterCode: q.starterCode,
    functionSignature: q.functionSignature,
    constraints: q.constraints,
    inputFormat: q.inputFormat,
    outputFormat: q.outputFormat,
    sampleIo: q.sampleIo,
    examples: q.examples,
    languages: q.languages,
    testCases: (q.testCases || [])
        .filter((tc) => tc.isPublic)
        .map((tc) => ({ input: tc.input, expectedOutput: tc.expectedOutput, isPublic: true })),
});

const studentExamSummary = (exam, now = new Date()) => {
    const phase = examPhase(exam, now);
    return {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        classId: exam.classId,
        phase,
        status: phase === 'live' ? 'active' : phase,
        questionCount: exam.questions?.length || 0,
        totalPoints: totalPoints(exam),
        questions: (exam.questions || []).map((q) => ({
            questionId: q.questionId?._id || q.questionId,
            points: q.points,
            order: q.order,
            sectionId: q.sectionId,
            timeLimitSeconds: q.timeLimitSeconds,
        })),
        sections: (exam.sections || []).map((s) => ({
            sectionId: s.sectionId,
            title: s.title,
            description: s.description,
            durationSeconds: s.durationSeconds,
            allowRevisit: s.allowRevisit,
            order: s.order,
        })),
        proctoring: {
            durationMinutes: exam.proctoring?.durationMinutes,
            startTime: exam.proctoring?.startTime,
            endTime: exam.proctoring?.endTime,
            tabSwitchLimit: exam.proctoring?.tabSwitchLimit,
            copyPasteDisabled: exam.proctoring?.copyPasteDisabled,
            fullscreenRequired: exam.proctoring?.fullscreenRequired,
            internetRequired: exam.proctoring?.internetRequired,
            autoSubmitOnEnd: exam.proctoring?.autoSubmitOnEnd,
            allowRunCode: exam.proctoring?.allowRunCode,
            // Only the flag: SEB passwords / token / mode never go to students.
            sebRequired: Boolean(exam.proctoring?.sebRequired),
        },
        scoring: {
            immediateScoreRelease: exam.scoring?.immediateScoreRelease,
            releaseStatus: exam.scoring?.releaseStatus,
        },
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
    };
};

const studentAttempt = (attempt, { released = false, codingIds = new Set(), exam = null, now = Date.now() } = {}) => {
    if (!attempt) return null;
    const showScore = released && isClosed(attempt);
    return {
        _id: attempt._id,
        examId: attempt.examId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        endsAt: attempt.endsAt,
        submittedAt: attempt.submittedAt,
        // Timer state is computed on the server clock at `now` (sent along as serverTime).
        ...timerState(exam, attempt, now),
        tabSwitchCount: attempt.tabSwitchCount,
        violationCount: attempt.violationCount,
        answers: (attempt.answers || []).map((a) => {
            const coding = codingIds.has(idOf(a.questionId));
            return {
                questionId: a.questionId,
                answer: a.answer,
                language: a.language,
                savedAt: a.savedAt,
                ...(coding ? { passedTestCases: a.passedTestCases, totalTestCases: a.totalTestCases } : {}),
                ...(showScore ? { score: a.score, maxScore: a.maxScore, isCorrect: a.isCorrect } : {}),
            };
        }),
        ...(showScore ? { totalScore: attempt.totalScore, maxScore: attempt.maxScore } : {}),
    };
};

const codingIdsFor = async (exam) => {
    const docs = await Question.find({ _id: { $in: exam.questions.map((q) => idOf(q.questionId)) }, type: { $in: CODING_TYPES } })
        .select('_id')
        .lean();
    return new Set(docs.map((d) => String(d._id)));
};

// ---------------------------------------------------------------------------
// Attempt lifecycle
// ---------------------------------------------------------------------------

const finalizeAttempt = async (exam, attempt, status, remark) => {
    const points = new Map(exam.questions.map((q) => [idOf(q.questionId), Number(q.points) || 0]));
    const apply = (doc) => {
        if (isClosed(doc)) return; // a concurrent request already closed it; keep that result
        doc.answers = (doc.answers || []).filter((a) => points.has(idOf(a.questionId)));
        doc.totalScore = doc.answers.reduce((sum, a) => sum + (Number(a.score) || 0), 0);
        doc.maxScore = [...points.values()].reduce((sum, p) => sum + p, 0);
        doc.status = status;
        doc.autoSubmitted = status === 'auto_submitted';
        doc.manualSubmitted = status === 'submitted';
        doc.submittedAt = new Date();
        if (remark) doc.remark = remark;
    };
    apply(attempt);
    const saved = await saveAttemptWithRetry(attempt, apply);
    if (saved !== attempt) Object.assign(attempt, saved.toObject());
    return saved;
};

const closeIfExpired = async (exam, attempt, now = Date.now()) => {
    if (!attempt || isClosed(attempt) || !attempt.endsAt) return false;
    if (now < new Date(attempt.endsAt).getTime() + GRACE_MS) return false;
    await finalizeAttempt(exam, attempt, 'auto_submitted', 'Time ran out');
    return true;
};

const examEndsAt = (exam, from) => {
    const byDuration = from.getTime() + (exam.proctoring?.durationMinutes || 60) * 60 * 1000;
    const scheduleEnd = exam.proctoring?.endTime ? new Date(exam.proctoring.endTime).getTime() : Infinity;
    return new Date(Math.min(byDuration, scheduleEnd));
};

const runnableCode = (question, answer, language) => {
    if (question.type === 'fillInTheBlanksCoding') {
        if (!fillTemplateFor(question, language)) throw clientError('This question is missing its code template');
        return buildFillTheCodeProgram(question, answer, language);
    }
    if (shouldMergeDriverForLanguage(question, language)) {
        const driver = question.driverCode.find((d) => d.language === language);
        if (driver?.code) return mergeDriverWithUserAnswer(driver.code, answer, { language });
    }
    return answer;
};

const assertCodingInput = (question, answer, language) => {
    if (!language || !question.languages.includes(language)) throw clientError(`${language || 'That language'} is not allowed for this question`);
    if (typeof answer !== 'string' || !answer.trim()) throw clientError('Write some code first');
};

const gradeAnswer = async (question, answer, language, maxScore) => {
    const optionCount = question.options?.length || 0;
    const result = (isCorrect, stored, extra = {}) => ({
        answer: stored,
        isCorrect,
        score: isCorrect ? maxScore : 0,
        passedTestCases: isCorrect ? 1 : 0,
        totalTestCases: 1,
        output: typeof stored === 'string' ? stored : JSON.stringify(stored),
        ...extra,
    });

    switch (question.type) {
        case 'singleCorrectMcq': {
            const choice = Number(answer);
            if (!Number.isInteger(choice) || choice < 0 || choice >= optionCount) throw clientError('Pick one of the options');
            return result(choice === question.correctOption, choice);
        }
        case 'multipleCorrectMcq': {
            const picks = [...new Set((Array.isArray(answer) ? answer : [answer]).map(Number))].sort((a, b) => a - b);
            if (!picks.length || picks.some((n) => !Number.isInteger(n) || n < 0 || n >= optionCount)) {
                throw clientError('Pick at least one of the options');
            }
            const correct = [...new Set(question.correctOptions || [])];
            const isCorrect = picks.length === correct.length && picks.every((n) => correct.includes(n));
            return result(isCorrect, picks);
        }
        case 'fillInTheBlanks': {
            if (typeof answer !== 'string' || !answer.trim()) throw clientError('Answer cannot be empty');
            return result(typedAnswerMatches(answer, question.correctAnswer), answer);
        }
        default: {
            assertCodingInput(question, answer, language);
            const code = runnableCode(question, answer, language);
            try {
                const tests = await executeDockerCode(language, code, question.testCases, question.timeLimit, question.memoryLimit, {
                    wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language),
                });
                const passed = tests.filter((t) => t.passed).length;
                const total = tests.length;
                const isCorrect = total > 0 && passed === total;
                return {
                    answer,
                    isCorrect,
                    score: isCorrect ? maxScore : total ? Math.floor((passed / total) * maxScore) : 0,
                    passedTestCases: passed,
                    totalTestCases: total,
                    output: JSON.stringify(compactTestResultsForStorage(sanitizeTestResultsForStudent(tests))),
                    testResults: compactTestResultsForStorage(sanitizeTestResultsForStudent(tests)),
                };
            } catch (err) {
                if (err?.status === 429) throw err; // judge saturated: tell the student to retry, don't record a zero
                return {
                    answer,
                    isCorrect: false,
                    score: 0,
                    passedTestCases: 0,
                    totalTestCases: question.testCases?.length || 0,
                    output: `Error: ${err.message}`,
                    executionError: 'Your code could not be run. Check it compiles and try again.',
                };
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Timers (sections and questions), anchored to the server clock
//
// Each timer stores the budget left when it last stopped (remainingSeconds) and, while it runs, the
// moment it started (startedAt). The current section's timer runs while the student is on any of its
// questions; the current question's timer runs while that question is open. Everything else is
// paused. The client only tells the server where the student is (POST /navigate); it never reports
// time. A section with allowRevisit=false locks (completed) as soon as the student leaves it.
// ---------------------------------------------------------------------------

/**
 * Tolerance for requests in flight when a section/question timer stops or runs out. Same cap as the
 * exam clock (GRACE_MS), but never more than 10% of the timer itself (min 1 s): a 15 s grace on a
 * 30 s question would hand out 50% extra time.
 */
const timerGraceMs = (limitSeconds) => Math.min(GRACE_MS, Math.max(1000, (Number(limitSeconds) || 0) * 100));
const round3 = (n) => Math.round(n * 1000) / 1000;
const msOf = (date) => (date ? new Date(date).getTime() : null);

const sectionConf = (exam, sectionId) => (exam.sections || []).find((s) => s.sectionId === sectionId) || null;
const questionMeta = (exam, questionId) => (exam.questions || []).find((q) => sameId(q.questionId, questionId)) || null;
/** The section a question belongs to (questions with an unknown sectionId fall into the first section). */
const sectionIdOf = (exam, meta) => {
    if (!meta) return null;
    if (meta.sectionId && sectionConf(exam, meta.sectionId)) return meta.sectionId;
    return exam.sections?.[0]?.sectionId || null;
};
/** Questions in the order the student sees them: by section order, then question order. */
const orderedQuestions = (exam) => {
    const sectionRank = new Map((exam.sections || []).map((s, i) => [s.sectionId, s.order ?? i]));
    return [...(exam.questions || [])].sort((a, b) => {
        const sa = sectionRank.get(sectionIdOf(exam, a)) ?? 0;
        const sb = sectionRank.get(sectionIdOf(exam, b)) ?? 0;
        return sa - sb || (a.order ?? 0) - (b.order ?? 0);
    });
};

const findSectionTimer = (doc, sectionId) => (doc.sectionTimers || []).find((t) => t.sectionId === sectionId) || null;
const findQuestionTimer = (doc, questionId) => (doc.questionTimers || []).find((t) => sameId(t.questionId, questionId)) || null;

/** Every timer slot of the exam with its limit (0 = untimed) and the stored timer (may be null). */
const timerSlots = (exam, doc) => [
    ...(exam.sections || []).map((s) => ({
        kind: 'section',
        key: s.sectionId,
        limit: Number(s.durationSeconds) || 0,
        timer: findSectionTimer(doc, s.sectionId),
    })),
    ...(exam.questions || []).map((q) => ({
        kind: 'question',
        key: idOf(q.questionId),
        limit: Number(q.timeLimitSeconds) || 0,
        timer: findQuestionTimer(doc, q.questionId),
    })),
];

/** Budget left in ms at `now` (negative once overrun), or null for an untimed slot. */
const timerLeftMs = (timer, limit, now) => {
    if (!limit) return null;
    const base = (timer.remainingSeconds ?? limit) * 1000;
    return timer.startedAt ? base - (now - msOf(timer.startedAt)) : base;
};

/** Pause a running timer, folding the elapsed time into remainingSeconds. Completes it if it ran out. */
const stopTimer = (timer, limit, now) => {
    if (!timer?.startedAt) return;
    const left = timerLeftMs(timer, limit, now);
    const ranOutAt = limit ? msOf(timer.startedAt) + (timer.remainingSeconds ?? limit) * 1000 : null;
    timer.startedAt = null;
    timer.stoppedAt = new Date(now);
    if (left === null) return;
    if (left <= 0) {
        timer.remainingSeconds = 0;
        timer.completed = true;
        timer.endedAt = new Date(ranOutAt);
    } else {
        timer.remainingSeconds = round3(left / 1000);
    }
};

/** Lock a timer for good (student left a no-revisit section, or asked to finish it). */
const completeTimer = (timer, limit, now) => {
    if (!timer) return;
    stopTimer(timer, limit, now);
    if (timer.completed) return;
    timer.completed = true;
    timer.endedAt = new Date(now);
};

/** Start counting, unless the timer is untimed, locked or out of budget. */
const startTimer = (timer, limit, now) => {
    if (!timer || !limit || timer.completed || timer.startedAt) return;
    if (timer.remainingSeconds === null || timer.remainingSeconds === undefined) timer.remainingSeconds = limit;
    if (timer.remainingSeconds <= 0) {
        timer.remainingSeconds = 0;
        timer.completed = true;
        timer.endedAt = timer.endedAt || timer.stoppedAt || new Date(now);
        return;
    }
    timer.startedAt = new Date(now);
};

/** Find a slot's timer, creating it if the attempt predates it. */
const ensureTimer = (doc, kind, key, limit) => {
    if (kind === 'section') {
        if (!findSectionTimer(doc, key)) doc.sectionTimers.push({ sectionId: key, remainingSeconds: limit || null, completed: false });
        return findSectionTimer(doc, key);
    }
    if (!findQuestionTimer(doc, key)) doc.questionTimers.push({ questionId: key, remainingSeconds: limit || null, completed: false });
    return findQuestionTimer(doc, key);
};

/** The current question (falls back to the first question) and its section. */
const currentPosition = (exam, doc) => {
    const meta = (doc.currentQuestionId && questionMeta(exam, doc.currentQuestionId)) || orderedQuestions(exam)[0] || null;
    return { meta, sectionId: meta ? sectionIdOf(exam, meta) : doc.currentSectionId || exam.sections?.[0]?.sectionId || null };
};

/**
 * Bring the stored timers in line with the server clock at `now`: timers that ran out are completed,
 * timers that are not current are paused, and the current section/question timers are running.
 * Also starts timers of attempts created before timers were server-driven (startedAt unset).
 * Mutates `doc`; callers save it when it is modified.
 */
const reconcileTimers = (exam, doc, now) => {
    if (isClosed(doc)) return;
    const { meta, sectionId } = currentPosition(exam, doc);
    const questionKey = meta ? idOf(meta.questionId) : null;
    if (meta && !sameId(doc.currentQuestionId, questionKey)) doc.currentQuestionId = questionKey;
    if (sectionId && doc.currentSectionId !== sectionId) doc.currentSectionId = sectionId;

    timerSlots(exam, doc).forEach(({ kind, key, limit, timer }) => {
        if (!timer?.startedAt) return;
        const current = kind === 'section' ? key === sectionId : key === questionKey;
        const left = timerLeftMs(timer, limit, now);
        if (!current || (left !== null && left <= 0)) stopTimer(timer, limit, now);
    });

    if (!sectionId) return;
    const section = sectionConf(exam, sectionId);
    const sectionLimit = Number(section?.durationSeconds) || 0;
    const sTimer = ensureTimer(doc, 'section', sectionId, sectionLimit);
    startTimer(sTimer, sectionLimit, now);
    if (!meta) return;
    const questionLimit = Number(meta.timeLimitSeconds) || 0;
    if (!questionLimit) return;
    const qTimer = ensureTimer(doc, 'question', questionKey, questionLimit);
    // A locked section freezes its questions' timers too.
    if (sTimer.completed) stopTimer(qTimer, questionLimit, now);
    else startTimer(qTimer, questionLimit, now);
};

/**
 * Move the student to `questionId`: pause what was running, lock the section being left if it does
 * not allow revisits, then start the new section/question timers. A locked target can still be
 * viewed; its timers simply do not start and its answers cannot change.
 */
const navigateTimers = (exam, doc, questionId, now) => {
    const target = questionMeta(exam, questionId);
    if (!target) throw clientError('This question is not part of the exam');
    const { meta: fromMeta, sectionId: fromSection } = currentPosition(exam, doc);
    const toSection = sectionIdOf(exam, target);
    if (fromMeta && sameId(fromMeta.questionId, questionId)) return reconcileTimers(exam, doc, now);

    timerSlots(exam, doc).forEach(({ limit, timer }) => stopTimer(timer, limit, now));
    const leaving = fromSection && fromSection !== toSection ? sectionConf(exam, fromSection) : null;
    if (leaving && leaving.allowRevisit === false) {
        completeTimer(ensureTimer(doc, 'section', leaving.sectionId, Number(leaving.durationSeconds) || 0), Number(leaving.durationSeconds) || 0, now);
    }
    doc.currentQuestionId = idOf(target.questionId);
    doc.currentSectionId = toSection;
    return reconcileTimers(exam, doc, now);
};

/** Client view of one timer at `now`. `endsAt` is set while it runs: the client counts down to it. */
const timerView = (timer, limit, now) => {
    const left = timer ? timerLeftMs(timer, limit, now) : limit ? limit * 1000 : null;
    const expired = left !== null && left <= 0;
    const running = Boolean(timer?.startedAt) && !timer?.completed && !expired;
    return {
        limitSeconds: limit || null,
        remainingSeconds: left === null ? null : round3(Math.max(0, left) / 1000),
        running,
        completed: Boolean(timer?.completed) || expired,
        endsAt: running ? new Date(now + left) : null,
    };
};

const timerState = (exam, attempt, now = Date.now()) => {
    const sectionTimers = [];
    const questionTimers = [];
    if (exam) {
        timerSlots(exam, attempt).forEach(({ kind, key, limit, timer }) => {
            if (kind === 'section') sectionTimers.push({ sectionId: key, ...timerView(timer, limit, now) });
            else questionTimers.push({ questionId: key, ...timerView(timer, limit, now) });
        });
    }
    return { currentSectionId: attempt.currentSectionId, currentQuestionId: attempt.currentQuestionId, sectionTimers, questionTimers };
};

/** Reconcile the timers at `now` and persist if anything changed. Returns the saved attempt. */
const syncAttemptTimers = async (exam, attempt, now = Date.now()) => {
    if (isClosed(attempt)) return attempt;
    reconcileTimers(exam, attempt, now);
    if (!attempt.isModified()) return attempt;
    return saveAttemptWithRetry(attempt, (doc) => reconcileTimers(exam, doc, now));
};

/** Throws unless a timer slot still accepts answers at `now`. */
const assertSlotOpen = (timer, limit, now, label) => {
    const grace = timerGraceMs(limit);
    if (timer?.completed) {
        if (timer.endedAt && now < msOf(timer.endedAt) + grace) return;
        const timedOut = limit && !(timer.remainingSeconds > 0);
        throw clientError(timedOut ? `Time for this ${label} is over` : `You have left this ${label}, so its answers are locked`, 403);
    }
    if (!limit) return;
    if (!timer) throw clientError(`Open this ${label} before answering it`, 403);
    const left = timerLeftMs(timer, limit, now);
    if (left <= -grace || (!timer.startedAt && left <= 0)) throw clientError(`Time for this ${label} is over`, 403);
    // A paused timed slot only accepts requests that were in flight when the student moved away;
    // otherwise its clock could be stopped by navigating elsewhere while answering through the API.
    if (!timer.startedAt && !(timer.stoppedAt && now < msOf(timer.stoppedAt) + grace)) {
        throw clientError(`Go back to this ${label} to change its answer`, 403);
    }
};

/** Throws when the student may no longer change this question (timer ran out or section closed). */
const assertQuestionOpen = (exam, attempt, questionId, now = Date.now()) => {
    const meta = questionMeta(exam, questionId);
    if (!meta) throw clientError('This question is not part of the exam');
    const sectionId = sectionIdOf(exam, meta);
    const section = sectionConf(exam, sectionId);
    assertSlotOpen(sectionId ? findSectionTimer(attempt, sectionId) : null, Number(section?.durationSeconds) || 0, now, 'section');
    assertSlotOpen(findQuestionTimer(attempt, questionId), Number(meta.timeLimitSeconds) || 0, now, 'question');
    return meta;
};

const assertAttemptOpen = async (exam, attempt) => {
    if (await closeIfExpired(exam, attempt)) throw clientError('Time is up. Your exam has been submitted.', 409);
    if (isClosed(attempt)) throw clientError('This attempt is already closed', 409);
};

// ---------------------------------------------------------------------------
// Safe Exam Browser: entry password with a per-student throttle
// ---------------------------------------------------------------------------

const sebLockedError = (untilMs) => {
    const seconds = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
    const minutes = Math.ceil(seconds / 60);
    return clientError(`Too many wrong entry passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 429, {
        retryAfterSeconds: seconds,
        body: { code: 'SEB_ENTRY_LOCKED', retryAfterSeconds: seconds },
    });
};

/** Atomically counts one wrong password (window of ENTRY_WINDOW_MS) and locks after ENTRY_MAX_FAILURES. */
const recordSebEntryFailure = async (key) => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - seb.ENTRY_WINDOW_MS);
    return SebEntryThrottle.findOneAndUpdate(
        key,
        [
            { $set: { inWindow: { $gt: ['$windowStart', cutoff] } } },
            {
                $set: {
                    failures: { $cond: ['$inWindow', { $add: [{ $ifNull: ['$failures', 0] }, 1] }, 1] },
                    windowStart: { $cond: ['$inWindow', '$windowStart', now] },
                    expiresAt: new Date(now.getTime() + seb.ENTRY_WINDOW_MS + seb.ENTRY_LOCK_MS),
                },
            },
            {
                $set: {
                    lockedUntil: {
                        $cond: [{ $gte: ['$failures', seb.ENTRY_MAX_FAILURES] }, new Date(now.getTime() + seb.ENTRY_LOCK_MS), '$lockedUntil'],
                    },
                },
            },
            { $unset: 'inWindow' },
        ],
        { upsert: true, new: true }
    ).lean();
};

/**
 * POST /start on a SEB exam: body.entryPassword must match (trimmed, case-insensitive, timing-safe).
 * 5 wrong tries within 10 minutes lock this student out of this exam's start for 10 minutes (429).
 */
const checkSebEntryPassword = async (exam, req) => {
    const key = { examId: exam._id, studentId: req.user._id };
    const throttle = await SebEntryThrottle.findOne(key).lean();
    const lockedUntil = throttle?.lockedUntil ? new Date(throttle.lockedUntil).getTime() : 0;
    if (lockedUntil > Date.now()) throw sebLockedError(lockedUntil);

    const given = req.body?.entryPassword;
    if (typeof given !== 'string' || !given.trim()) {
        throw clientError('Enter the entry password your teacher announced.', 403, { body: { code: 'SEB_ENTRY_PASSWORD' } });
    }
    if (seb.entryPasswordMatches(given, exam.proctoring?.sebEntryPassword)) {
        if (throttle) await SebEntryThrottle.deleteOne(key);
        return;
    }
    const doc = await recordSebEntryFailure(key);
    const lockedNow = doc?.lockedUntil ? new Date(doc.lockedUntil).getTime() : 0;
    if (lockedNow > Date.now()) throw sebLockedError(lockedNow);
    const triesLeft = Math.max(0, seb.ENTRY_MAX_FAILURES - (doc?.failures || 0));
    throw clientError(
        `That entry password is not correct. Check it with your teacher (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left).`,
        403,
        { body: { code: 'SEB_ENTRY_PASSWORD', triesLeft } }
    );
};

// ---------------------------------------------------------------------------
// Staff: templates
// ---------------------------------------------------------------------------

exports.createTemplate = async (req, res) => {
    try {
        const { classId } = req.body;
        if (!isObjectId(classId)) throw clientError('Pick a class for the template');
        const cls = await Class.findById(classId).select('teachers createdBy').lean();
        if (!cls) throw clientError('Class not found', 404);
        if (!managesClass(req.user, cls)) throw clientError('You do not manage this class', 403);

        const fields = await readExamBody(req.body, null);
        fields.proctoring.startTime = null;
        fields.proctoring.endTime = null;
        const template = await Exam.create({
            ...fields,
            classId,
            createdBy: req.user._id,
            status: 'draft',
            template: {
                isTemplate: true,
                templateName: fields.title,
                templateDescription: String(req.body.templateDescription ?? fields.description ?? ''),
                baseTemplateId: null,
            },
        });
        res.status(201).json({ message: 'Template created', template, exam: template });
    } catch (err) {
        sendError(res, err, 'Failed to create template', 'createTemplate');
    }
};

exports.listTemplates = async (req, res) => {
    try {
        const filter = { 'template.isTemplate': true };
        if (req.user.role !== 'admin') {
            filter.$or = [{ createdBy: req.user._id }, { classId: { $in: await teacherClassIds(req.user) } }];
        }
        const templates = await Exam.find(filter)
            .sort({ updatedAt: -1 })
            .populate('classId', 'name status')
            .populate('createdBy', 'name')
            .lean();

        const usage = await Exam.aggregate([
            { $match: { 'template.baseTemplateId': { $in: templates.map((t) => t._id) } } },
            { $group: { _id: '$template.baseTemplateId', count: { $sum: 1 }, lastUsedAt: { $max: '$createdAt' } } },
        ]);
        const usageMap = new Map(usage.map((u) => [String(u._id), u]));

        res.json({
            templates: templates.map((t) => {
                const used = usageMap.get(String(t._id));
            return {
                    ...t,
                    classId: t.classId?._id || t.classId,
                    className: t.classId?.name || null,
                    classStatus: t.classId?.status || null,
                    createdBy: t.createdBy?._id || t.createdBy,
                    createdByName: t.createdBy?.name || null,
                    questionCount: t.questions?.length || 0,
                    sectionCount: t.sections?.length || 0,
                    totalPoints: totalPoints(t),
                    usageCount: used?.count || 0,
                    lastUsedAt: used?.lastUsedAt || null,
                };
            }),
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch templates', 'listTemplates');
    }
};

// ---------------------------------------------------------------------------
// Staff: question picker
// ---------------------------------------------------------------------------

exports.listQuestionBank = async (req, res) => {
    try {
        const { classId } = req.query;
        const filter = { isExamOnly: { $ne: true }, status: { $nin: ['draft', 'archived'] }, isDraft: { $ne: true } };
        if (req.user.role !== 'admin') {
            filter.$or = [{ createdBy: req.user._id }, { 'classes.classId': { $in: await teacherClassIds(req.user) } }];
        }
        const questions = await Question.find(filter)
            .select('title type difficulty points tags languages classes.classId createdAt')
            .sort({ createdAt: -1 })
            .lean();
        const inClassId = isObjectId(classId) ? classId : null;
        res.json({
            questions: questions.map((q) => ({
                _id: q._id,
                title: q.title,
                type: q.type,
                difficulty: q.difficulty,
                points: q.points ?? null,
                tags: q.tags || [],
                languages: q.languages || [],
                classCount: q.classes?.length || 0,
                inClass: inClassId ? (q.classes || []).some((c) => sameId(c.classId, inClassId)) : false,
                createdAt: q.createdAt,
            })),
        });
    } catch (err) {
        sendError(res, err, 'Failed to load questions', 'listQuestionBank');
    }
};

// ---------------------------------------------------------------------------
// Staff: exams
// ---------------------------------------------------------------------------

exports.createExam = async (req, res) => {
    try {
        const { classId, templateId } = req.body;
        if (!isObjectId(classId)) throw clientError('Pick a class for the exam');
        const cls = await Class.findById(classId).select('teachers createdBy').lean();
        if (!cls) throw clientError('Class not found', 404);
        if (!managesClass(req.user, cls)) throw clientError('You do not manage this class', 403);

        let template = null;
        if (templateId) {
            if (!isObjectId(templateId)) throw clientError('Template not found', 404);
            template = await Exam.findById(templateId);
            if (!template?.template?.isTemplate) throw clientError('Template not found', 404);
            if (!(await canManageExam(req.user, template))) throw clientError('You cannot use this template', 403);
        }

        const fields = await readExamBody(req.body, template);
        const exam = await Exam.create({
            ...fields,
            classId,
            createdBy: req.user._id,
            status: req.body.status === 'draft' ? 'draft' : 'scheduled',
            template: { isTemplate: false, baseTemplateId: template?._id || null },
        });
        res.status(201).json({ message: 'Exam created', exam });
    } catch (err) {
        sendError(res, err, 'Failed to create exam', 'createExam');
    }
};

const attemptStats = async (exams) => {
    if (!exams.length) return new Map();
    const rows = await ExamAttempt.aggregate([
        { $match: { examId: { $in: exams.map((e) => e._id) } } },
        {
            $group: {
                _id: '$examId',
                started: { $sum: 1 },
                inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
                submitted: { $sum: { $cond: [{ $in: ['$status', CLOSED_STATUSES] }, 1, 0] } },
                scoreSum: { $sum: { $cond: [{ $in: ['$status', CLOSED_STATUSES] }, '$totalScore', 0] } },
                maxSum: { $sum: { $cond: [{ $in: ['$status', CLOSED_STATUSES] }, '$maxScore', 0] } },
            },
        },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
};

const staffExamRow = (exam, stats, now) => {
    const s = stats.get(String(exam._id)) || {};
    const phase = examPhase(exam, now);
                    return {
        ...exam,
        phase,
        status: phase === 'live' ? 'active' : phase,
        storedStatus: exam.status,
        released: releasedFor(exam),
        questionCount: exam.questions?.length || 0,
        totalPoints: totalPoints(exam),
        stats: {
            started: s.started || 0,
            inProgress: s.inProgress || 0,
            submitted: s.submitted || 0,
            avgPercent: s.maxSum ? Math.round((s.scoreSum / s.maxSum) * 100) : null,
        },
    };
};

exports.listClassExams = async (req, res) => {
    try {
        const { classId } = req.params;
        const cls = await Class.findById(classId).select('name students teachers createdBy').lean();
        if (!cls) throw clientError('Class not found', 404);
        const now = new Date();

        if (req.user.role === 'student') {
            if (!(cls.students || []).some((s) => sameId(s, req.user._id))) throw clientError('You are not enrolled in this class', 403);
            const exams = await Exam.find({ classId, 'template.isTemplate': { $ne: true }, status: { $nin: ['draft', 'archived'] } })
                .sort({ 'proctoring.startTime': 1, createdAt: -1 })
                .lean();
            const attempts = await ExamAttempt.find({ examId: { $in: exams.map((e) => e._id) }, studentId: req.user._id })
                .select('examId status startedAt endsAt submittedAt totalScore maxScore')
                .lean();
            const byExam = new Map(attempts.map((a) => [String(a.examId), a]));
            return res.json({
                className: cls.name,
                exams: exams.map((exam) => {
                    const attempt = byExam.get(String(exam._id));
                    const released = releasedFor(exam);
                    const showScore = attempt && released && isClosed(attempt);
                    return {
                        ...studentExamSummary(exam, now),
                        className: cls.name,
                        released,
                        studentAttemptStatus: attempt?.status || null,
                        attempt: attempt
                            ? {
                                  status: attempt.status,
                                  startedAt: attempt.startedAt,
                                  endsAt: attempt.endsAt,
                                  submittedAt: attempt.submittedAt,
                                  ...(showScore ? { totalScore: attempt.totalScore, maxScore: attempt.maxScore } : {}),
                              }
                            : null,
                    };
                }),
            });
        }

        if (!managesClass(req.user, cls)) throw clientError('You do not manage this class', 403);
        const exams = await Exam.find({ classId, 'template.isTemplate': { $ne: true } }).sort({ createdAt: -1 }).lean();
        const stats = await attemptStats(exams);
        const studentCount = cls.students?.length || 0;
        res.json({
            className: cls.name,
            studentCount,
            exams: exams.map((exam) => ({ ...staffExamRow(exam, stats, now), className: cls.name, studentCount })),
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch exams', 'listClassExams');
    }
};

/** Every exam the user manages, across classes. */
exports.listStaffExams = async (req, res) => {
    try {
        const filter = { 'template.isTemplate': { $ne: true } };
        if (req.user.role !== 'admin') filter.classId = { $in: await teacherClassIds(req.user) };
        const exams = await Exam.find(filter).sort({ createdAt: -1 }).lean();
        const classIds = [...new Set(exams.map((e) => String(e.classId)))];
        const [stats, classes] = await Promise.all([
            attemptStats(exams),
            Class.find({ _id: { $in: classIds } }).select('name students').lean(),
        ]);
        const byClass = new Map(classes.map((c) => [String(c._id), c]));
        const now = new Date();
        res.json({
            exams: exams.map((exam) => {
                const cls = byClass.get(String(exam.classId));
                return { ...staffExamRow(exam, stats, now), className: cls?.name || null, studentCount: cls?.students?.length || 0 };
            }),
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch exams', 'listStaffExams');
    }
};

exports.getExamDetails = async (req, res) => {
    try {
        const exam = await loadManagedExam(req, {
            path: 'questions.questionId',
            select: 'title type difficulty points tags languages status isDraft isExamOnly',
        });
        const [attemptCount, cls] = await Promise.all([
            ExamAttempt.countDocuments({ examId: exam._id }),
            Class.findById(exam.classId).select('name').lean(),
        ]);
        const plain = exam.toObject();
        res.json({
            exam: { ...plain, phase: examPhase(plain), totalPoints: totalPoints(plain), seb: seb.staffSebView(plain, req) },
            attemptCount,
            className: cls?.name || null,
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch exam details', 'getExamDetails');
    }
};

const lockSignature = (exam) =>
    JSON.stringify({
        q: (exam.questions || []).map((q) => [idOf(q.questionId), Number(q.points) || 0, q.sectionId || '']),
        s: (exam.sections || []).map((s) => s.sectionId),
    });

const closeOpenAttempts = async (exam, remark) => {
    const open = await ExamAttempt.find({ examId: exam._id, status: { $in: ['in_progress', 'not_started'] } });
    await Promise.all(open.map((a) => finalizeAttempt(exam, a, 'auto_submitted', remark)));
    return open.length;
};

exports.editExam = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        const isTemplate = Boolean(exam.template?.isTemplate);
        const attemptCount = isTemplate ? 0 : await ExamAttempt.countDocuments({ examId: exam._id });
        const fields = await readExamBody(req.body, exam, { keepSebSecrets: true });
        if (isTemplate) {
            fields.proctoring.startTime = null;
            fields.proctoring.endTime = null;
        }

        if (attemptCount && lockSignature(exam) !== lockSignature(fields)) {
            return res.status(409).json({
                error: `${attemptCount} student${attemptCount === 1 ? ' has' : 's have'} already started this exam, so its questions, points and sections are locked. You can still change the title, schedule and rules.`,
                locked: true,
            });
        }

        const nextStatus = !isTemplate && EDITABLE_STATUSES.includes(req.body.status) ? req.body.status : exam.status;
        if (nextStatus === 'draft' && attemptCount) throw clientError('Students have already started this exam, so it cannot go back to draft', 409);

        Object.assign(exam, fields);
        exam.status = nextStatus;
        if (isTemplate) {
            exam.template.templateName = fields.title;
            if (req.body.templateDescription !== undefined) exam.template.templateDescription = String(req.body.templateDescription);
        }
        exam.markModified('proctoring');
        exam.markModified('scoring');
        await exam.save();
        if (nextStatus === 'completed') await closeOpenAttempts(exam, 'Exam closed by instructor');
        else if (!isTemplate) {
            // Keep in-progress attempts consistent with the new duration / end time.
            const open = await ExamAttempt.find({ examId: exam._id, status: 'in_progress', startedAt: { $ne: null } });
            await Promise.all(
                open.map((a) => {
                    const next = examEndsAt(exam, new Date(a.startedAt));
                    if (a.endsAt && next.getTime() === new Date(a.endsAt).getTime()) return null;
                    a.endsAt = next;
                    return saveAttemptWithRetry(a, (doc) => { doc.endsAt = next; }).catch(() => {});
                })
            );
        }

        res.json({ message: isTemplate ? 'Template updated' : 'Exam updated', exam });
    } catch (err) {
        sendError(res, err, 'Failed to update exam', 'editExam');
    }
};

exports.setExamStatus = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        if (exam.template?.isTemplate) throw clientError('Templates do not have a status');
        const { status } = req.body;
        if (!EDITABLE_STATUSES.includes(status)) throw clientError('Unknown status');
        if (status === 'draft' && (await ExamAttempt.exists({ examId: exam._id }))) {
            throw clientError('Students have already started this exam, so it cannot go back to draft', 409);
        }
        if (status === 'scheduled' && exam.status === 'completed' && exam.proctoring?.endTime && new Date(exam.proctoring.endTime) < new Date()) {
            throw clientError('The end time has passed. Edit the schedule to reopen this exam.', 409);
        }
        exam.status = status;
        await exam.save();
        const closed = status === 'completed' ? await closeOpenAttempts(exam, 'Exam closed by instructor') : 0;
        res.json({ message: 'Status updated', exam: { _id: exam._id, status: exam.status, phase: examPhase(exam) }, closedAttempts: closed });
    } catch (err) {
        sendError(res, err, 'Failed to update status', 'setExamStatus');
    }
};

exports.duplicateExam = async (req, res) => {
    try {
        const source = await loadManagedExam(req);
        const asTemplate = Boolean(req.body.asTemplate);
        const classId = req.body.classId || source.classId;
        if (!isObjectId(classId)) throw clientError('Pick a class');
        const cls = await Class.findById(classId).select('teachers createdBy').lean();
        if (!cls) throw clientError('Class not found', 404);
        if (!managesClass(req.user, cls)) throw clientError('You do not manage this class', 403);

        const plain = source.toObject();
        const title = String(req.body.title || '').trim() || `${plain.title} (copy)`;
        const copy = await Exam.create({
            title,
            description: plain.description,
            classId,
            questions: plain.questions,
            sections: plain.sections,
            // A copy never shares SEB passwords or the download token with its source.
            proctoring: {
                ...plain.proctoring,
                startTime: null,
                endTime: null,
                ...(plain.proctoring?.sebRequired
                    ? seb.newSecrets()
                    : { sebEntryPassword: undefined, sebExitPassword: undefined, sebConfigToken: undefined }),
            },
            scoring: { ...plain.scoring, releaseStatus: 'not_released' },
            createdBy: req.user._id,
            status: 'draft',
            template: asTemplate
                ? { isTemplate: true, templateName: title, templateDescription: plain.description || '', baseTemplateId: null }
                : { isTemplate: false, baseTemplateId: plain.template?.isTemplate ? plain._id : plain.template?.baseTemplateId || null },
        });
        res.status(201).json({ message: asTemplate ? 'Saved as template' : 'Exam duplicated', exam: copy });
    } catch (err) {
        sendError(res, err, 'Failed to duplicate exam', 'duplicateExam');
    }
};

exports.deleteExam = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        const attemptIds = (await ExamAttempt.find({ examId: exam._id }).select('_id').lean()).map((a) => a._id);
        await Promise.all([
            attemptIds.length ? Submission.deleteMany({ examAttemptId: { $in: attemptIds } }) : null,
            ExamAttempt.deleteMany({ examId: exam._id }),
        ]);
        await Exam.deleteOne({ _id: exam._id });
        res.json({ message: 'Exam deleted' });
    } catch (err) {
        sendError(res, err, 'Failed to delete exam', 'deleteExam');
    }
};

exports.releaseScores = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        const release = req.body?.release !== false;
        exam.scoring = exam.scoring || {};
        exam.scoring.releaseStatus = release ? 'released' : 'not_released';
        exam.markModified('scoring');
        await exam.save();
        res.json({ message: release ? 'Scores released' : 'Scores hidden', releaseStatus: exam.scoring.releaseStatus });
    } catch (err) {
        sendError(res, err, 'Failed to release scores', 'releaseScores');
    }
};

exports.getExamReport = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        const [cls, attempts, questionDocs] = await Promise.all([
            Class.findById(exam.classId).select('name students').populate('students', 'name email').lean(),
            ExamAttempt.find({ examId: exam._id }).populate('studentId', 'name email'),
            Question.find({ _id: { $in: exam.questions.map((q) => q.questionId) } })
                .select('title type difficulty options correctOption correctOptions correctAnswer')
                .lean(),
        ]);
        await Promise.all(attempts.map((a) => closeIfExpired(exam, a)));

        const qById = new Map(questionDocs.map((q) => [String(q._id), q]));
        const attemptedIds = new Set(attempts.map((a) => idOf(a.studentId)));
        const plain = exam.toObject();

        res.json({
            exam: {
                _id: plain._id,
                title: plain.title,
                description: plain.description,
                classId: plain.classId,
                status: plain.status,
                phase: examPhase(plain),
                released: releasedFor(plain),
                proctoring: plain.proctoring,
                seb: seb.staffSebView(plain, req),
                scoring: plain.scoring,
                sections: plain.sections,
                totalPoints: totalPoints(plain),
                questions: plain.questions.map((q) => {
                    const doc = qById.get(idOf(q.questionId));
                    return {
            questionId: q.questionId,
                        sectionId: q.sectionId,
                        points: q.points,
                        order: q.order,
                        title: doc?.title || 'Deleted question',
                        type: doc?.type || null,
                        difficulty: doc?.difficulty || null,
                        options: (doc?.options || []).map((o) => (typeof o === 'string' ? o : o?.text ?? '')),
                        correctOption: doc?.correctOption ?? null,
                        correctOptions: doc?.correctOptions || [],
                        correctAnswer: doc?.correctAnswer ?? null,
                    };
                }),
            },
            className: cls?.name || null,
            notStarted: (cls?.students || [])
                .filter((s) => !attemptedIds.has(String(s._id)))
                .map((s) => ({ _id: s._id, name: s.name, email: s.email })),
            attempts: attempts.map((a) => {
                const p = a.toObject();
                return {
                    _id: p._id,
                    student: p.studentId ? { _id: p.studentId._id, name: p.studentId.name, email: p.studentId.email } : null,
                    status: p.status,
                    startedAt: p.startedAt,
                    endsAt: p.endsAt,
                    submittedAt: p.submittedAt,
                    lastHeartbeatAt: p.lastHeartbeatAt,
                    currentQuestionId: p.currentQuestionId,
                    totalScore: p.totalScore,
                    maxScore: p.maxScore || totalPoints(plain),
                    remark: p.remark,
                    violationCount: p.violationCount,
                    tabSwitchCount: p.tabSwitchCount,
                    fullscreenExitCount: p.fullscreenExitCount,
                    copyPasteCount: p.copyPasteCount,
                    networkDropCount: p.networkDropCount,
                    violations: (p.violations || []).filter((v) => v.type !== 'heartbeat').slice(-25),
                    answers: (p.answers || []).map((ans) => ({
                        questionId: ans.questionId,
                        answer: ans.answer,
                        language: ans.language,
                        score: ans.score,
                        maxScore: ans.maxScore,
                        isCorrect: ans.isCorrect,
                        passedTestCases: ans.passedTestCases,
                        totalTestCases: ans.totalTestCases,
                        savedAt: ans.savedAt,
                    })),
                };
            }),
            serverTime: new Date(),
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch report', 'getExamReport');
    }
};

const loadStaffAttempt = async (req) => {
    const exam = await loadManagedExam(req);
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, examId: exam._id });
    if (!attempt) throw clientError('Attempt not found', 404);
    return { exam, attempt };
};

exports.forceSubmitAttempt = async (req, res) => {
    try {
        const { exam, attempt } = await loadStaffAttempt(req);
        if (isClosed(attempt)) throw clientError('This attempt is already closed', 409);
        await finalizeAttempt(exam, attempt, 'auto_submitted', 'Submitted by instructor');
        res.json({ message: 'Attempt submitted', status: attempt.status });
    } catch (err) {
        sendError(res, err, 'Failed to submit attempt', 'forceSubmitAttempt');
    }
};

exports.extendAttempt = async (req, res) => {
    try {
        const { exam, attempt } = await loadStaffAttempt(req);
        const minutes = clampInt(req.body?.minutes, 1, 240, NaN);
        if (!Number.isFinite(minutes)) throw clientError('Extra time must be between 1 and 240 minutes');
        if (await closeIfExpired(exam, attempt)) throw clientError('This attempt has already ended', 409);
        if (isClosed(attempt)) throw clientError('This attempt is already closed', 409);
        attempt.endsAt = new Date(new Date(attempt.endsAt || Date.now()).getTime() + minutes * 60 * 1000);
        await attempt.save();
        res.json({ message: `Added ${minutes} min`, endsAt: attempt.endsAt });
    } catch (err) {
        sendError(res, err, 'Failed to extend attempt', 'extendAttempt');
    }
};

exports.resetAttempt = async (req, res) => {
    try {
        const { attempt } = await loadStaffAttempt(req);
        await Submission.deleteMany({ examAttemptId: attempt._id });
        await ExamAttempt.deleteOne({ _id: attempt._id });
        res.json({ message: 'Attempt reset' });
    } catch (err) {
        sendError(res, err, 'Failed to reset attempt', 'resetAttempt');
    }
};

// ---------------------------------------------------------------------------
// Safe Exam Browser
// ---------------------------------------------------------------------------

const sendSebFile = (req, res, exam) => {
    const file = seb.buildSebFile(toPlain(exam), req);
    // no-transform: the file is already gzip'd in SEB's own format; never let a proxy re-encode it.
    res.set('Cache-Control', 'no-store, no-transform');
    res.attachment(seb.fileNameFor(exam));
    res.type('application/seb');
    res.send(file.buffer);
};

/** POST /exams/:examId/seb/regenerate (staff): new entry + exit passwords; clears entry lockouts. */
exports.regenerateSebPasswords = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        if (!seb.isSebRequired(exam)) throw clientError('Turn on "Require Safe Exam Browser" for this exam first', 409);
        const fresh = seb.newSecrets();
        const overrideCleared = Boolean(exam.proctoring.sebConfigKeyOverride);
        exam.proctoring.sebEntryPassword = fresh.sebEntryPassword;
        exam.proctoring.sebExitPassword = fresh.sebExitPassword;
        if (!exam.proctoring.sebConfigToken) exam.proctoring.sebConfigToken = fresh.sebConfigToken;
        // The exit password's hash is part of the .seb settings, so an old Config Key override no longer applies.
        exam.proctoring.sebConfigKeyOverride = '';
        exam.markModified('proctoring');
        await exam.save();
        await SebEntryThrottle.deleteMany({ examId: exam._id });
        res.json({ message: 'New passwords generated', seb: seb.staffSebView(exam.toObject(), req), overrideCleared });
    } catch (err) {
        sendError(res, err, 'Failed to generate new passwords', 'regenerateSebPasswords');
    }
};

/** GET /exams/:examId/seb-config (staff, bearer auth): the same .seb file students get. */
exports.downloadSebConfigStaff = async (req, res) => {
    try {
        const exam = await loadManagedExam(req);
        if (!seb.isSebRequired(exam)) throw clientError('Safe Exam Browser is not turned on for this exam', 409);
        sendSebFile(req, res, exam);
    } catch (err) {
        sendError(res, err, 'Failed to build the .seb file', 'downloadSebConfigStaff');
    }
};

/**
 * GET /exams/:examId/seb-config/:token (no bearer auth: SEB downloads it itself after a seb(s):// link).
 * 404 unless SEB is on and the token matches.
 */
exports.downloadSebConfig = async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.examId);
        const expected = exam?.proctoring?.sebConfigToken;
        const ok = Boolean(exam && !exam.template?.isTemplate && seb.isSebRequired(exam) && expected && seb.safeEqual(String(req.params.token || ''), expected));
        if (!ok) return res.status(404).json({ error: 'Not found' });
        sendSebFile(req, res, exam);
    } catch (err) {
        sendError(res, err, 'Failed to build the .seb file', 'downloadSebConfig');
    }
};

/**
 * GET /exams/:examId/seb-check (enrolled student or managing staff): how this request looks to the SEB
 * check. Lets a teacher verify one real SEB laptop before switching an exam to strict mode.
 */
exports.sebCheck = async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.examId);
        if (!exam || exam.template?.isTemplate) throw clientError('Exam not found', 404);
        const staff = ['admin', 'teacher', 'superAdmin'].includes(req.user.role);
        if (staff) {
            if (!(await canManageExam(req.user, exam))) throw clientError('You do not manage this exam', 403);
        } else {
            if (exam.status === 'draft') throw clientError('Exam not found', 404);
            const enrolled = await Class.exists({ _id: exam.classId, students: req.user._id });
            if (!enrolled) throw clientError('You are not enrolled in this class', 403);
        }
        const plain = exam.toObject();
        const result = seb.checkSebRequest(req, plain);
        let expected = null;
        if (staff && seb.isSebRequired(plain)) {
            try {
                const computed = seb.computeConfigKey(seb.buildSebSettings(plain, req));
                expected = { computedConfigKey: computed, effectiveConfigKey: seb.expectedConfigKey(plain, req).key };
            } catch {
                expected = null;
            }
        }
        res.json({
            sebRequired: seb.isSebRequired(plain),
            ...result,
            wouldPass: seb.isSebRequired(plain) ? result.ok : true,
            userAgent: String(req.get('user-agent') || '').slice(0, 300),
            ...(expected || {}),
            serverTime: new Date(),
        });
    } catch (err) {
        sendError(res, err, 'Failed to check Safe Exam Browser', 'sebCheck');
    }
};

// ---------------------------------------------------------------------------
// Student: taking an exam
// ---------------------------------------------------------------------------

exports.getStudentExamSummary = async (req, res) => {
    try {
        const exam = await loadStudentExam(req, { allowArchived: true });
        const [attempt, cls] = await Promise.all([
            ExamAttempt.findOne({ examId: exam._id, studentId: req.user._id }),
            Class.findById(exam.classId).select('name').lean(),
        ]);
        await closeIfExpired(exam, attempt);
        const released = releasedFor(exam);
        const now = Date.now();
        const sebInfo = seb.isSebRequired(exam) ? { required: true, link: seb.launchLinkFor(exam, req) } : { required: false };
        res.json({
            exam: { ...studentExamSummary(exam), className: cls?.name || null, released, seb: sebInfo },
            sebLink: sebInfo.link || null,
            attempt: studentAttempt(attempt, { released, exam, now }),
            serverTime: new Date(now),
        });
    } catch (err) {
        sendError(res, err, 'Failed to load exam', 'getStudentExamSummary');
    }
};

exports.startExam = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const phase = examPhase(exam);
        if (phase === 'scheduled') {
            return res.status(403).json({ error: 'This exam has not opened yet', startTime: exam.proctoring?.startTime });
        }
        if (phase !== 'live') throw clientError('This exam has closed', 403);
        if (!exam.questions?.length) throw clientError('This exam has no questions yet', 400);

        let attempt = await ExamAttempt.findOne({ examId: exam._id, studentId: req.user._id });
        if (attempt) {
            await closeIfExpired(exam, attempt);
            if (isClosed(attempt)) throw clientError('You have already submitted this exam', 409);
        }
        // SEB entry password: needed to begin. Resuming an attempt already in progress does not ask again
        // (the student is already inside SEB; the SEB check itself still ran in the route middleware).
        if (seb.isSebRequired(exam) && attempt?.status !== 'in_progress') {
            await checkSebEntryPassword(exam, req);
        }
        if (!attempt) {
            const now = new Date();
            try {
                attempt = await ExamAttempt.create({
                    examId: exam._id,
                    studentId: req.user._id,
                    classId: exam.classId,
                    status: 'in_progress',
                    startedAt: now,
                    endsAt: examEndsAt(exam, now),
                    sectionTimers: (exam.sections || []).map((s) => ({
                        sectionId: s.sectionId,
                        remainingSeconds: s.durationSeconds || null,
                        completed: false,
                    })),
                    questionTimers: exam.questions.map((q) => ({
                        questionId: q.questionId,
                        remainingSeconds: q.timeLimitSeconds || null,
                        completed: false,
                    })),
                    currentSectionId: sectionIdOf(exam, orderedQuestions(exam)[0]),
                    currentQuestionId: orderedQuestions(exam)[0]?.questionId || null,
                });
            } catch (err) {
                if (err.code !== 11000) throw err;
                attempt = await ExamAttempt.findOne({ examId: exam._id, studentId: req.user._id });
            }
        }
        if (attempt.status === 'not_started') {
            attempt.status = 'in_progress';
            attempt.startedAt = attempt.startedAt || new Date();
            attempt.endsAt = attempt.endsAt || examEndsAt(exam, attempt.startedAt);
            await attempt.save();
        }
        // Starts the current section/question timers (new attempts, and resumed pre-migration attempts).
        const now = Date.now();
        attempt = await syncAttemptTimers(exam, attempt, now);

        const docs = await Question.find({ _id: { $in: exam.questions.map((q) => q.questionId) } });
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        const questions = [...exam.questions]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((meta) => {
                const doc = byId.get(idOf(meta.questionId));
                if (!doc) return null;
                return {
                    ...sanitizeQuestionForExam(doc),
                    sectionId: meta.sectionId,
                    points: meta.points,
                    timeLimitSeconds: meta.timeLimitSeconds,
                };
            })
            .filter(Boolean);
        const codingIds = new Set(questions.filter((q) => CODING_TYPES.includes(q.type)).map((q) => String(q._id)));
        const cls = await Class.findById(exam.classId).select('name').lean();

        res.json({
            exam: { ...studentExamSummary(exam), className: cls?.name || null },
            attempt: studentAttempt(attempt, { codingIds, exam, now }),
            questions,
            questionDetails: questions,
            serverTime: new Date(now),
        });
    } catch (err) {
        sendError(res, err, 'Failed to start exam', 'startExam');
    }
};

exports.getAttempt = async (req, res) => {
    try {
        const exam = await loadStudentExam(req, { allowArchived: true });
        const attempt = await ExamAttempt.findOne({ examId: exam._id, studentId: req.user._id });
        if (!attempt) throw clientError('Attempt not found', 404);
        await closeIfExpired(exam, attempt);
        const now = Date.now();
        const synced = await syncAttemptTimers(exam, attempt, now);
        res.json({
            attempt: studentAttempt(synced, { released: releasedFor(exam), codingIds: await codingIdsFor(exam), exam, now }),
            serverTime: new Date(now),
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch attempt', 'getAttempt');
    }
};

exports.submitAnswer = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        await assertAttemptOpen(exam, attempt);
        const { questionId, answer, language } = req.body;
        if (!isObjectId(questionId)) throw clientError('questionId is required');
        const meta = assertQuestionOpen(exam, attempt, questionId);
        const question = await Question.findById(questionId);
        if (!question) throw clientError('Question not found', 404);

        const maxScore = Number(meta.points) || 0;
        const graded = await gradeAnswer(question, answer, language, maxScore);
        const coding = CODING_TYPES.includes(question.type);

        const submission = await Submission.create({
            questionId,
            classId: attempt.classId,
            studentId: req.user._id,
            answer: graded.answer,
            language: coding ? language : undefined,
            isCorrect: graded.isCorrect,
            score: graded.score,
            output: graded.output,
            isRun: false,
            passedTestCases: graded.passedTestCases,
            totalTestCases: graded.totalTestCases,
            examAttemptId: attempt._id,
        });

        // AI-generated-code check: coding answers in exams only; asynchronous, never blocks or fails the save.
        if (coding) {
            try {
                scheduleAiCheck({ submissionId: submission._id, examId: exam._id, attemptId: attempt._id, questionId });
            } catch (err) {
                console.warn('[exam] scheduleAiCheck failed:', err?.message);
            }
        }

        const savedAt = new Date();
        const entry = {
            questionId,
            submissionId: submission._id,
            answer: graded.answer,
            score: graded.score,
            maxScore,
            isCorrect: graded.isCorrect,
            language: coding ? language : undefined,
            passedTestCases: graded.passedTestCases,
            totalTestCases: graded.totalTestCases,
            savedAt,
        };
        const applyAnswer = (doc) => {
            const i = doc.answers.findIndex((a) => sameId(a.questionId, questionId));
            if (i >= 0) doc.answers[i] = entry;
            else doc.answers.push(entry);
            // Not moving currentQuestionId here: only /navigate changes position (and the running timers).
        };
        applyAnswer(attempt);
        // Grading took seconds; a concurrent auto-submit may have closed the attempt meanwhile.
        const fresh = await ExamAttempt.findById(attempt._id).select('status endsAt');
        if (!fresh || isClosed(fresh)) throw clientError('Time is up. Your exam has been submitted.', 409);
        await saveAttemptWithRetry(attempt, (doc) => {
            if (isClosed(doc)) throw clientError('Time is up. Your exam has been submitted.', 409);
            applyAnswer(doc);
        });

        res.json({
            message: 'Answer saved',
            savedAt,
            questionId,
            ...(coding
                ? {
                      passedTestCases: graded.passedTestCases,
                      totalTestCases: graded.totalTestCases,
                      testResults: graded.testResults || null,
                      executionError: graded.executionError || null,
                  }
                : {}),
        });
    } catch (err) {
        sendError(res, err, 'Failed to save answer', 'submitAnswer');
    }
};

exports.runCode = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        if (exam.proctoring?.allowRunCode === false) throw clientError('Running code is turned off for this exam', 403);
        const attempt = await loadOwnAttempt(req, exam);
        await assertAttemptOpen(exam, attempt);
        const { questionId, answer, language, customInput, expectedOutput } = req.body;
        if (!isObjectId(questionId)) throw clientError('questionId is required');
        assertQuestionOpen(exam, attempt, questionId);
        const question = await Question.findById(questionId);
        if (!question) throw clientError('Question not found', 404);
        if (!CODING_TYPES.includes(question.type)) throw clientError('Only coding questions can be run');
        assertCodingInput(question, answer, language);

        const custom = typeof customInput === 'string' && customInput.trim() !== '';
        const tests = custom
            ? [{ input: customInput, expectedOutput: typeof expectedOutput === 'string' ? expectedOutput : '', isPublic: true }]
            : question.testCases.filter((tc) => tc.isPublic);
        if (!tests.length) throw clientError('This question has no sample tests. Run it with your own input instead.');

        let results;
        try {
            results = await executeDockerCode(language, runnableCode(question, answer, language), tests, question.timeLimit, question.memoryLimit, {
                wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language),
            });
        } catch (err) {
            const busy = err?.status === 429;
            throw clientError(busy ? err.message : `Your code could not be run: ${err.message}`, busy ? 429 : 422);
        }
        res.json({ custom, testResults: sanitizeTestResultsForStudent(results) });
    } catch (err) {
        sendError(res, err, 'Failed to run code', 'runCode');
    }
};

exports.logProctoringEvent = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        const { type, details } = req.body;
        if (!VIOLATION_TYPES.includes(type)) throw clientError('Unknown event type');

        await closeIfExpired(exam, attempt);
        if (isClosed(attempt)) {
            return res.json({ success: true, terminate: attempt.status === 'terminated', status: attempt.status, endsAt: attempt.endsAt });
        }

        const MAX_VIOLATIONS = 500;
        const detailText =
            details === undefined || details === null
                ? undefined
                : String(typeof details === 'object' ? JSON.stringify(details) : details).slice(0, 512);
        const applyEvent = (doc) => {
            if (type === 'heartbeat') {
                doc.lastHeartbeatAt = new Date();
                return;
            }
            if (doc.violations.length >= MAX_VIOLATIONS) doc.violations.splice(0, doc.violations.length - MAX_VIOLATIONS + 1);
            doc.violations.push({ type, details: detailText, timestamp: new Date() });
            if (type === 'network_loss') doc.networkDropCount += 1;
            else {
                doc.violationCount += 1;
                if (type === 'tab_switch') doc.tabSwitchCount += 1;
                if (type === 'fullscreen_exit') doc.fullscreenExitCount += 1;
                if (type === 'copy_paste') doc.copyPasteCount += 1;
            }
        };
        applyEvent(attempt);

        const limit = exam.proctoring?.tabSwitchLimit ?? 5;
        if (type === 'tab_switch' && limit > 0 && attempt.tabSwitchCount >= limit) {
            await finalizeAttempt(exam, attempt, 'terminated', `Locked after ${attempt.tabSwitchCount} tab switches`);
        } else {
            await saveAttemptWithRetry(attempt, applyEvent);
        }

        res.json({
            success: true,
            terminate: attempt.status === 'terminated',
            status: attempt.status,
            endsAt: attempt.endsAt,
            tabSwitchCount: attempt.tabSwitchCount,
            tabSwitchLimit: limit,
            serverTime: new Date(),
        });
    } catch (err) {
        sendError(res, err, 'Failed to log event', 'logProctoringEvent');
    }
};

const firstQuestionOfSection = (exam, sectionId) => orderedQuestions(exam).find((q) => sectionIdOf(exam, q) === sectionId) || null;

const timerResponse = (exam, attempt, now) => ({
    success: true,
    status: attempt.status,
    endsAt: attempt.endsAt,
    ...timerState(exam, attempt, now),
    serverTime: new Date(now),
});

/**
 * Move the attempt to `targetId` (or just reconcile when null), optionally locking a timer, and save.
 * Shared by POST /navigate and the legacy PATCH timer routes.
 */
const moveAttempt = async (exam, attempt, targetId, finish) => {
    await assertAttemptOpen(exam, attempt);
    const now = Date.now();
    const apply = (doc) => {
        if (isClosed(doc)) throw clientError('This attempt is already closed', 409);
        if (targetId) navigateTimers(exam, doc, targetId, now);
        else reconcileTimers(exam, doc, now);
        if (finish) {
            finish(doc, now);
            reconcileTimers(exam, doc, now);
        }
    };
    apply(attempt);
    const saved = attempt.isModified() ? await saveAttemptWithRetry(attempt, apply) : attempt;
    return { saved, now };
};

/**
 * POST /:examId/navigate { attemptId, questionId?, sectionId? }
 * The student opened another question (or section: its first question). The server pauses the timers
 * that were running, starts the new ones and returns the authoritative timer state + serverTime.
 */
exports.navigate = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        const { questionId, sectionId } = req.body;
        let target = null;
        if (questionId) {
            target = isObjectId(questionId) ? questionMeta(exam, questionId) : null;
            if (!target) throw clientError('This question is not part of the exam');
            if (sectionId && sectionIdOf(exam, target) !== String(sectionId)) throw clientError('That question is not in this section');
        } else if (sectionId) {
            if (!sectionConf(exam, String(sectionId))) throw clientError('Unknown section');
            target = firstQuestionOfSection(exam, String(sectionId));
            if (!target) throw clientError('That section has no questions');
        }
        const { saved, now } = await moveAttempt(exam, attempt, target ? idOf(target.questionId) : null);
        res.json(timerResponse(exam, saved, now));
    } catch (err) {
        sendError(res, err, 'Failed to change question', 'navigate');
    }
};

/**
 * Legacy: PATCH /:examId/section-timer { attemptId, sectionId, currentQuestionId?, completed? }.
 * `remainingSeconds` is ignored: the server owns the clock. It can only switch the current
 * question/section (same as /navigate) or lock the section (completed: true).
 */
exports.updateSectionTimer = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        const { sectionId, completed, currentQuestionId } = req.body;
        const section = sectionId ? sectionConf(exam, String(sectionId)) : null;
        if (!section) throw clientError('sectionId is required');
        let target = isObjectId(currentQuestionId) ? questionMeta(exam, currentQuestionId) : null;
        if (target && sectionIdOf(exam, target) !== section.sectionId) target = null;
        if (!target && currentPosition(exam, attempt).sectionId !== section.sectionId) target = firstQuestionOfSection(exam, section.sectionId);
        const limit = Number(section.durationSeconds) || 0;
        const finish = completed === true ? (doc, now) => completeTimer(ensureTimer(doc, 'section', section.sectionId, limit), limit, now) : null;
        const { saved, now } = await moveAttempt(exam, attempt, target ? idOf(target.questionId) : null, finish);
        res.json(timerResponse(exam, saved, now));
    } catch (err) {
        sendError(res, err, 'Failed to update section timer', 'updateSectionTimer');
    }
};

/**
 * Legacy: PATCH /:examId/question-timer { attemptId, questionId, completed? }.
 * `remainingSeconds` is ignored. Opens the question (same as /navigate) and optionally locks it.
 */
exports.updateQuestionTimer = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        const { questionId, completed } = req.body;
        const meta = isObjectId(questionId) ? questionMeta(exam, questionId) : null;
        if (!meta) throw clientError('questionId is required');
        const key = idOf(meta.questionId);
        const limit = Number(meta.timeLimitSeconds) || 0;
        const finish = completed === true ? (doc, now) => completeTimer(ensureTimer(doc, 'question', key, limit), limit, now) : null;
        const { saved, now } = await moveAttempt(exam, attempt, key, finish);
        res.json(timerResponse(exam, saved, now));
    } catch (err) {
        sendError(res, err, 'Failed to update question timer', 'updateQuestionTimer');
    }
};

const closeResponse = (exam, attempt, message) => ({
    message,
    attempt: { _id: attempt._id, status: attempt.status, submittedAt: attempt.submittedAt },
    resultsAvailable: releasedFor(exam),
});

exports.submitExam = async (req, res) => {
    try {
        const exam = await loadStudentExam(req, { allowArchived: true });
        const attempt = await loadOwnAttempt(req, exam);
        if (await closeIfExpired(exam, attempt)) return res.json(closeResponse(exam, attempt, 'Time was up, so the exam was submitted'));
        if (isClosed(attempt)) throw clientError('This attempt is already closed', 409);
        await finalizeAttempt(exam, attempt, 'submitted');
        res.json(closeResponse(exam, attempt, 'Exam submitted'));
    } catch (err) {
        sendError(res, err, 'Failed to submit exam', 'submitExam');
    }
};

exports.autoSubmitExam = async (req, res) => {
    try {
        const exam = await loadStudentExam(req, { allowArchived: true });
        const attempt = await loadOwnAttempt(req, exam);
        if (isClosed(attempt)) return res.json(closeResponse(exam, attempt, 'Attempt already closed'));
        const endsAt = attempt.endsAt ? new Date(attempt.endsAt).getTime() : 0;
        if (Date.now() < endsAt - GRACE_MS) throw clientError('There is still time left on this exam', 409);
        await finalizeAttempt(exam, attempt, 'auto_submitted', 'Time ran out');
        res.json(closeResponse(exam, attempt, 'Time is up. Your exam was submitted.'));
    } catch (err) {
        sendError(res, err, 'Failed to auto submit exam', 'autoSubmitExam');
    }
};

exports.getStudentExamResults = async (req, res) => {
    try {
        const exam = await loadStudentExam(req, { allowArchived: true });
        const attempt = await ExamAttempt.findOne({ examId: exam._id, studentId: req.user._id });
        if (!attempt) throw clientError('You have not taken this exam', 404);
        await closeIfExpired(exam, attempt);
        if (!isClosed(attempt)) throw clientError('Submit the exam to see your results', 409);

        const cls = await Class.findById(exam.classId).select('name').lean();
        const released = releasedFor(exam);
        const summary = {
            exam: {
                _id: exam._id,
                title: exam.title,
                description: exam.description,
                classId: exam.classId,
                className: cls?.name || null,
                questionCount: exam.questions.length,
                totalPoints: totalPoints(exam),
            },
            released,
            attempt: {
                status: attempt.status,
                startedAt: attempt.startedAt,
                submittedAt: attempt.submittedAt,
                remark: attempt.remark,
                answeredCount: attempt.answers.length,
            },
        };
        if (!released) return res.json(summary);

        // Scores may be released immediately, but answer keys only once nobody can still be writing:
        // the exam window has closed, or staff explicitly released results.
        const keysVisible = exam.scoring?.releaseStatus === 'released' || ['completed', 'archived'].includes(examPhase(exam));
        const docs = await Question.find({ _id: { $in: exam.questions.map((q) => q.questionId) } })
            .select('title type difficulty description options correctOption correctOptions correctAnswer')
            .lean();
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        const answers = new Map(attempt.answers.map((a) => [idOf(a.questionId), a]));
        const sectionTitle = new Map((exam.sections || []).map((s) => [s.sectionId, s.title]));

        res.json({
            ...summary,
            attempt: { ...summary.attempt, totalScore: attempt.totalScore, maxScore: attempt.maxScore || totalPoints(exam) },
            answerKeysVisible: keysVisible,
            questions: [...exam.questions]
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map((meta) => {
                    const doc = byId.get(idOf(meta.questionId)) || {};
                    const ans = answers.get(idOf(meta.questionId));
                    const coding = CODING_TYPES.includes(doc.type);
                    return {
                        questionId: meta.questionId,
                        section: sectionTitle.get(meta.sectionId) || null,
                        points: Number(meta.points) || 0,
                        title: doc.title || 'Deleted question',
                        type: doc.type || null,
                        difficulty: doc.difficulty || null,
                        description: doc.description || '',
                        options: doc.options || [],
                        correctOption: coding || !keysVisible ? undefined : doc.correctOption,
                        correctOptions: coding || !keysVisible ? undefined : doc.correctOptions,
                        correctAnswer: coding || !keysVisible ? undefined : doc.correctAnswer,
                        response: ans
                            ? {
                                  answer: ans.answer,
                                  language: ans.language,
                                  score: ans.score,
                                  isCorrect: ans.isCorrect,
                                  passedTestCases: ans.passedTestCases,
                                  totalTestCases: ans.totalTestCases,
                                  savedAt: ans.savedAt,
                              }
                            : null,
                    };
                }),
        });
    } catch (err) {
        sendError(res, err, 'Failed to fetch exam results', 'getStudentExamResults');
    }
};
