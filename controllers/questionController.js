const mongoose = require('mongoose');
const fs = require('fs').promises;
const path = require('path');
const { mergeDriverWithUserAnswer } = require('../utils/codingDriverMerge');
const { normalizeQuestionRichTextFields } = require('../utils/normalizeRichTextField');
const { parseOptionalPoints, resolvePoints } = require('../utils/optionalPoints');
const { applyDefaultSolutions } = require('../utils/buildDefaultSolutions');
const { isS3Enabled, uploadQuestionImageToS3 } = require('../utils/s3');
const {
    executeDockerCode,
    supportedLanguages,
    parseOptionalJudgeLimit,
    summarizeRunCaseMetrics,
    averageNumbers,
    fieldLimitsFromAverages,
} = require('../utils/judge');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Class = require('../models/Class');
const Leaderboard = require('../models/Leaderboard');
const Exam = require('../models/Exam');
const {
    isAdmin,
    isTeacher,
    isStudent,
    isStaff,
    classManagedBy,
    classHasStudent,
    assertClassManager,
    assertClassMember,
    managedClassIds,
    enrolledClassIds,
    canManageQuestion,
    assertQuestionManager,
    assertStudentCanViewQuestion,
    httpError,
    sendError,
} = require('../utils/access');
const { typedAnswerMatches, buildFillTheCodeProgram, htmlToPlainText } = require('../utils/answerText');
const { sanitizeQuestionForStudent } = require('../utils/questionProjection');

const idStr = (v) => String(v?._id ?? v);
const studentInClass = (classData, userId) => classHasStudent(classData, { _id: userId });

/** Escape user input before embedding it in a $regex. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CODING_TYPES = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'];
const QUESTION_TYPES = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'];

/** Fields a staff user may set from the request body when creating / editing a question. */
const EDITABLE_QUESTION_FIELDS = [
    'title', 'description', 'difficulty', 'tags', 'points', 'hints', 'solution', 'solutionCode',
    'solutionLanguage', 'solutionCodes', 'level', 'type', 'options', 'correctOption', 'correctOptions',
    'correctAnswer', 'codeSnippet', 'starterCode', 'testCases', 'inputFormat', 'outputFormat', 'sampleIo',
    'constraints', 'examples', 'functionSignature', 'templateCode', 'driverCode', 'languages', 'timeLimit',
    'memoryLimit', 'maxAttempts', 'explanation',
];

const pickEditableQuestionFields = (body = {}) => {
    const out = {};
    for (const key of EDITABLE_QUESTION_FIELDS) {
        if (body[key] !== undefined) out[key] = body[key];
    }
    // Typed answers and fill-the-code templates are compared / executed as plain text.
    if (typeof out.correctAnswer === 'string') out.correctAnswer = htmlToPlainText(out.correctAnswer).trim();
    if (typeof out.codeSnippet === 'string') out.codeSnippet = htmlToPlainText(out.codeSnippet);
    return out;
};

/** Secret question fields that must never appear in list / search responses. */
const LIST_HIDDEN_SELECT = '-solution -solutionCode -solutionCodes -driverCode -correctOption -correctOptions -correctAnswer';

const withTestCaseCount = (q) => {
    const obj = q && typeof q.toObject === 'function' ? q.toObject() : { ...q };
    obj.testCaseCount = Array.isArray(obj.testCases) ? obj.testCases.length : 0;
    delete obj.testCases;
    return obj;
};

/** True for errors the judge wants propagated verbatim (e.g. 429 JudgeBusyError). */
const isHttpError = (err) => Number.isInteger(Number(err?.status)) && Number(err.status) >= 400 && Number(err.status) < 500;

/** Student attempt status for a set of questions in a class: attempted | wrong | not_viewed (bounded per-question rows). */
const studentAttemptStatusMap = async (classId, studentId) => {
    const lb = await Leaderboard.findOne({ classId, studentId }).select('questions highestScores').lean();
    const statusByQuestion = {};
    Leaderboard.questionRows(lb).forEach((row) => {
        const qId = String(row.questionId);
        if (row.isCorrect) statusByQuestion[qId] = 'attempted';
        else if ((row.attempts || 0) > 0) statusByQuestion[qId] = 'wrong';
    });
    return statusByQuestion;
};

const RECENT_ATTEMPTS_LIMIT = 50;

/**
 * Last N practice submits for one student in one class, in the old leaderboard `attempts[]` row shape.
 * Served by the { studentId, submittedAt } index; full history stays in the Submission collection.
 */
const recentLeaderboardAttempts = async (classId, studentId, rows = [], limit = RECENT_ATTEMPTS_LIMIT) => {
    const typeByQuestion = new Map(rows.map((r) => [String(r.questionId), r.questionType]));
    const subs = await Submission.find({
        studentId: idStr(studentId),
        classId,
        isRun: false,
        examAttemptId: { $exists: false },
    })
        .select('questionId isCorrect score submittedAt passedTestCases totalTestCases')
        .sort({ submittedAt: -1 })
        .limit(limit)
        .lean();
    return subs.map((s) => ({
        questionId: s.questionId,
        questionType: typeByQuestion.get(String(s.questionId)),
        submissionId: s._id,
        isCorrect: Boolean(s.isCorrect),
        score: s.score || 0,
        submittedAt: s.submittedAt,
        isRun: false,
        passedTestCases: s.passedTestCases,
        totalTestCases: s.totalTestCases,
    }));
};

/** Student-safe projection of a question for one class (keeps `classes` limited to that class for the frontend). */
const studentQuestionView = (question, classId, extra = {}) => {
    const entry = (question.classes || []).find((c) => idStr(c.classId) === String(classId));
    return sanitizeQuestionForStudent(question, {
        classId,
        extra: {
            classes: entry ? [typeof entry.toObject === 'function' ? entry.toObject() : entry] : [],
            ...extra,
        },
    });
};

/**
 * Shared pre-checks for student submit / run endpoints.
 * Returns { question, classEntry } or throws an error with `.status`.
 */
const loadStudentRunContext = async (user, questionId, classId, { label }) => {
    if (!classId || !mongoose.Types.ObjectId.isValid(String(classId))) throw httpError(400, 'A valid classId is required');
    if (!mongoose.Types.ObjectId.isValid(String(questionId))) throw httpError(400, 'Invalid question id');
    if (user.isBlocked?.get?.(String(classId))) throw httpError(403, `You are blocked from ${label} in this class`);
    const question = await Question.findById(questionId);
    const classEntry = await assertStudentCanViewQuestion(user, question, classId);
    if (classEntry.isDisabled) throw httpError(403, `Question is disabled for ${label} in this class`);
    return { question, classEntry };
};


/** Teachers need canCreateQuestion to create or edit a question. */
const ensureTeacherCanCreateQuestion = (user, actionLabel, res) => {
    if (user.role === 'teacher' && !user.canCreateQuestion) {
        console.warn(`${actionLabel} Error: Teacher lacks permission to create questions`);
        res.status(403).json({ error: 'Teacher is not permitted to create questions' });
        return false;
    }
    return true;
};

/**
 * Store a question diagram/screenshot.
 * Uses S3 when AWS_S3_BUCKET or AWS_S3_BUCKET_NAME is set; otherwise writes under /uploads/questions.
 */
exports.uploadQuestionImage = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        if (isS3Enabled()) {
            const { url } = await uploadQuestionImageToS3({
                buffer: req.file.buffer,
                contentType: req.file.mimetype,
                originalName: req.file.originalname,
                userId: req.user?._id,
            });
            console.log('[Upload Question Image] S3', { userId: req.user?._id, url });
            return res.status(200).json({ url });
        }

        const ext = path.extname(req.file.originalname || '').toLowerCase() || '.png';
        const safeExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? ext : '.png';
        const filename = `${req.user._id}-${Date.now()}${safeExt}`;
        const destDir = path.join(__dirname, '..', 'uploads', 'questions');
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(path.join(destDir, filename), req.file.buffer);
        const url = `/uploads/questions/${filename}`;
        console.log('[Upload Question Image] local', { userId: req.user?._id, url });
        return res.status(200).json({ url });
    } catch (err) {
        return sendError(res, err, 'Error uploading image', 'Upload Question Image');
    }
};


/**
 * True when this question has driver code for the selected language.
 * Used so we still merge driver + student answer if the question was saved as type "coding"
 * by mistake instead of "codingWithDriver" (otherwise only a bare function runs → no stdout).
 */
const shouldMergeDriverForLanguage = (question, language) => {
    if (question.type === 'fillInTheBlanksCoding') return false;
    if (question.type !== 'coding' && question.type !== 'codingWithDriver') return false;
    if (!Array.isArray(question.driverCode) || question.driverCode.length === 0) return false;
    return question.driverCode.some(
        (d) => d.language === language && d.code && String(d.code).trim().length > 0
    );
};

/** Bare-array stdin normalization for LeetCode-style JSON tests */
const shouldWrapBareArrayStdinForQuestion = (question, language) =>
    question.type === 'codingWithDriver' || shouldMergeDriverForLanguage(question, language);

const resolveFillInTheBlanksCodingCode = (question, answer, language) =>
    buildFillTheCodeProgram(question, answer, language);

exports.executeDockerCode = executeDockerCode;
exports.shouldMergeDriverForLanguage = shouldMergeDriverForLanguage;
exports.shouldWrapBareArrayStdinForQuestion = shouldWrapBareArrayStdinForQuestion;

