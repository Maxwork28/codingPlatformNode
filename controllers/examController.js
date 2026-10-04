const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Class = require('../models/Class');
const Submission = require('../models/Submission');
const Question = require('../models/Question');
const { mergeDriverWithUserAnswer } = require('../utils/codingDriverMerge');
const { parseOptionalPoints } = require('../utils/optionalPoints');
const { examPhase } = require('../utils/examPhase');
const {
    executeDockerCode,
    shouldMergeDriverForLanguage,
    shouldWrapBareArrayStdinForQuestion,
    sanitizeTestResultsForStudent
} = require('./questionController');

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
const parseDate = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};
const clientError = (message, status = 400) => Object.assign(new Error(message), { status });
const sendError = (res, err, fallback, tag) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
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

const readExamBody = async (body, base) => {
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
        },
        scoring: {
            immediateScoreRelease: exam.scoring?.immediateScoreRelease,
            releaseStatus: exam.scoring?.releaseStatus,
        },
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
    };
};

const studentAttempt = (attempt, { released = false, codingIds = new Set() } = {}) => {
    if (!attempt) return null;
    const showScore = released && isClosed(attempt);
    return {
        _id: attempt._id,
        examId: attempt.examId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        endsAt: attempt.endsAt,
        submittedAt: attempt.submittedAt,
        currentSectionId: attempt.currentSectionId,
        currentQuestionId: attempt.currentQuestionId,
        sectionTimers: attempt.sectionTimers,
        questionTimers: attempt.questionTimers,
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
    attempt.answers = (attempt.answers || []).filter((a) => points.has(idOf(a.questionId)));
    attempt.totalScore = attempt.answers.reduce((sum, a) => sum + (Number(a.score) || 0), 0);
    attempt.maxScore = [...points.values()].reduce((sum, p) => sum + p, 0);
    attempt.status = status;
    attempt.autoSubmitted = status === 'auto_submitted';
    attempt.manualSubmitted = status === 'submitted';
    attempt.submittedAt = new Date();
    if (remark) attempt.remark = remark;
    await attempt.save();
    return attempt;
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
        if (!question.codeSnippet) throw clientError('This question is missing its code snippet');
        return question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
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
            const expected = String(question.correctAnswer || '').trim().toLowerCase();
            return result(answer.trim().toLowerCase() === expected, answer);
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
                    output: JSON.stringify(sanitizeTestResultsForStudent(tests)),
                    testResults: sanitizeTestResultsForStudent(tests),
                };
            } catch (err) {
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

/** Throws when the student may no longer change this question (timer ran out or section closed). */
const assertQuestionOpen = (exam, attempt, questionId) => {
    const meta = exam.questions.find((q) => sameId(q.questionId, questionId));
    if (!meta) throw clientError('This question is not part of the exam');
    const qTimer = (attempt.questionTimers || []).find((t) => sameId(t.questionId, questionId));
    if (meta.timeLimitSeconds && qTimer && qTimer.remainingSeconds === 0) throw clientError('Time for this question is over', 403);
    const section = (exam.sections || []).find((s) => s.sectionId === meta.sectionId);
    const sTimer = (attempt.sectionTimers || []).find((t) => t.sectionId === meta.sectionId);
    if (section?.durationSeconds && sTimer && sTimer.remainingSeconds === 0) throw clientError('Time for this section is over', 403);
    return meta;
};

const assertAttemptOpen = async (exam, attempt) => {
    if (await closeIfExpired(exam, attempt)) throw clientError('Time is up. Your exam has been submitted.', 409);
    if (isClosed(attempt)) throw clientError('This attempt is already closed', 409);
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
            exam: { ...plain, phase: examPhase(plain), totalPoints: totalPoints(plain) },
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
        const fields = await readExamBody(req.body, exam);
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
            proctoring: { ...plain.proctoring, startTime: null, endTime: null },
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
        res.json({
            exam: { ...studentExamSummary(exam), className: cls?.name || null, released },
            attempt: studentAttempt(attempt, { released }),
            serverTime: new Date(),
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
                        } else {
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
                    currentSectionId: exam.sections?.[0]?.sectionId || null,
                    currentQuestionId: exam.questions[0]?.questionId || null,
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
            attempt: studentAttempt(attempt, { codingIds }),
            questions,
            questionDetails: questions,
            serverTime: new Date(),
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
        res.json({ attempt: studentAttempt(attempt, { released: releasedFor(exam), codingIds: await codingIdsFor(exam) }), serverTime: new Date() });
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
        const idx = attempt.answers.findIndex((a) => sameId(a.questionId, questionId));
        if (idx >= 0) attempt.answers[idx] = entry;
        else attempt.answers.push(entry);
        attempt.currentQuestionId = questionId;
        await attempt.save();

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
            throw clientError(`Your code could not be run: ${err.message}`, 422);
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

        if (type === 'heartbeat') {
            attempt.lastHeartbeatAt = new Date();
        } else {
            attempt.violations.push({ type, details: typeof details === 'object' ? details : undefined, timestamp: new Date() });
            if (type === 'network_loss') attempt.networkDropCount += 1;
            else {
                attempt.violationCount += 1;
                if (type === 'tab_switch') attempt.tabSwitchCount += 1;
                if (type === 'fullscreen_exit') attempt.fullscreenExitCount += 1;
                if (type === 'copy_paste') attempt.copyPasteCount += 1;
            }
        }

        const limit = exam.proctoring?.tabSwitchLimit ?? 5;
        if (type === 'tab_switch' && limit > 0 && attempt.tabSwitchCount >= limit) {
            await finalizeAttempt(exam, attempt, 'terminated', `Locked after ${attempt.tabSwitchCount} tab switches`);
        } else {
            await attempt.save();
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

const updateTimer = (list, match, remainingSeconds, completed) => {
    const timer = list.find(match);
    if (!timer) return;
    if (typeof remainingSeconds === 'number' && timer.remainingSeconds != null) {
        // Timers only ever count down; a client cannot hand itself more time.
        timer.remainingSeconds = Math.max(0, Math.min(timer.remainingSeconds, Math.floor(remainingSeconds)));
        if (timer.remainingSeconds === 0) timer.completed = true;
    }
    if (completed === true) timer.completed = true;
};

exports.updateSectionTimer = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        await assertAttemptOpen(exam, attempt);
        const { sectionId, remainingSeconds, completed, currentQuestionId } = req.body;
        if (!sectionId) throw clientError('sectionId is required');
        updateTimer(attempt.sectionTimers || [], (t) => t.sectionId === sectionId, remainingSeconds, completed);
        attempt.currentSectionId = sectionId;
        if (isObjectId(currentQuestionId) && exam.questions.some((q) => sameId(q.questionId, currentQuestionId))) {
            attempt.currentQuestionId = currentQuestionId;
        }
        await attempt.save();
        res.json({ success: true });
    } catch (err) {
        sendError(res, err, 'Failed to update section timer', 'updateSectionTimer');
    }
};

exports.updateQuestionTimer = async (req, res) => {
    try {
        const exam = await loadStudentExam(req);
        const attempt = await loadOwnAttempt(req, exam);
        await assertAttemptOpen(exam, attempt);
        const { questionId, remainingSeconds, completed } = req.body;
        if (!isObjectId(questionId)) throw clientError('questionId is required');
        updateTimer(attempt.questionTimers || [], (t) => sameId(t.questionId, questionId), remainingSeconds, completed);
        attempt.currentQuestionId = questionId;
        await attempt.save();
        res.json({ success: true });
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

        const docs = await Question.find({ _id: { $in: exam.questions.map((q) => q.questionId) } })
            .select('title type difficulty description options correctOption correctOptions correctAnswer')
            .lean();
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        const answers = new Map(attempt.answers.map((a) => [idOf(a.questionId), a]));
        const sectionTitle = new Map((exam.sections || []).map((s) => [s.sectionId, s.title]));

        res.json({
            ...summary,
            attempt: { ...summary.attempt, totalScore: attempt.totalScore, maxScore: attempt.maxScore || totalPoints(exam) },
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
                        correctOption: coding ? undefined : doc.correctOption,
                        correctOptions: coding ? undefined : doc.correctOptions,
                        correctAnswer: coding ? undefined : doc.correctAnswer,
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