/** Student-facing test result rows with stable numbering and hidden I/O for private cases */
const sanitizeTestResultsForStudent = (testResults = []) =>
    testResults.map((r, index) => ({
        testCaseNumber: index + 1,
        passed: !!r.passed,
        isPublic: r.isPublic !== false,
        status: r.status,
        isTLE: !!r.isTLE,
        isMLE: !!r.isMLE,
        timeMs: r.timeMs ?? null,
        memoryKb: r.memoryKb ?? null,
        ...(r.isPublic !== false
            ? {
                input: r.input,
                output: r.output,
                expected: r.expected,
                error: r.error || null,
            }
            : {}),
    }));

exports.sanitizeTestResultsForStudent = sanitizeTestResultsForStudent;

exports.submitAnswer = async (req, res) => {
    try {
        const { questionId } = req.params;
        const { answer, classId, language } = req.body;
        const user = req.user;

        console.log('[Submission] User:', user._id, '| Question:', questionId, '| Class:', classId, '| Language:', language);

        if (!isStudent(user)) {
            return res.status(403).json({ error: 'Only students can submit answers' });
        }

        const { question } = await loadStudentRunContext(user, questionId, classId, { label: 'submitting' });

        if (question.maxAttempts) {
            const submissionCount = await Submission.countDocuments({
                questionId,
                classId,
                studentId: user._id,
                isRun: false
            });
            if (submissionCount >= question.maxAttempts) {
                return res.status(403).json({ error: 'Maximum submission attempts reached' });
            }
        }

        let isCorrect = false;
        let output = null;
        let score = 0;
        let codeToExecute = answer;
        let passedTestCases = 0;
        let totalTestCases = 0;
        let testResultsForResponse = null;
        let submissionStatus;

        if (question.type === 'singleCorrectMcq') {
            isCorrect = parseInt(answer) === question.correctOption;
            score = isCorrect ? resolvePoints(question.points) : 0;
            output = String(answer ?? '');
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
        } else if (question.type === 'multipleCorrectMcq') {
            const submittedOptions = Array.isArray(answer) ? answer.map(Number) : [parseInt(answer)];
            const correctOptions = question.correctOptions || [];
            isCorrect = submittedOptions.length === correctOptions.length &&
                       submittedOptions.every(opt => correctOptions.includes(opt)) &&
                       correctOptions.every(opt => submittedOptions.includes(opt));
            score = isCorrect ? resolvePoints(question.points) : 0;
            output = JSON.stringify(submittedOptions);
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
        } else if (question.type === 'fillInTheBlanks') {
            if (typeof answer !== 'string') {
                return res.status(400).json({ error: 'Answer must be a string' });
            }
            isCorrect = typedAnswerMatches(answer, question.correctAnswer);
            score = isCorrect ? resolvePoints(question.points) : 0;
            output = answer;
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
        } else if (CODING_TYPES.includes(question.type)) {
            submissionStatus = 'wrong_answer';
            if (!language || !question.languages.includes(language)) {
                return res.status(400).json({ error: `Language ${language} is not supported for this question` });
            }
            if (typeof answer !== 'string' || !answer.trim()) {
                return res.status(400).json({ error: 'Code is required' });
            }
            if (question.type === 'fillInTheBlanksCoding' && !question.codeSnippet && !question.starterCode?.length) {
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
            try {
                if (question.type === 'fillInTheBlanksCoding') {
                    codeToExecute = resolveFillInTheBlanksCodingCode(question, answer, language);
                } else if (shouldMergeDriverForLanguage(question, language)) {
                    const driverCodeObj = question.driverCode.find(d => d.language === language);
                    if (driverCodeObj && driverCodeObj.code) {
                        codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                    }
                }
                const testResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    question.testCases,
                    question.timeLimit,
                    question.memoryLimit,
                    { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
                );
                testResultsForResponse = testResults;
                totalTestCases = testResults.length;
                passedTestCases = testResults.filter(test => test.passed).length;
                isCorrect = totalTestCases > 0 && testResults.every(test => test.passed);
                score = isCorrect
                    ? resolvePoints(question.points)
                    : (totalTestCases ? Math.floor((passedTestCases / totalTestCases) * resolvePoints(question.points)) : 0);
                const firstFail = testResults.find(t => !t.passed);
                submissionStatus = isCorrect ? 'accepted' : (firstFail?.status || 'wrong_answer');
                output = JSON.stringify(sanitizeTestResultsForStudent(testResults));
                console.log('[Submission] Judged:', passedTestCases, '/', totalTestCases, 'passed');
            } catch (err) {
                // Judge saturated (429) or other client-facing judge error: do not record an attempt.
                if (isHttpError(err)) return sendError(res, err, 'Judge unavailable', 'Submission');
                console.error('[Submission] Code execution failed:', err.message);
                isCorrect = false;
                score = 0;
                const errLower = (err.message || '').toLowerCase();
                submissionStatus = errLower.includes('timeout') ? 'tle' : errLower.includes('memory') || errLower.includes('oom') || errLower.includes('killed') ? 'mle' : 'runtime_error';
                output = 'Error: code execution failed';
                passedTestCases = 0;
                totalTestCases = question.testCases.length;
            }
        } else {
            return res.status(400).json({ error: 'Unsupported question type' });
        }

        const submission = new Submission({
            questionId,
            classId,
            studentId: user._id,
            answer,
            language,
            isCorrect,
            score,
            output,
            isRun: false,
            passedTestCases,
            totalTestCases,
            status: submissionStatus || (isCorrect ? 'accepted' : 'wrong_answer'),
            testResults: testResultsForResponse || undefined,
        });
        await submission.save();
        console.log('[Submission] Saved submission:', submission._id);

        await Class.updateOne({ _id: classId }, { $inc: { totalSubmits: 1 } });

        // One atomic pipeline update: per-question aggregate row + totals (no history, no VersionError retries).
        await Leaderboard.recordSubmit({
            classId,
            studentId: user._id,
            questionId: question._id,
            questionType: question.type,
            submissionId: submission._id,
            isCorrect,
            score,
            submittedAt: submission.submittedAt,
            passedTestCases,
            totalTestCases,
        });

        req.io?.to(`class:${classId}`).emit('analyticsUpdated', { classId });
        req.io?.to(`class:${classId}`).emit('submissionUpdate', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            isCorrect,
            passedTestCases,
            totalTestCases
        });

        const submissionJson = submission.toObject();
        delete submissionJson.testResults;
        const responsePayload = {
            message: 'Answer submitted successfully',
            submission: submissionJson,
            passedTestCases,
            totalTestCases,
            explanation: question.explanation,
        };
        if (testResultsForResponse) {
            responsePayload.testResults = sanitizeTestResultsForStudent(testResultsForResponse);
            responsePayload.publicTestCases = testResultsForResponse.filter((t) => t.isPublic).length;
            responsePayload.hiddenTestCases = testResultsForResponse.filter((t) => !t.isPublic).length;
        }
        res.status(200).json(responsePayload);
    } catch (err) {
        return sendError(res, err, 'Error submitting answer', 'Submission');
    }
};

exports.runQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const { answer, classId, language } = req.body;
        const user = req.user;
        console.log('[Run Question] User:', user._id, '| Question:', questionId, '| Class:', classId, '| Language:', language);

        if (!isStudent(user)) {
            return res.status(403).json({ error: 'Only students can run code' });
        }

        const { question } = await loadStudentRunContext(user, questionId, classId, { label: 'running code' });

        if (!CODING_TYPES.includes(question.type)) {
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be run' });
        }

        if (!language || !question.languages.includes(language)) {
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }
        if (typeof answer !== 'string' || !answer.trim()) {
            return res.status(400).json({ error: 'Code is required' });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            codeToExecute = resolveFillInTheBlanksCodingCode(question, answer, language);
            if (!codeToExecute) {
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
            }
        }

        // Runs only ever execute public test cases, so stored results contain no hidden I/O.
        const publicTestCases = question.testCases.filter(tc => tc.isPublic);
        if (publicTestCases.length === 0) {
            return res.status(400).json({ error: 'No public test cases available for this question' });
        }

        let testResults;
        try {
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                publicTestCases,
                question.timeLimit,
                question.memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
        } catch (err) {
            return sendError(res, err, 'Code execution failed', 'Run Question');
        }

        const passedCount = testResults.filter(test => test.passed).length;
        const isCorrect = testResults.length > 0 && testResults.every(test => test.passed);
        const firstFail = testResults.find(t => !t.passed);
        const runStatus = isCorrect ? 'accepted' : (firstFail?.status || 'wrong_answer');
        const sanitizedRunResults = sanitizeTestResultsForStudent(testResults);

        const submission = new Submission({
            questionId,
            classId,
            studentId: user._id,
            answer,
            language,
            isCorrect,
            score: 0, // No score for run
            output: JSON.stringify(sanitizedRunResults),
            isRun: true,
            passedTestCases: passedCount,
            totalTestCases: testResults.length,
            status: runStatus,
            testResults: sanitizedRunResults,
        });
        await submission.save();
        console.log('[Run Question] Saved run:', submission._id, passedCount, '/', testResults.length, 'passed');

        await Class.updateOne({ _id: classId }, { $inc: { totalRuns: 1 } });
        await Leaderboard.recordRun({ classId, studentId: user._id });

        req.io?.to(`class:${classId}`).emit('analyticsUpdated', { classId });
        req.io?.to(`class:${classId}`).emit('codeRun', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            isCorrect,
            passedTestCases: passedCount,
            totalTestCases: testResults.length
        });

        const submissionJson = submission.toObject();
        delete submissionJson.testResults;
        res.status(200).json({
            message: 'Code run successfully',
            submission: submissionJson,
            testResults: sanitizedRunResults,
            passedTestCases: passedCount,
            totalTestCases: testResults.length,
            publicTestCases: testResults.filter((t) => t.isPublic).length,
            hiddenTestCases: testResults.filter((t) => !t.isPublic).length,
            isCorrect,
            explanation: question.explanation
        });
    } catch (err) {
        return sendError(res, err, 'Error running code', 'Run Question');
    }
};

exports.runWithCustomInput = async (req, res) => {
    try {
        const { questionId } = req.params;
        const { answer, classId, language, customInput, expectedOutput } = req.body;
        const user = req.user;

        console.log('[Run With Custom Input] User:', user._id, '| Question:', questionId, '| Class:', classId, '| Language:', language);

        if (!isStudent(user)) {
            return res.status(403).json({ error: 'Only students can run code with custom input' });
        }

        const { question } = await loadStudentRunContext(user, questionId, classId, { label: 'running code' });

        if (!CODING_TYPES.includes(question.type)) {
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be run' });
        }

        if (!language || !question.languages.includes(language)) {
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }
        if (typeof answer !== 'string' || !answer.trim()) {
            return res.status(400).json({ error: 'Code is required' });
        }

        if (!customInput || typeof customInput !== 'string' || !customInput.trim()) {
            return res.status(400).json({ error: 'Valid custom input is required' });
        }

        if (expectedOutput && typeof expectedOutput !== 'string') {
            return res.status(400).json({ error: 'Expected output must be a string' });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            codeToExecute = resolveFillInTheBlanksCodingCode(question, answer, language);
            if (!codeToExecute) {
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
            }
        }

        const customTestCase = [{
            input: customInput,
            expectedOutput: expectedOutput || '',
            isPublic: true
        }];

        let testResults;
        try {
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                customTestCase,
                question.timeLimit,
                question.memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
        } catch (err) {
            return sendError(res, err, 'Code execution failed', 'Run With Custom Input');
        }

        const customResult = testResults[0];
        const submission = new Submission({
            questionId,
            classId,
            studentId: user._id,
            answer,
            language,
            isCorrect: Boolean(customResult?.passed) && expectedOutput !== undefined,
            score: 0, // No score for custom input run
            output: JSON.stringify(testResults),
            isRun: true,
            isCustomInput: true,
            passedTestCases: customResult?.passed ? 1 : 0,
            totalTestCases: 1,
            testResults,
        });
        await submission.save();
        console.log('[Run With Custom Input] Saved custom run:', submission._id);

        await Class.updateOne({ _id: classId }, { $inc: { totalRuns: 1 } });
        await Leaderboard.recordRun({ classId, studentId: user._id });

        req.io?.to(`class:${classId}`).emit('customInputRun', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            customInput,
            expectedOutput
        });

        const submissionJson = submission.toObject();
        delete submissionJson.testResults;
        res.status(200).json({
            message: 'Code run with custom input successfully',
            submission: submissionJson,
            testResults: customResult,
            actualOutput: customResult?.output,
            timeMs: customResult?.timeMs ?? null,
            memoryKb: customResult?.memoryKb ?? null,
            explanation: question.explanation
        });
    } catch (err) {
        return sendError(res, err, 'Error running code with custom input', 'Run With Custom Input');
    }
};

/** Validation shared by create + edit. Returns an error message or null. */
const validateQuestionPayload = (questionData) => {
    if (!questionData || !questionData.type || !questionData.title) return 'Question type and title required';
    if (!QUESTION_TYPES.includes(questionData.type)) return 'Invalid question type';
    if (CODING_TYPES.includes(questionData.type)) {
        if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) return 'At least one language required';
        if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) return 'Invalid language specified';
        if (!Array.isArray(questionData.templateCode) || questionData.templateCode.length === 0) return 'Template code required';
        if (!questionData.templateCode.every(tc => tc && tc.language && tc.code && questionData.languages.includes(tc.language))) return 'Invalid template code structure';
        if (!Array.isArray(questionData.testCases) || questionData.testCases.length === 0) return 'At least one test case required';
        if (questionData.timeLimit != null && !(Number(questionData.timeLimit) > 0)) return 'Time limit must be positive';
        if (questionData.memoryLimit != null && !(Number(questionData.memoryLimit) > 0)) return 'Memory limit must be positive';
        if (questionData.type === 'codingWithDriver' && Array.isArray(questionData.driverCode) && questionData.driverCode.length) {
            const hasPlaceholder = questionData.driverCode.every(dc =>
                dc && dc.code && (dc.code.includes('{{USER_CODE}}') || dc.code.includes('// USER_CODE_HERE') || dc.code.includes('# USER_CODE_HERE'))
            );
            if (!hasPlaceholder) console.warn('[Question] Driver code should contain {{USER_CODE}} or // USER_CODE_HERE or # USER_CODE_HERE');
        }
    }
    return null;
};

exports.assignQuestion = async (req, res) => {
    try {
        const { classIds } = req.body;
        const questionData = pickEditableQuestionFields(req.body);
        const user = req.user;

        console.log('[Question Assignment] User:', user._id, '| Role:', user.role, '| Class IDs:', classIds);

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can assign questions' });
        }
        if (!ensureTeacherCanCreateQuestion(user, '[Question Assignment]', res)) {
            return;
        }

        const validationError = validateQuestionPayload(questionData);
        if (validationError) return res.status(400).json({ error: validationError });
        if (CODING_TYPES.includes(questionData.type) && questionData.type === 'codingWithDriver'
            && (!Array.isArray(questionData.driverCode) || questionData.driverCode.length === 0)) {
            return res.status(400).json({ error: 'Driver code required for LeetCode-style questions' });
        }

        let classes = [];
        if (classIds && Array.isArray(classIds) && classIds.length > 0) {
            if (!classIds.every((id) => mongoose.Types.ObjectId.isValid(String(id)))) {
                return res.status(400).json({ error: 'Invalid classId in classIds' });
            }
            classes = await Class.find({ _id: { $in: classIds } });
            if (classes.length !== new Set(classIds.map(String)).size) {
                return res.status(404).json({ error: 'One or more classes not found' });
            }
            // Teachers may only attach questions to classes they manage.
            for (const cls of classes) {
                if (!classManagedBy(cls, user)) {
                    return res.status(403).json({ error: 'You are not assigned to one or more of these classes' });
                }
            }
        }

        normalizeQuestionRichTextFields(questionData);

        const question = new Question({
            ...questionData,
            createdBy: user._id,
            points: parseOptionalPoints(questionData.points),
            classes: classes.map(c => ({ classId: c._id, isPublished: false, isDisabled: false })),
        });
        applyDefaultSolutions(question);
        await question.save();
        console.log('[Question Assignment] Saved:', question._id);

        if (classes.length) {
            await Class.updateMany(
                { _id: { $in: classes.map((c) => c._id) } },
                { $addToSet: { questions: question._id } }
            );
        }

        res.status(201).json({ message: 'Question created and assigned', question });
    } catch (err) {
        return sendError(res, err, 'Error assigning question', 'Question Assignment');
    }
};

exports.editQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const questionData = pickEditableQuestionFields(req.body);
        const user = req.user;

        console.log('[Edit Question] User:', user._id, '| Question:', questionId);

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can edit' });
        }
        if (!ensureTeacherCanCreateQuestion(user, '[Edit Question]', res)) {
            return;
        }

        const question = await assertQuestionManager(user, questionId);

        const validationError = validateQuestionPayload(questionData);
        if (validationError) return res.status(400).json({ error: validationError });

        normalizeQuestionRichTextFields(questionData);
        if (req.body.points !== undefined) {
            questionData.points = parseOptionalPoints(req.body.points);
            if (questionData.points === undefined) {
                return res.status(400).json({ error: 'Points must be a non-negative number when provided' });
            }
        }

        // Only whitelisted fields; createdBy / classes / status / isDraft / examId / isExamOnly are never body-settable.
        Object.assign(question, questionData, { updatedAt: new Date() });
        applyDefaultSolutions(question);
        await question.save();

        // Students are in these rooms too: broadcast only the student-safe view.
        for (const classEntry of question.classes) {
            req.io?.to(`class:${classEntry.classId}`).emit('questionUpdated', {
                questionId: question._id,
                updatedFields: studentQuestionView(question, classEntry.classId),
            });
        }

        console.log('[Edit Question] Question updated:', question._id);
        res.status(200).json({ message: 'Question updated', question });
    } catch (err) {
        return sendError(res, err, 'Error editing question', 'Edit Question');
    }
};

exports.updateQuestionLimits = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;
        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can update limits' });
        }

        const timeLimit = parseOptionalJudgeLimit(req.body.timeLimit, 0.1, 5, { integer: false });
        const memoryLimit = parseOptionalJudgeLimit(req.body.memoryLimit, 16, 1024, { integer: true });
        if (timeLimit == null || memoryLimit == null) {
            return res.status(400).json({ error: 'Time limit must be 0.1–5 seconds and memory limit must be 16–1024 MB' });
        }

        const question = await assertQuestionManager(user, questionId);
        if (!CODING_TYPES.includes(question.type)) {
            return res.status(400).json({ error: 'Limits can only be set on coding questions' });
        }

        question.timeLimit = timeLimit;
        question.memoryLimit = memoryLimit;
        await question.save();
        res.status(200).json({ message: 'Limits updated', timeLimit, memoryLimit });
    } catch (err) {
        return sendError(res, err, 'Error updating limits', 'Update Question Limits');
    }
};

exports.deleteQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Delete Question] User:', user._id, '| Question:', questionId);

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can delete' });
        }

        const question = await assertQuestionManager(user, questionId);

        const lockedByExam = await Exam.exists({
            'questions.questionId': question._id,
            status: { $in: ['scheduled', 'completed'] },
        });
        if (lockedByExam) {
            return res.status(409).json({ error: 'Question is part of a scheduled or completed exam and cannot be deleted' });
        }

        const classIds = question.classes.map(c => c.classId);
        await Class.updateMany(
            { _id: { $in: classIds } },
            { $pull: { questions: question._id, assignments: { questionId: question._id } } }
        );

        await Submission.deleteMany({ questionId });
        await Leaderboard.removeQuestion({ classIds, questionId: question._id });

        await question.deleteOne();
        console.log('[Delete Question] Deleted:', questionId);

        for (const classEntry of question.classes) {
            req.io?.to(`class:${classEntry.classId}`).emit('questionDeleted', { questionId });
        }

        res.status(200).json({ message: 'Question deleted successfully' });
    } catch (err) {
        return sendError(res, err, 'Error deleting question', 'Delete Question');
    }
};

exports.viewSolution = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can view solution' });
        }

        const full = await assertQuestionManager(user, questionId,
            'createdBy classes type languages options solution solutionCode solutionLanguage solutionCodes correctAnswer correctOption correctOptions');
        const q = full.toObject();
        const solution = {
            _id: q._id,
            type: q.type,
            languages: q.languages,
            options: q.options,
            solution: q.solution,
            solutionCode: q.solutionCode,
            solutionLanguage: q.solutionLanguage,
            solutionCodes: q.solutionCodes,
            correctAnswer: q.correctAnswer,
            correctOption: q.correctOption,
            correctOptions: q.correctOptions,
        };

        res.status(200).json({ solution });
    } catch (err) {
        return sendError(res, err, 'Error fetching solution', 'View Solution');
    }
};

exports.viewTestCases = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can view test cases' });
        }

        const question = await assertQuestionManager(user, questionId, 'createdBy classes testCases');
        res.status(200).json({ testCases: question.testCases });
    } catch (err) {
        return sendError(res, err, 'Error fetching test cases', 'View Test Cases');
    }
};

exports.viewStatement = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can view statement' });
        }

        const question = await assertQuestionManager(user, questionId);
        res.status(200).json({
            type: question.type,
            title: question.title,
            description: question.description,
            constraints: question.constraints,
            inputFormat: question.inputFormat,
            outputFormat: question.outputFormat,
            sampleIo: question.sampleIo,
            examples: question.examples,
            codeSnippet: question.codeSnippet,
            starterCode: question.starterCode,
        });
    } catch (err) {
        return sendError(res, err, 'Error fetching statement', 'View Statement');
    }
};

/**
 * Shared implementation for publish / unpublish / disable / enable.
 * Caller must manage the target class (admins always).
 */
const setClassEntryFlag = async (req, res, { tag, field, value, event, successMessage, fallback }) => {
    try {
        const { questionId } = req.params;
        let { classId } = req.body;
        const user = req.user;

        console.log(`[${tag}] User:`, user._id, '| Question:', questionId, '| Class:', classId);

        if (!isStaff(user)) {
            return res.status(403).json({ error: `Only admin or teacher can ${tag.split(' ')[0].toLowerCase()}` });
        }

        classId = typeof classId === 'object' && classId?.classId ? classId.classId : classId;
        if (!classId || typeof classId !== 'string') {
            return res.status(400).json({ error: 'Invalid classId' });
        }
        if (!mongoose.Types.ObjectId.isValid(classId)) {
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        await assertClassManager(user, classId, '_id teachers createdBy');

        const question = await Question.findById(questionId);
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            return res.status(400).json({ error: 'Question not associated with class' });
        }

        classEntry[field] = value;
        const payload = { questionId, classId, [field]: value };
        if (field === 'isPublished' && value) {
            classEntry.publishedAt = new Date();
            payload.publishedAt = classEntry.publishedAt;
        }
        await question.save();

        req.io?.to(`class:${classId}`).emit(event, payload);

        res.status(200).json({ message: successMessage, question });
    } catch (err) {
        return sendError(res, err, fallback, tag);
    }
};

exports.publishQuestion = (req, res) => setClassEntryFlag(req, res, {
    tag: 'Publish Question', field: 'isPublished', value: true, event: 'questionPublished',
    successMessage: 'Question published successfully', fallback: 'Error publishing question',
});

exports.unpublishQuestion = (req, res) => setClassEntryFlag(req, res, {
    tag: 'Unpublish Question', field: 'isPublished', value: false, event: 'questionPublished',
    successMessage: 'Question unpublished successfully', fallback: 'Error unpublishing question',
});

exports.disableQuestion = (req, res) => setClassEntryFlag(req, res, {
    tag: 'Disable Question', field: 'isDisabled', value: true, event: 'questionDisabled',
    successMessage: 'Question disabled successfully', fallback: 'Error disabling question',
});

exports.enableQuestion = (req, res) => setClassEntryFlag(req, res, {
    tag: 'Enable Question', field: 'isDisabled', value: false, event: 'questionDisabled',
    successMessage: 'Question enabled successfully', fallback: 'Error enabling question',
});

exports.getLeaderboard = async (req, res) => {
    try {
        const { classId } = req.params;
        const user = req.user;

        console.log('[Get Leaderboard] User:', user._id, '| Class:', classId);

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            return res.status(400).json({ error: 'Invalid class ID' });
        }

        // Managers, or enrolled students only.
        await assertClassMember(user, classId, 'students teachers createdBy');
        const studentView = isStudent(user);

        // Bounded per-question rows only; never pull a legacy (pre-migration) `attempts` history off disk.
        const rows = await Leaderboard.find({ classId })
            .select(Leaderboard.SAFE_PROJECTION)
            .populate('studentId', studentView ? 'name profilePicture' : 'name email isBlocked profilePicture')
            .lean();

        // Rank by first-solved: more unique correct solves first, then earlier finish time
        const ranked = rows.map((entry) => {
            const questionRows = Leaderboard.questionRows(entry);
            const firstSolveTimes = questionRows
                .filter((r) => r.isCorrect && r.questionId)
                .map((r) => {
                    const at = r.firstSolvedAt || r.bestSubmittedAt || r.lastSubmittedAt;
                    return at ? new Date(at).getTime() : Infinity;
                })
                .filter((t) => Number.isFinite(t));
            const problemsSolved = firstSolveTimes.length;
            // Time when the student completed their last first-solve (earlier = better for same solve count)
            const firstSolvedAt = problemsSolved > 0 ? Math.max(...firstSolveTimes) : Infinity;

            const isBlockedForClass = entry.studentId?.isBlocked
                ? (entry.studentId.isBlocked[classId] || false)
                : false;

            return {
                ...entry,
                questions: questionRows,
                highestScores: Leaderboard.highestScoresFrom(questionRows),
                isBlocked: isBlockedForClass,
                problemsSolved,
                firstSolvedAt: Number.isFinite(firstSolvedAt) ? new Date(firstSolvedAt) : null,
                firstSolvedAtMs: firstSolvedAt,
            };
        });

        ranked.sort((a, b) => {
            if (b.problemsSolved !== a.problemsSolved) return b.problemsSolved - a.problemsSolved;
            if (a.firstSolvedAtMs !== b.firstSolvedAtMs) return a.firstSolvedAtMs - b.firstSolvedAtMs;
            return (b.totalScore || 0) - (a.totalScore || 0);
        });

        // `attempts` (old per-submit history) is now the last N practice submits from the Submission collection:
        // for every top-10 row for staff, and only for the student's own row for students.
        const top = ranked.slice(0, 10);
        const attemptsFor = new Map(
            await Promise.all(
                top
                    .filter((entry) => entry.studentId && (!studentView || idStr(entry.studentId) === String(user._id)))
                    .map(async (entry) => [idStr(entry.studentId), await recentLeaderboardAttempts(classId, entry.studentId, entry.questions)])
            )
        );

        const leaderboard = top.map((entry, index) => {
            const { firstSolvedAtMs, ...rest } = entry;
            const row = { ...rest, attempts: attemptsFor.get(idStr(entry.studentId)) || [], rank: index + 1 };
            if (!studentView) return row;

            // Students: classmates' rows carry only public ranking data (no email, block state, or attempts).
            const isSelf = idStr(entry.studentId) === String(user._id);
            const publicRow = {
                _id: row._id,
                classId: row.classId,
                studentId: row.studentId
                    ? { _id: row.studentId._id, name: row.studentId.name, profilePicture: row.studentId.profilePicture }
                    : row.studentId,
                name: row.studentId?.name,
                totalScore: row.totalScore || 0,
                correctAttempts: row.correctAttempts || 0,
                wrongAttempts: row.wrongAttempts || 0,
                totalSubmits: row.totalSubmits || 0,
                problemsSolved: row.problemsSolved,
                firstSolvedAt: row.firstSolvedAt,
                rank: row.rank,
            };
            if (isSelf) {
                publicRow.attempts = row.attempts;
                publicRow.highestScores = row.highestScores;
                publicRow.totalRuns = row.totalRuns || 0;
                publicRow.isBlocked = row.isBlocked;
            }
            return publicRow;
        });

        res.status(200).json({ leaderboard });
    } catch (err) {
        return sendError(res, err, 'Error fetching leaderboard', 'Get Leaderboard');
    }
};

exports.getQuestionsByClass = async (req, res) => {
    try {
        const { classId } = req.params;
        const user = req.user;

        console.log('[Get Questions By Class] User:', user._id, '| Class:', classId);

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            return res.status(400).json({ error: 'Invalid class ID' });
        }

        // Do not populate `questions` — populate/$in can reorder docs by _id or title.
        // Insertion order lives on the raw Class.questions ObjectId array.
        // Managers or enrolled students only (throws 403/404).
        const classData = await assertClassMember(user, classId, 'students teachers createdBy questions assignments');
        const studentView = isStudent(user);

        // Collect every question id tied to this class: Class.questions, Class.assignments, and Question.classes.
        // Assignments often list all "assigned" work while class.questions can be shorter or stale.
        // Preserve insertion order from Class.questions (then assignments, then any extra links).
        const classOid = new mongoose.Types.ObjectId(classId);
        const orderedIds = [];
        const seenIds = new Set();
        const pushOrderedId = (raw) => {
            const id = raw && raw._id ? raw._id : raw;
            const key = id ? String(id) : '';
            if (!key || seenIds.has(key)) return;
            seenIds.add(key);
            orderedIds.push(key);
        };

        for (const q of classData.questions || []) {
            pushOrderedId(q);
        }
        for (const a of classData.assignments || []) {
            pushOrderedId(a.questionId);
        }

        const linkedByClassField = await Question.find({ 'classes.classId': classOid }).select('_id').lean();
        for (const q of linkedByClassField) {
            pushOrderedId(q._id);
        }

        const objectIds = orderedIds
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        let questions = objectIds.length
            ? await Question.find({ _id: { $in: objectIds } })
            : [];

        const getClassEntry = (q) =>
            q.classes?.find((c) => String(c.classId?._id || c.classId) === String(classId));

        questions = questions.filter((q) => {
            if (!studentView) return true;
            // Students see all published, non-exam-only questions; disabled only blocks submit/run (enforced elsewhere).
            if (q.isExamOnly) return false;
            const classEntry = getClassEntry(q);
            return Boolean(classEntry && classEntry.isPublished);
        });

        const orderIndex = new Map(orderedIds.map((id, idx) => [id, idx]));
        questions.sort((a, b) => {
            const ai = orderIndex.get(String(a._id));
            const bi = orderIndex.get(String(b._id));
            return (ai ?? Number.MAX_SAFE_INTEGER) - (bi ?? Number.MAX_SAFE_INTEGER);
        });

        // For students: strip secrets and attach attempt status (attempted / wrong / not_viewed)
        let responseQuestions = questions;
        if (studentView) {
            const statusByQuestion = await studentAttemptStatusMap(classId, user._id);
            responseQuestions = questions.map((q) =>
                studentQuestionView(q, classId, { studentAttemptStatus: statusByQuestion[String(q._id)] || 'not_viewed' })
            );
        }

        console.log('[Get Questions By Class] Questions fetched:', responseQuestions.length);
        res.status(200).json({ questions: responseQuestions });
    } catch (err) {
        return sendError(res, err, 'Error fetching questions', 'Get Questions By Class');
    }
};

exports.getQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Get Question] User:', user._id, '| Question:', questionId);

        if (!mongoose.Types.ObjectId.isValid(questionId)) {
            return res.status(400).json({ error: 'Invalid question ID' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }

        if (isStudent(user)) {
            // Students only see a question through a class they are enrolled in where it is published.
            let classId = req.query.classId ? String(req.query.classId) : '';
            if (!classId) {
                // Frontend sometimes opens a question before it knows the class: resolve the first
                // enrolled class where this question is published, otherwise require classId.
                const enrolled = new Set((await enrolledClassIds(user)).map(String));
                const entry = (question.classes || []).find((c) => c.isPublished && enrolled.has(idStr(c.classId)));
                if (!entry) return res.status(400).json({ error: 'classId is required' });
                classId = idStr(entry.classId);
            }
            if (!mongoose.Types.ObjectId.isValid(classId)) {
                return res.status(400).json({ error: 'Invalid classId' });
            }
            await assertStudentCanViewQuestion(user, question, classId);
            const statusByQuestion = await studentAttemptStatusMap(classId, user._id);
            const view = studentQuestionView(question, classId, {
                studentAttemptStatus: statusByQuestion[String(question._id)] || 'not_viewed',
            });
            return res.status(200).json({ question: view });
        }

        if (!isAdmin(user)) {
            if (!(await canManageQuestion(user, question))) {
                return res.status(403).json({ error: 'You do not manage this question' });
            }
        }

        res.status(200).json({ question });
    } catch (err) {
        return sendError(res, err, 'Error fetching question', 'Get Question');
    }
};

exports.getAllQuestions = async (req, res) => {
    try {
        const user = req.user;

        console.log('[Get All Questions] User:', user._id, 'Role:', user.role);

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can view questions' });
        }

        // Admin: every question. Teacher: own questions + questions attached to classes they manage.
        let query = {};
        if (!isAdmin(user)) {
            const teacherClassIds = await managedClassIds(user);
            query = {
                $or: [
                    { createdBy: user._id },
                    { 'classes.classId': { $in: teacherClassIds } }
                ]
            };
        }

        const rows = await Question.find(query)
            .select(LIST_HIDDEN_SELECT)
            .populate('createdBy', 'name email _id')
            .lean();

        const questions = rows.map(withTestCaseCount);
        console.log('[Get All Questions] Questions fetched:', questions.length);
        res.status(200).json({ questions });
    } catch (err) {
        return sendError(res, err, 'Error fetching questions', 'Get All Questions');
    }
};

exports.assignQuestionToClass = async (req, res) => {
    try {
        const { questionId } = req.params;
        const classId = req.body.classId;
        const user = req.user;

        console.log('[Assign Question To Class] User:', user._id, '| Question:', questionId, '| Class:', classId);

        if (!classId || typeof classId !== 'string' || !mongoose.Types.ObjectId.isValid(classId)) {
            return res.status(400).json({ error: 'Invalid classId provided' });
        }

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can assign questions' });
        }

        // Must manage the target class.
        const classData = await assertClassManager(user, classId);

        const question = await Question.findById(questionId);
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }
        if (question.isExamOnly) {
            return res.status(400).json({ error: 'Exam-only questions cannot be assigned to a class' });
        }
        // Drafts are private to their owner until published to the bank.
        if ((question.isDraft || question.status === 'draft') && !(await canManageQuestion(user, question))) {
            return res.status(403).json({ error: 'You do not manage this draft question' });
        }

        if (question.classes.some(c => c.classId.toString() === classId)) {
            return res.status(400).json({ error: 'Question already assigned to class' });
        }

        question.classes.push({ classId, isPublished: false, isDisabled: false });
        await question.save();

        await Class.updateOne({ _id: classData._id }, { $addToSet: { questions: question._id } });

        req.io?.to(`class:${classId}`).emit('questionAssigned', { questionId, classId });

        console.log('[Assign Question To Class] Question assigned:', questionId, 'to class:', classId);
        res.status(200).json({ message: 'Question assigned to class successfully', question });
    } catch (err) {
        return sendError(res, err, 'Error assigning question to class', 'Assign Question To Class');
    }
};

exports.searchQuestions = async (req, res) => {
    try {
        const { title, type, classId } = req.query;
        const user = req.user;

        console.log('[Search Questions] User:', user._id, '| Query:', { title, type, classId });

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can search questions' });
        }

        const query = {};
        if (title) {
            const needle = String(title).slice(0, 200);
            query.title = { $regex: escapeRegex(needle), $options: 'i' };
        }
        if (type && QUESTION_TYPES.includes(type)) {
            query.type = type;
        }
        if (classId && mongoose.Types.ObjectId.isValid(String(classId))) {
            if (!isAdmin(user)) await assertClassManager(user, classId, '_id teachers createdBy');
            query['classes.classId'] = classId;
        }

        // Teachers only see their own questions or those attached to classes they manage.
        if (!isAdmin(user)) {
            const teacherClassIds = await managedClassIds(user);
            query.$or = [
                { createdBy: user._id },
                { 'classes.classId': { $in: teacherClassIds } },
            ];
        }

        const rows = await Question.find(query).select(LIST_HIDDEN_SELECT).limit(100).lean();
        const questions = rows.map(withTestCaseCount);
        console.log('[Search Questions] Found:', questions.length, 'questions');
        res.status(200).json({ questions });
    } catch (err) {
        return sendError(res, err, 'Error searching questions', 'Search Questions');
    }
};

/** Full (staff) test result rows: stable numbering plus input/expected for every case. */
const staffTestResultRows = (rawResults = []) =>
    rawResults.map((r, index) => ({
        testCaseNumber: r.testCaseNumber ?? index + 1,
        passed: !!r.passed,
        isPublic: r.isPublic !== false,
        status: r.status,
        isTLE: !!r.isTLE,
        isMLE: !!r.isMLE,
        timeMs: r.timeMs ?? null,
        memoryKb: r.memoryKb ?? null,
        input: r.input,
        output: r.output,
        expected: r.expected,
        error: r.error || null,
    }));

exports.viewSubmissionCode = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const user = req.user;

        console.log('[View Submission Code] User:', user._id, '| Submission:', submissionId);

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can view submission code' });
        }
        if (!mongoose.Types.ObjectId.isValid(submissionId)) {
            return res.status(400).json({ error: 'Invalid submission ID' });
        }

        const submission = await Submission.findById(submissionId)
            .select('+testResults')
            .populate('questionId', 'title type testCases codeSnippet driverCode languages timeLimit memoryLimit starterCode templateCode')
            .populate('studentId', 'name email');
        if (!submission) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        // Must manage the class the submission was made in.
        await assertClassManager(user, submission.classId, '_id teachers createdBy');

        const qId = submission.questionId?._id || submission.questionId;
        const question = submission.questionId?._id ? submission.questionId : await Question.findById(qId);
        const isCorrect = Boolean(submission.isCorrect);
        const language = submission.language || 'javascript';
        const payload = {
            questionId: qId,
            classId: submission.classId,
            code: submission.answer,
            language,
            questionTitle: question?.title || 'Question',
            studentName: submission.studentId?.name || 'Student',
            studentEmail: submission.studentId?.email || '',
            isCorrect,
            score: submission.score,
            submittedAt: submission.submittedAt,
            status: submission.status || (isCorrect ? 'accepted' : 'wrong_answer'),
            passedTestCases: submission.passedTestCases ?? 0,
            totalTestCases: submission.totalTestCases ?? 0,
            output: submission.output,
            testResults: null,
            needsRejudge: false,
        };

        const stored = submission.testResults;
        if (Array.isArray(stored) && stored.length) {
            payload.testResults = staffTestResultRows(stored);
            return res.status(200).json(payload);
        }

        const canRejudge =
            question &&
            CODING_TYPES.includes(question.type) &&
            typeof submission.answer === 'string' &&
            submission.answer.trim() &&
            question.testCases?.length;

        if (!canRejudge) {
            return res.status(200).json(payload);
        }

        if (req.query.rejudge !== '1') {
            payload.needsRejudge = true;
            return res.status(200).json(payload);
        }

        // Explicit re-judge: run the full suite once and persist so later views are free.
        let codeToExecute = submission.answer;
        if (question.type === 'fillInTheBlanksCoding') {
            codeToExecute = resolveFillInTheBlanksCodingCode(question, submission.answer, language);
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode?.find((d) => d.language === language);
            if (driverCodeObj?.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, submission.answer, { language });
            }
        }
        let rawResults;
        try {
            rawResults = await executeDockerCode(
                language,
                codeToExecute,
                question.testCases,
                question.timeLimit || 2,
                question.memoryLimit || 256,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
        } catch (rerunErr) {
            if (isHttpError(rerunErr)) return sendError(res, rerunErr, 'Judge unavailable', 'View Submission Code');
            console.warn('[View Submission Code] Re-judge failed:', rerunErr.message);
            payload.needsRejudge = true;
            return res.status(200).json(payload);
        }

        await Submission.updateOne({ _id: submission._id }, { $set: { testResults: rawResults } });
        payload.testResults = staffTestResultRows(rawResults);
        res.status(200).json(payload);
    } catch (err) {
        return sendError(res, err, 'Error fetching submission code', 'View Submission Code');
    }
};

exports.markSubmissionCorrect = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const user = req.user;

        console.log('[Mark Submission Correct] User:', user._id, '| Submission:', submissionId);

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can mark submissions correct' });
        }
        if (!mongoose.Types.ObjectId.isValid(submissionId)) {
            return res.status(400).json({ error: 'Invalid submission ID' });
        }

        const submission = await Submission.findById(submissionId).populate('questionId', 'points testCases');
        if (!submission) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        // Must manage the class the submission was made in.
        await assertClassManager(user, submission.classId, '_id teachers createdBy');

        if (submission.isRun) {
            return res.status(400).json({ error: 'Test runs cannot be marked as correct' });
        }

        if (submission.isCorrect) {
            return res.status(200).json({
                message: 'Submission is already marked correct',
                submission: {
                    _id: submission._id,
                    isCorrect: true,
                    score: submission.score,
                    status: submission.status,
                },
            });
        }

        const question = submission.questionId;
        const totalTestCases =
            submission.totalTestCases ||
            (question?.testCases?.length ?? 0);

        const newScore = resolvePoints(question?.points) || submission.score || 0;
        const set = { isCorrect: true, score: newScore, status: 'accepted' };
        if (totalTestCases > 0) {
            set.passedTestCases = totalTestCases;
            set.totalTestCases = totalTestCases;
        }
        // Atomic claim: only the request that flips isCorrect false → true updates the leaderboard,
        // so two simultaneous "mark correct" clicks can never count the same submission twice.
        const claimed = await Submission.updateOne(
            { _id: submission._id, isRun: { $ne: true }, isCorrect: { $ne: true } },
            { $set: set }
        );
        if (claimed.modifiedCount === 0) {
            return res.status(200).json({
                message: 'Submission is already marked correct',
                submission: { _id: submission._id, isCorrect: true, score: newScore, status: 'accepted' },
            });
        }
        Object.assign(submission, set);

        // Single atomic update: question row solved / bestScore / firstSolvedAt, one wrong → correct, totalScore.
        if (question?._id) await Leaderboard.markSubmissionCorrect({
            classId: submission.classId,
            studentId: submission.studentId,
            questionId: question._id,
            submissionId: submission._id,
            score: submission.score,
            submittedAt: submission.submittedAt,
            totalTestCases,
        });

        req.io?.to(`class:${submission.classId}`).emit('analyticsUpdated', {
            classId: submission.classId,
        });

        res.status(200).json({
            message: 'Submission marked as correct',
            submission: {
                _id: submission._id,
                isCorrect: submission.isCorrect,
                score: submission.score,
                status: submission.status,
                passedTestCases: submission.passedTestCases,
                totalTestCases: submission.totalTestCases,
            },
        });
    } catch (err) {
        return sendError(res, err, 'Error marking submission as correct', 'Mark Submission Correct');
    }
};

const SHEET_COLUMNS = [
    'Name', 'Email', 'QusID', 'QusTitle', 'QusNo', 'QusType', 'Score', 'Language',
    'Runs', 'Submits', 'Status', 'PublishDate', 'PublishTime', 'SubmitTime', 'Delta',
];

const SHEET_LANGUAGE_LABELS = {
    javascript: 'JavaScript',
    java: 'Java',
    cpp: 'CPP',
    c: 'C',
    python: 'Python',
    php: 'PHP',
    ruby: 'Ruby',
    go: 'Go',
};

function sheetPlainText(value) {
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function sheetQuestionType(type) {
    if (type === 'singleCorrectMcq') return 'MCQ';
    if (type === 'multipleCorrectMcq') return 'MSQ';
    if (type === 'coding' || type === 'codingWithDriver' || type === 'fillInTheBlanksCoding') return 'Coding';
    if (type === 'fillInTheBlanks') return 'Fill in the blanks';
    return type || '';
}

function sheetLanguage(language) {
    if (!language) return '';
    return SHEET_LANGUAGE_LABELS[String(language).toLowerCase()] || language;
}

function sheetDateParts(value) {
    if (!value) return { date: '', time: '' };
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { date: '', time: '' };
    const dateText = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).format(date);
    const timeText = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
    return { date: dateText, time: timeText };
}

function sheetPoints(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

exports.getClassSheetReport = async (req, res) => {
    try {
        const { classId } = req.params;
        const user = req.user;
        const scope = req.query.scope === 'assignment' ? 'assignment' : 'class';
        const onlyQuestionId = req.query.questionId ? String(req.query.questionId) : '';

        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only admin or teacher can download this report' });
        }
        if (!mongoose.Types.ObjectId.isValid(classId)) {
            return res.status(400).json({ error: 'Invalid class ID' });
        }

        // Must manage the class (student names/emails are in this report).
        await assertClassManager(user, classId, '_id teachers createdBy');

        const classData = await Class.findById(classId)
            .populate('students', 'name email')
            .populate('questions', 'title type points classes')
            .populate('assignments.questionId', 'title type points classes');
        if (!classData) {
            return res.status(404).json({ error: 'Class not found' });
        }

        const items = [];
        if (scope === 'assignment') {
            (classData.assignments || []).forEach((assignment, index) => {
                const question = assignment.questionId;
                if (!question || !question._id) return;
                if (onlyQuestionId && String(question._id) !== onlyQuestionId) return;
                const points = assignment.maxPoints != null && assignment.maxPoints !== ''
                    ? sheetPoints(assignment.maxPoints)
                    : sheetPoints(question.points);
                items.push({
                    question,
                    qusNo: index + 1,
                    points,
                    publishedAt: assignment.assignedAt || null,
                });
            });
        } else {
            (classData.questions || []).forEach((question, index) => {
                if (!question || !question._id) return;
                if (onlyQuestionId && String(question._id) !== onlyQuestionId) return;
                const classEntry = (question.classes || []).find((entry) => String(entry.classId) === String(classId));
                items.push({
                    question,
                    qusNo: index + 1,
                    points: sheetPoints(question.points),
                    publishedAt: classEntry?.publishedAt || null,
                });
            });
        }

        const questionIds = items.map((item) => item.question._id);
        const submissions = questionIds.length
            ? await Submission.find({
                classId,
                questionId: { $in: questionIds },
                $or: [{ examAttemptId: null }, { examAttemptId: { $exists: false } }],
            }).select('questionId studentId isRun isCorrect language submittedAt').lean()
            : [];

        const activity = new Map();
        for (const sub of submissions) {
            const key = `${sub.studentId}:${sub.questionId}`;
            if (!activity.has(key)) activity.set(key, { runs: 0, submits: [] });
            const bucket = activity.get(key);
            if (sub.isRun) bucket.runs += 1;
            else bucket.submits.push(sub);
        }
        for (const bucket of activity.values()) {
            bucket.submits.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
        }

        const students = [...(classData.students || [])].sort((a, b) =>
            String(a.name || '').localeCompare(String(b.name || ''))
        );

        const rows = [];
        for (const student of students) {
            for (const item of items) {
                const bucket = activity.get(`${student._id}:${item.question._id}`) || { runs: 0, submits: [] };
                const lastSubmit = bucket.submits[0];
                const published = sheetDateParts(item.publishedAt);
                const base = [
                    student.name || '',
                    student.email || '',
                    String(item.question._id),
                    sheetPlainText(item.question.title),
                    item.qusNo,
                    sheetQuestionType(item.question.type),
                ];
                if (!lastSubmit) {
                    rows.push([
                        ...base,
                        'Not Submitted',
                        'Not Submitted',
                        'Not Submitted',
                        'Not Submitted',
                        'Not Submitted',
                        published.date,
                        published.time,
                        'Not Submitted',
                        'Not Submitted',
                    ]);
                    continue;
                }
                const submitted = sheetDateParts(lastSubmit.submittedAt);
                const correct = Boolean(lastSubmit.isCorrect);
                let delta = '';
                if (item.publishedAt && lastSubmit.submittedAt) {
                    delta = Math.round((new Date(lastSubmit.submittedAt) - new Date(item.publishedAt)) / 1000);
                }
                rows.push([
                    ...base,
                    correct ? item.points : 0,
                    sheetLanguage(lastSubmit.language),
                    bucket.runs,
                    bucket.submits.length,
                    correct ? 'Correct' : 'Wrong',
                    published.date,
                    published.time,
                    submitted.time,
                    delta,
                ]);
            }
        }

        res.status(200).json({
            scope,
            className: classData.name || '',
            columns: SHEET_COLUMNS,
            rows,
        });
    } catch (err) {
        return sendError(res, err, 'Error building class report', 'Class Sheet Report');
    }
};

exports.getQuestionPerspectiveReport = async (req, res) => {
    console.log('[Get Question Perspective Report] Fetching report for class:', req.params.classId, 'question:', req.params.questionId);
    try {
        const { classId, questionId } = req.params;
        const user = req.user;

        console.log('[Get Question Perspective Report] User:', user._id);

        if (!mongoose.Types.ObjectId.isValid(classId) || !mongoose.Types.ObjectId.isValid(questionId)) {
            return res.status(400).json({ error: 'Invalid class or question ID' });
        }

        const studentView = isStudent(user);
        // Staff must manage the class; students must be enrolled (both throw 403/404).
        if (studentView) {
            await assertClassMember(user, classId, '_id students');
        } else {
            await assertClassManager(user, classId, '_id teachers createdBy');
        }

        const classData = await Class.findById(classId).populate('students', 'name email isBlocked');
        if (!classData) {
            return res.status(404).json({ error: 'Class not found' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            return res.status(400).json({ error: 'Question not associated with this class' });
        }
        if (studentView) {
            // Students only get their own rows, and only for questions they can see.
            await assertStudentCanViewQuestion(user, question, classId);
        }

        const submissionFilter = studentView
            ? { classId, questionId, studentId: user._id }
            : { classId, questionId };
        const submissions = await Submission.find(submissionFilter)
            .sort({ submittedAt: -1 })
            .select('-output -testResults')
            .lean();

        const attemptsByStudent = new Map();
        const lastSubmitByStudent = new Map();
        for (const sub of submissions) {
            const sid = sub.studentId.toString();
            if (!attemptsByStudent.has(sid)) attemptsByStudent.set(sid, []);
            attemptsByStudent.get(sid).push({
                submissionId: sub._id,
                isCorrect: Boolean(sub.isCorrect),
                score: sub.score ?? 0,
                submittedAt: sub.submittedAt,
                isRun: Boolean(sub.isRun),
                isCustomInput: Boolean(sub.isCustomInput),
                passedTestCases: sub.passedTestCases ?? 0,
                totalTestCases: sub.totalTestCases ?? 0,
                status: sub.status || (sub.isCorrect ? 'accepted' : 'wrong_answer'),
            });
            if (!sub.isRun && !lastSubmitByStudent.has(sid)) {
                lastSubmitByStudent.set(sid, sub);
            }
        }

        const statusOrder = { correct: 0, incorrect: 1, not_attempted: 2 };
        const studentData = classData.students.map((student) => {
            const sid = student._id.toString();
            const attempts = attemptsByStudent.get(sid) || [];
            const submits = attempts.filter((a) => !a.isRun);

            let status = 'not_attempted';
            if (submits.length > 0) {
                status = submits.some((a) => a.isCorrect) ? 'correct' : 'incorrect';
            }

            const correctAttempts = submits.filter((a) => a.isCorrect).length;
            const wrongAttempts = submits.filter((a) => !a.isCorrect).length;
            const totalRuns = attempts.filter((a) => a.isRun).length;
            const highestScore = submits.length ? Math.max(...submits.map((a) => a.score)) : 0;

            let isBlocked = false;
            if (student.isBlocked) {
                if (typeof student.isBlocked.get === 'function') {
                    isBlocked = Boolean(student.isBlocked.get(String(classId)));
                } else {
                    isBlocked = Boolean(student.isBlocked[String(classId)]);
                }
            }

            const lastSubmit = lastSubmitByStudent.get(sid);

            return {
                studentId: student._id,
                studentName: student.name,
                studentEmail: student.email,
                isBlocked,
                status,
                totalAttempts: attempts.length,
                correctAttempts,
                wrongAttempts,
                totalRuns,
                totalSubmits: submits.length,
                highestScore,
                latestSubmission: attempts[0]?.submittedAt || null,
                lastSubmittedAnswer: lastSubmit?.answer ?? null,
                lastSubmittedLanguage: lastSubmit?.language ?? null,
                lastSubmittedAt: lastSubmit?.submittedAt || null,
                lastSubmittedIsCorrect: lastSubmit ? Boolean(lastSubmit.isCorrect) : null,
                attempts,
            };
        });

        studentData.sort(
            (a, b) =>
                statusOrder[a.status] - statusOrder[b.status] ||
                (a.studentName || '').localeCompare(b.studentName || '')
        );

        const totalStudentsCorrect = studentData.filter((s) => s.status === 'correct').length;
        const totalStudentsIncorrect = studentData.filter((s) => s.status === 'incorrect').length;
        const totalStudentsNotAttempted = studentData.filter((s) => s.status === 'not_attempted').length;
        const totalStudentsAttempted = totalStudentsCorrect + totalStudentsIncorrect;
        const totalCorrect = studentData.reduce((sum, s) => sum + s.correctAttempts, 0);
        const totalWrong = studentData.reduce((sum, s) => sum + s.wrongAttempts, 0);
        const totalRuns = studentData.reduce((sum, s) => sum + s.totalRuns, 0);
        const totalSubmits = studentData.reduce((sum, s) => sum + s.totalSubmits, 0);
        const scored = studentData.filter((s) => s.totalSubmits > 0);
        const avgScore = scored.length
            ? scored.reduce((sum, s) => sum + s.highestScore, 0) / scored.length
            : 0;

        const reportData = {
            question: {
                _id: question._id,
                title: question.title,
                description: question.description,
                difficulty: question.difficulty,
                type: question.type,
                languages: question.languages || [],
                points: question.points,
                tags: question.tags,
                inputFormat: question.inputFormat,
                outputFormat: question.outputFormat,
                constraints: question.constraints,
                sampleIo: question.sampleIo || [],
                isPublished: classEntry.isPublished,
                isDisabled: classEntry.isDisabled,
            },
            class: {
                _id: classData._id,
                name: classData.name,
                description: classData.description,
            },
            studentData,
            totalStudentsAttempted,
            totalStudentsCorrect,
            totalStudentsIncorrect,
            totalStudentsNotAttempted,
            totalCorrect,
            totalWrong,
            totalRuns,
            totalSubmits,
            avgScore,
            totalStudentsEnrolled: classData.students.length,
        };

        if (studentView) {
            reportData.studentData = reportData.studentData
                .filter(s => s.studentId.toString() === user._id.toString())
                .map(({ studentEmail, isBlocked, ...rest }) => rest);
            delete reportData.totalStudentsAttempted;
            delete reportData.totalCorrect;
            delete reportData.totalWrong;
            delete reportData.totalRuns;
            delete reportData.totalSubmits;
            delete reportData.avgScore;
            delete reportData.totalStudentsEnrolled;
        }

        console.log('[Get Question Perspective Report] Report fetched for question:', questionId);
        res.status(200).json({ report: reportData });
    } catch (err) {
        return sendError(res, err, 'Error fetching question perspective report', 'Get Question Perspective Report');
    }
};

/**
 * Staff may test a question when they manage it (owner, or attached to a class they manage).
 * Draft questions are private: only the owner (or an admin) may test them.
 * Throws with `.status` (403/404).
 */
const assertStaffCanTestQuestion = async (user, questionId) => {
    if (!mongoose.Types.ObjectId.isValid(String(questionId))) throw httpError(400, 'Invalid question ID');
    const question = await Question.findById(questionId);
    if (!question) throw httpError(404, 'Question not found');
    const isDraft = question.isDraft || question.status === 'draft';
    if (isDraft && !isAdmin(user) && idStr(question.createdBy) !== String(user._id)) {
        throw httpError(403, 'Only the owner of a draft question can test it');
    }
    if (!isDraft && !(await canManageQuestion(user, question))) {
        throw httpError(403, 'You do not manage this question');
    }
    return question;
};

// Teacher-specific testing endpoint - ALL test cases visible, no leaderboard impact
exports.teacherTestQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const { answer, classId, publicOnly } = req.body;
        const language = String(req.body.language || '').trim().toLowerCase();
        const user = req.user;

        console.log('[Teacher Test Question] User:', user?._id, '| Question:', questionId, '| Class:', classId || null, '| Language:', language, '| runs:', req.body?.runs);

        if (!user) {
            return res.status(401).json({ error: 'User not authenticated' });
        }
        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only teachers and admins can test questions' });
        }
        if (!questionId) {
            return res.status(400).json({ error: 'questionId is required' });
        }
        if (typeof answer !== 'string' || !answer.trim()) {
            return res.status(400).json({ error: 'Solution code is required' });
        }
        if (!language) {
            return res.status(400).json({ error: 'Language is required' });
        }

        // Owner / managed-class check (drafts: owner only). Throws 403/404.
        const question = await assertStaffCanTestQuestion(user, questionId);

        // Only coding questions can be tested
        if (!CODING_TYPES.includes(question.type)) {
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be tested' });
        }

        // Validate language
        if (!Array.isArray(question.languages) || question.languages.length === 0) {
            return res.status(400).json({ error: 'Question has no supported languages' });
        }
        if (!question.languages.includes(language)) {
            return res.status(400).json({
                error: `Language ${language} is not supported for this question. Supported languages: ${question.languages.join(', ')}`
            });
        }

        // Validate test cases
        if (!Array.isArray(question.testCases) || question.testCases.length === 0) {
            return res.status(400).json({ error: 'Question has no test cases. Please add at least one test case.' });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            codeToExecute = resolveFillInTheBlanksCodingCode(question, answer, language);
            if (!String(codeToExecute || '').trim()) {
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
            }
        }

        // Validate time and memory limits (optional override from Test Solution)
        const hasTimeOverride = req.body.timeLimit != null && req.body.timeLimit !== '';
        const hasMemoryOverride = req.body.memoryLimit != null && req.body.memoryLimit !== '';
        const overrideTime = hasTimeOverride ? parseOptionalJudgeLimit(req.body.timeLimit, 0.1, 5, { integer: false }) : undefined;
        const overrideMemory = hasMemoryOverride ? parseOptionalJudgeLimit(req.body.memoryLimit, 16, 1024) : undefined;
        if (hasTimeOverride && overrideTime == null) {
            return res.status(400).json({ error: 'Time limit must be between 0.1 and 5 seconds' });
        }
        if (hasMemoryOverride && overrideMemory == null) {
            return res.status(400).json({ error: 'Memory limit must be between 16 and 1024 MB' });
        }
        const timeLimit = overrideTime ?? (question.timeLimit || 2);
        const memoryLimit = overrideMemory ?? (question.memoryLimit || 256);

        // Execute public tests only for Run; all tests for Submit
        const testsToRun = publicOnly
            ? (question.testCases.filter((tc) => tc.isPublic).length
                ? question.testCases.filter((tc) => tc.isPublic)
                : question.testCases)
            : question.testCases;

        let runCount = Number.parseInt(req.body.runs, 10);
        if (!Number.isFinite(runCount) || runCount < 1) runCount = 1;
        runCount = Math.min(10, runCount);

        let testResults;
        let benchmark = null;
        try {
            const wrapOpts = { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) };

            if (runCount > 1) {
                const probe = testsToRun.find((tc) => tc.isPublic) || testsToRun[0];
                const runSummaries = [];
                testResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    [probe],
                    timeLimit,
                    memoryLimit,
                    { ...wrapOpts, repeats: runCount, repeatSummaries: runSummaries }
                );
                const avgTimeMs = averageNumbers(runSummaries.map((row) => row.maxTimeMs));
                const avgMemoryKb = averageNumbers(runSummaries.map((row) => row.maxMemoryKb));
                const fields = fieldLimitsFromAverages(avgTimeMs, avgMemoryKb);
                benchmark = {
                    runs: runCount,
                    avgTimeMs: avgTimeMs == null ? null : Math.round(avgTimeMs * 10) / 10,
                    avgMemoryKb: avgMemoryKb == null ? null : Math.round(avgMemoryKb),
                    timeLimit: fields.timeLimit,
                    memoryLimit: fields.memoryLimit,
                    runSummaries,
                };
            } else {
                testResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    testsToRun,
                    timeLimit,
                    memoryLimit,
                    wrapOpts
                );
            }
        } catch (err) {
            // 429 JudgeBusyError (and other client-facing judge errors) propagate with their own status.
            if (isHttpError(err)) return sendError(res, err, 'Judge unavailable', 'Teacher Test Question');
            console.error('[Teacher Test Question] Code execution failed:', err.message);
            const missingImage = /No such image|no such container/i.test(err.message || '');
            return res.status(500).json({
                error: missingImage
                    ? 'Code execution failed: Docker image not found. Please build Docker images first.'
                    : 'Code execution failed',
            });
        }

        if (!Array.isArray(testResults) || testResults.length === 0) {
            console.error('[Teacher Test Question] Test results are empty or invalid');
            return res.status(500).json({ error: 'Code execution returned no test results' });
        }

        const passedTestCases = testResults.filter(test => test.passed).length;
        const totalTestCases = testResults.length;
        const isCorrect = testResults.every(test => test.passed);
        const publicTestCases = testResults.filter(test => test.isPublic).length;
        const hiddenTestCases = testResults.filter(test => !test.isPublic).length;

        console.log('[Teacher Test Question] Judged:', passedTestCases, '/', totalTestCases, 'passed');

        // NO DATABASE SAVE - this is just for testing
        // NO LEADERBOARD UPDATE
        // NO SOCKET.IO EMISSION

        const responseData = {
            message: 'Code tested successfully (teacher mode - no submission saved)',
            testResults,
            passedTestCases,
            totalTestCases,
            publicTestCases,
            hiddenTestCases,
            isCorrect,
            teacherMode: true,
            timeLimit,
            memoryLimit,
            ...(benchmark ? { benchmark } : {})
        };

        res.status(200).json(responseData);
    } catch (err) {
        return sendError(res, err, 'Error testing code', 'Teacher Test Question');
    }
};

// Teacher-specific custom input testing - no validation on input format
exports.teacherTestWithCustomInput = async (req, res) => {
    console.log('[Teacher Test With Custom Input] Teacher testing with custom input');
    try {
        const { questionId } = req.params;
        const { answer, classId, customInput, expectedOutput } = req.body;
        const language = String(req.body.language || '').trim().toLowerCase();
        const user = req.user;

        console.log('[Teacher Test With Custom Input] User:', user._id, '| Question:', questionId, '| Language:', language);

        // Authorization check - only teachers and admins
        if (!isStaff(user)) {
            return res.status(403).json({ error: 'Only teachers and admins can test questions' });
        }
        if (typeof answer !== 'string' || !answer.trim()) {
            return res.status(400).json({ error: 'Solution code is required' });
        }

        // Owner / managed-class check (drafts: owner only). Throws 403/404.
        const question = await assertStaffCanTestQuestion(user, questionId);

        // Only coding questions can be tested
        if (!CODING_TYPES.includes(question.type)) {
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be tested' });
        }

        // Validate language
        if (!language || !Array.isArray(question.languages) || !question.languages.includes(language)) {
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }

        // Validate custom input exists
        if (!customInput || typeof customInput !== 'string' || !customInput.trim()) {
            return res.status(400).json({ error: 'Valid custom input is required' });
        }
        if (expectedOutput != null && typeof expectedOutput !== 'string') {
            return res.status(400).json({ error: 'Expected output must be a string' });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            codeToExecute = resolveFillInTheBlanksCodingCode(question, answer, language);
            if (!String(codeToExecute || '').trim()) {
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
            }
        }

        // Create custom test case - NO FORMAT VALIDATION for teachers
        const customTestCase = [{
            input: customInput.trim(),
            expectedOutput: expectedOutput ? expectedOutput.trim() : '',
            isPublic: true
        }];

        // Execute with custom input
        let testResults;
        try {
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                customTestCase,
                question.timeLimit,
                question.memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
        } catch (err) {
            // 429 JudgeBusyError (and other client-facing judge errors) propagate with their own status.
            if (isHttpError(err)) return sendError(res, err, 'Judge unavailable', 'Teacher Test With Custom Input');
            console.error('[Teacher Test With Custom Input] Code execution failed:', err.message);
            return res.status(500).json({ error: 'Code execution failed' });
        }

        const testResult = testResults[0] || {};
        const passed = expectedOutput ? Boolean(testResult.passed) : null; // Only check if expected output provided

        // NO DATABASE SAVE
        // NO LEADERBOARD UPDATE
        // NO SOCKET.IO EMISSION

        res.status(200).json({
            message: 'Code tested with custom input successfully (teacher mode)',
            testResult,
            customInput: customInput.trim(),
            expectedOutput: expectedOutput ? expectedOutput.trim() : null,
            actualOutput: testResult.output,
            passed,
            error: testResult.error,
            timeMs: testResult.timeMs ?? null,
            memoryKb: testResult.memoryKb ?? null,
            teacherMode: true
        });
    } catch (err) {
        return sendError(res, err, 'Error testing code with custom input', 'Teacher Test With Custom Input');
    }
};