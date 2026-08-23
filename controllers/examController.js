const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Class = require('../models/Class');
const Submission = require('../models/Submission');
const Question = require('../models/Question');
const { mergeDriverWithUserAnswer } = require('../utils/codingDriverMerge');
const { resolvePoints } = require('../utils/optionalPoints');
const {
    executeDockerCode,
    shouldMergeDriverForLanguage,
    shouldWrapBareArrayStdinForQuestion,
    sanitizeTestResultsForStudent
} = require('./questionController');

const sanitizeQuestionForExam = (questionDoc) => ({
    _id: questionDoc._id,
    title: questionDoc.title,
    description: questionDoc.description,
    difficulty: questionDoc.difficulty,
    tags: questionDoc.tags,
    points: questionDoc.points,
    type: questionDoc.type,
    options: questionDoc.options,
    correctOption: questionDoc.correctOption,
    correctOptions: questionDoc.correctOptions,
    correctAnswer: questionDoc.correctAnswer,
    codeSnippet: questionDoc.codeSnippet,
    starterCode: questionDoc.starterCode,
    functionSignature: questionDoc.functionSignature,
    driverCode: questionDoc.driverCode,
    testCases: questionDoc.testCases,
    constraints: questionDoc.constraints,
    inputFormat: questionDoc.inputFormat,
    outputFormat: questionDoc.outputFormat,
    sampleIo: questionDoc.sampleIo,
    examples: questionDoc.examples,
    languages: questionDoc.languages,
    hints: questionDoc.hints,
    solution: questionDoc.solution,
    explanation: questionDoc.explanation,
    level: questionDoc.level,
});

const toPlain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value);

const normalizeQuestionId = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Object && value._id) return value._id.toString ? value._id.toString() : value._id;
    if (value.id) return value.id;
    return value;
};

const minutesToSeconds = (minutes, fallbackSeconds) => {
    if (typeof minutes === 'number' && !Number.isNaN(minutes) && minutes > 0) {
        return Math.round(minutes * 60);
    }
    return Math.max(fallbackSeconds || 0, 0);
};

const normalizeQuestions = (questionsInput = []) => {
    return questionsInput.map((q, idx) => {
        const item = toPlain(q) || {};
        const resolvedQuestionId = normalizeQuestionId(item.questionId);
        return {
            questionId: resolvedQuestionId,
            points: item.points ?? 0,
            order: item.order ?? idx,
            sectionId: item.sectionId,
            timeLimitSeconds: item.timeLimitSeconds ?? (item.timeLimitMinutes ? Math.max(0, item.timeLimitMinutes * 60) : null)
        };
    }).filter((q) => q.questionId);
};

const normalizeSections = (sectionsInput, questions, fallbackSeconds) => {
    const baseSeconds = fallbackSeconds || 0;
    let sections = Array.isArray(sectionsInput) && sectionsInput.length
        ? sectionsInput.map((section, idx) => {
            const item = toPlain(section) || {};
            const durationSeconds = typeof item.durationSeconds === 'number'
                ? Math.max(0, item.durationSeconds)
                : minutesToSeconds(item.durationMinutes, baseSeconds);
            return {
                sectionId: item.sectionId || `section-${idx + 1}`,
                title: item.title || `Section ${idx + 1}`,
                description: item.description || '',
                durationSeconds,
                allowRevisit: item.allowRevisit !== undefined ? !!item.allowRevisit : true,
                order: item.order ?? idx
            };
        })
        : [{
            sectionId: 'section-1',
            title: 'Section 1',
            description: '',
            durationSeconds: baseSeconds > 0 ? baseSeconds : minutesToSeconds(60, 3600),
            allowRevisit: true,
            order: 0
        }];

    const seenIds = new Set();
    sections = sections.map((section) => {
        let id = section.sectionId;
        let suffix = 1;
        while (seenIds.has(id)) {
            id = `${section.sectionId}-${suffix++}`;
        }
        seenIds.add(id);
        return { ...section, sectionId: id };
    }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const defaultSectionId = sections[0]?.sectionId;
    questions.forEach((question) => {
        if (!question.sectionId || !seenIds.has(question.sectionId)) {
            question.sectionId = defaultSectionId;
        }
        if (typeof question.timeLimitSeconds === 'number') {
            question.timeLimitSeconds = Math.max(0, question.timeLimitSeconds);
            if (question.timeLimitSeconds === 0) question.timeLimitSeconds = null;
        } else {
            question.timeLimitSeconds = null;
        }
    });

    return sections;
};

const computeExamStatus = (exam) => {
    const now = Date.now();
    const { startTime, endTime, durationMinutes } = exam.proctoring || {};

    if (exam.template?.isTemplate) return 'template';
    if (exam.status === 'archived') return 'archived';

    // If exam has a stored status of 'draft', keep it as draft
    if (exam.status === 'draft') return 'draft';

    // Check scheduled times
    if (startTime) {
        const startTimeMs = new Date(startTime).getTime();
        if (now < startTimeMs) return 'scheduled';
    }
    
    if (endTime) {
        const endTimeMs = new Date(endTime).getTime();
        if (now > endTimeMs) return 'completed';
    }

    // If status is 'scheduled' but no startTime set, keep as scheduled
    if (exam.status === 'scheduled' && !startTime) return 'scheduled';
    
    // If status is 'completed', keep it
    if (exam.status === 'completed') return 'completed';

    // Default to active if exam has duration and no restrictions
    if (durationMinutes || startTime || endTime) {
        return 'active';
    }

    // Fallback to stored status or 'draft'
    return exam.status || 'draft';
};

const sanitizeExamForStudent = (exam) => {
    const computedStatus = computeExamStatus(exam);
    return {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        classId: exam.classId,
        status: computedStatus,
        storedStatus: exam.status, // Include original stored status for reference
        questions: exam.questions.map((q) => ({
            questionId: q.questionId,
            points: q.points,
            order: q.order,
            sectionId: q.sectionId,
            timeLimitSeconds: q.timeLimitSeconds
        })),
        sections: (exam.sections || []).map((section) => ({
            sectionId: section.sectionId,
            title: section.title,
            description: section.description,
            durationSeconds: section.durationSeconds,
            allowRevisit: section.allowRevisit,
            order: section.order
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
            gradingMode: exam.scoring?.gradingMode,
        },
        template: exam.template || {},
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
    };
};

// Create template
exports.createTemplate = async (req, res) => {
    try {
        const { title, description, classId, questions, proctoring, scoring, templateDescription, sections: sectionsInput } = req.body;
        if (!title || !classId || !Array.isArray(questions) || !questions.length) {
            return res.status(400).json({ error: 'Title, classId and questions are required' });
        }

        const questionPayload = normalizeQuestions(questions);
        const fallbackSeconds = (proctoring?.durationMinutes || 60) * 60;
        const sectionPayload = normalizeSections(sectionsInput, questionPayload, fallbackSeconds);

        const exam = await Exam.create({
            title,
            description,
            classId,
            questions: questionPayload,
            sections: sectionPayload,
            proctoring: {
                durationMinutes: proctoring?.durationMinutes || Math.ceil(fallbackSeconds / 60),
                startTime: null,
                endTime: null,
                autoSubmitOnEnd: proctoring?.autoSubmitOnEnd ?? true,
                tabSwitchLimit: proctoring?.tabSwitchLimit ?? 5,
                copyPasteDisabled: proctoring?.copyPasteDisabled ?? true,
                fullscreenRequired: proctoring?.fullscreenRequired ?? true,
                internetRequired: proctoring?.internetRequired ?? true,
                allowRunCode: proctoring?.allowRunCode ?? true,
            },
            scoring: {
                immediateScoreRelease: scoring?.immediateScoreRelease ?? false,
                releaseStatus: 'not_released',
                gradingMode: scoring?.gradingMode || 'auto'
            },
            template: {
                isTemplate: true,
                templateName: title,
                templateDescription,
                baseTemplateId: null
            },
            createdBy: req.user._id,
            status: 'draft'
        });

        res.status(201).json({ message: 'Template created', template: exam });
    } catch (err) {
        console.error('[ExamController] createTemplate error:', err);
        res.status(500).json({ error: 'Failed to create template' });
    }
};

// List templates
exports.listTemplates = async (req, res) => {
    try {
        const templates = await Exam.find({ 'template.isTemplate': true, createdBy: req.user._id }).sort({ updatedAt: -1 });
        res.json({ templates });
    } catch (err) {
        console.error('[ExamController] listTemplates error:', err);
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
};

// Create exam (from template or from scratch)
exports.createExam = async (req, res) => {
    try {
        const { title, description, classId, questions, proctoring, scoring, templateId, sections: sectionsInput, newQuestions } = req.body;
        let templateData = null;
        
        console.log('[createExam] Received proctoring data:', {
            startTime: proctoring?.startTime,
            endTime: proctoring?.endTime,
            startTimeType: typeof proctoring?.startTime,
            endTimeType: typeof proctoring?.endTime
        });

        if (templateId) {
            templateData = await Exam.findById(templateId);
            if (!templateData || !templateData.template?.isTemplate) {
                return res.status(404).json({ error: 'Template not found' });
            }
        }

        // Handle new questions created just for this exam
        let newQuestionIds = [];
        if (newQuestions && Array.isArray(newQuestions) && newQuestions.length > 0) {
            for (const newQ of newQuestions) {
                const question = new Question({
                    ...newQ,
                    createdBy: req.user._id,
                    isExamOnly: true,
                    status: 'published'
                });
                await question.save();
                newQuestionIds.push(question._id);
            }
        }

        // Combine questions from bank and new questions
        const allQuestions = [
            ...(questions?.length ? questions : templateData ? templateData.questions : []),
            ...newQuestionIds.map(qId => ({ questionId: qId }))
        ];

        const questionPayload = normalizeQuestions(allQuestions);

        if (!questionPayload.length) {
            return res.status(400).json({ error: 'Questions are required for an exam' });
        }

        const fallbackMinutes = proctoring?.durationMinutes ?? templateData?.proctoring?.durationMinutes ?? 60;
        const fallbackSeconds = fallbackMinutes * 60;
        const sectionPayload = normalizeSections(
            sectionsInput && sectionsInput.length ? sectionsInput : templateData ? templateData.sections : [],
            questionPayload,
            fallbackSeconds
        );

        // Handle startTime and endTime - check if explicitly provided in request
        // If proctoring object exists and has startTime/endTime keys, use them (even if null)
        // Otherwise, fallback to template values
        let startTimeValue = null;
        let endTimeValue = null;
        
        // Check if startTime was explicitly provided in the request
        if (proctoring && 'startTime' in proctoring) {
            if (proctoring.startTime) {
                // Convert ISO string to Date object if it's a string
                startTimeValue = typeof proctoring.startTime === 'string' 
                    ? new Date(proctoring.startTime) 
                    : proctoring.startTime;
                // Validate the date
                if (isNaN(startTimeValue.getTime())) {
                    console.warn('[createExam] Invalid startTime provided, setting to null');
                    startTimeValue = null;
                } else {
                    console.log('[createExam] Using provided startTime:', startTimeValue);
                }
            } else {
                // Explicitly set to null if provided as null/empty
                startTimeValue = null;
                console.log('[createExam] startTime explicitly set to null');
            }
        } else if (templateData?.proctoring?.startTime) {
            // Only use template's startTime if not explicitly provided in request
            startTimeValue = templateData.proctoring.startTime;
            console.log('[createExam] Using template startTime:', startTimeValue);
        }
        
        // Check if endTime was explicitly provided in the request
        if (proctoring && 'endTime' in proctoring) {
            if (proctoring.endTime) {
                // Convert ISO string to Date object if it's a string
                endTimeValue = typeof proctoring.endTime === 'string' 
                    ? new Date(proctoring.endTime) 
                    : proctoring.endTime;
                // Validate the date
                if (isNaN(endTimeValue.getTime())) {
                    console.warn('[createExam] Invalid endTime provided, setting to null');
                    endTimeValue = null;
                } else {
                    console.log('[createExam] Using provided endTime:', endTimeValue);
                }
            } else {
                // Explicitly set to null if provided as null/empty
                endTimeValue = null;
                console.log('[createExam] endTime explicitly set to null');
            }
        } else if (templateData?.proctoring?.endTime) {
            // Only use template's endTime if not explicitly provided in request
            endTimeValue = templateData.proctoring.endTime;
            console.log('[createExam] Using template endTime:', endTimeValue);
        }

        const exam = await Exam.create({
            title: title || templateData?.title,
            description: description || templateData?.description,
            classId: classId || templateData?.classId,
            questions: questionPayload,
            sections: sectionPayload,
            proctoring: {
                durationMinutes: proctoring?.durationMinutes ?? templateData?.proctoring?.durationMinutes ?? Math.ceil(fallbackSeconds / 60),
                startTime: startTimeValue,
                endTime: endTimeValue,
                autoSubmitOnEnd: proctoring?.autoSubmitOnEnd ?? templateData?.proctoring?.autoSubmitOnEnd ?? true,
                tabSwitchLimit: proctoring?.tabSwitchLimit ?? templateData?.proctoring?.tabSwitchLimit ?? 5,
                copyPasteDisabled: proctoring?.copyPasteDisabled ?? templateData?.proctoring?.copyPasteDisabled ?? true,
                fullscreenRequired: proctoring?.fullscreenRequired ?? templateData?.proctoring?.fullscreenRequired ?? true,
                internetRequired: proctoring?.internetRequired ?? templateData?.proctoring?.internetRequired ?? true,
                allowRunCode: proctoring?.allowRunCode ?? templateData?.proctoring?.allowRunCode ?? true,
            },
            scoring: {
                immediateScoreRelease: scoring?.immediateScoreRelease ?? templateData?.scoring?.immediateScoreRelease ?? false,
                releaseStatus: 'not_released',
                gradingMode: scoring?.gradingMode || templateData?.scoring?.gradingMode || 'auto'
            },
            template: {
                isTemplate: false,
                baseTemplateId: templateData?._id || null
            },
            createdBy: req.user._id,
            status: 'scheduled'
        });

        // Link exam-only questions to this exam
        if (newQuestionIds.length) {
            await Question.updateMany(
                { _id: { $in: newQuestionIds } },
                { examId: exam._id }
            );
        }

        res.status(201).json({ message: 'Exam created', exam });
    } catch (err) {
        console.error('[ExamController] createExam error:', err);
        res.status(500).json({ error: 'Failed to create exam' });
    }
};

// List exams for a class
exports.listClassExams = async (req, res) => {
    try {
        const { classId } = req.params;
        const userId = req.user._id;
        const exams = await Exam.find({ classId, 'template.isTemplate': { $ne: true } }).sort({ 'proctoring.startTime': 1, createdAt: -1 });

        const examIds = exams.map((exam) => exam._id);
        const attempts = await ExamAttempt.find({ examId: { $in: examIds }, studentId: userId });
        const attemptMap = new Map(attempts.map((attempt) => [String(attempt.examId), attempt.status]));

        const examsWithAttempts = exams.map((exam) => {
            const sanitized = sanitizeExamForStudent(exam);
            const attemptStatus = attemptMap.get(String(exam._id));
            return {
                ...sanitized,
                studentAttemptStatus: attemptStatus || null
            };
        });

        res.json({ exams: examsWithAttempts });
    } catch (err) {
        console.error('[ExamController] listClassExams error:', err);
        res.status(500).json({ error: 'Failed to fetch exams' });
    }
};

// Get exam details
exports.getExamDetails = async (req, res) => {
    try {
        const { examId } = req.params;
        const exam = await Exam.findById(examId).populate('questions.questionId');
        if (!exam) return res.status(404).json({ error: 'Exam not found' });
        res.json({ exam });
    } catch (err) {
        console.error('[ExamController] getExamDetails error:', err);
        res.status(500).json({ error: 'Failed to fetch exam details' });
    }
};

// Start exam
exports.startExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const userId = req.user._id;
        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });
        if (exam.template?.isTemplate) return res.status(400).json({ error: 'Templates cannot be started as exams' });

        const status = computeExamStatus(exam);
        if (status === 'scheduled') {
            const startTime = exam.proctoring?.startTime;
            if (startTime) {
                const startTimeDate = new Date(startTime);
                const timeUntilStart = startTimeDate.getTime() - Date.now();
                const minutesUntilStart = Math.floor(timeUntilStart / (60 * 1000));
                return res.status(403).json({ 
                    error: `Exam has not started yet. It will start at ${startTimeDate.toLocaleString()}. ${minutesUntilStart > 0 ? `(${minutesUntilStart} minutes remaining)` : ''}` 
                });
            }
            return res.status(403).json({ error: 'Exam has not started yet' });
        }
        if (status === 'completed') return res.status(403).json({ error: 'Exam has already ended' });

        const classDoc = await Class.findById(exam.classId);
        if (!classDoc || !classDoc.students.includes(userId)) {
            return res.status(403).json({ error: 'You are not enrolled in this class' });
        }

        const questionMeta = exam.questions.map((q, idx) => {
            const item = toPlain(q) || {};
            const resolvedQuestionId = normalizeQuestionId(item.questionId);
            return {
                questionId: resolvedQuestionId,
                points: item.points ?? 0,
                order: item.order ?? idx,
                sectionId: item.sectionId,
                timeLimitSeconds: item.timeLimitSeconds
            };
        }).filter((entry) => entry.questionId);

        if (!questionMeta.length) {
            return res.status(400).json({ error: 'Exam has no questions assigned' });
        }

        const fallbackSeconds = (exam.proctoring?.durationMinutes || 60) * 60;
        const sectionsNormalized = normalizeSections(exam.sections || [], questionMeta, fallbackSeconds);

        if (!sectionsNormalized.length) {
            return res.status(400).json({ error: 'Exam configuration is missing sections' });
        }

        let attempt = await ExamAttempt.findOne({ examId, studentId: userId });
        const now = new Date();

        if (attempt && ['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Exam already completed for this student' });
        }

        const totalSectionSeconds = sectionsNormalized.reduce((sum, section) => sum + (section.durationSeconds || 0), 0);
        const totalDurationSeconds = totalSectionSeconds || fallbackSeconds || 3600;
        const scheduleEnd = exam.proctoring?.endTime ? new Date(exam.proctoring.endTime).getTime() : null;

        if (!attempt) {
            const endsAtCandidate = new Date(now.getTime() + totalDurationSeconds * 1000);
            const endsAt = scheduleEnd ? new Date(Math.min(endsAtCandidate.getTime(), scheduleEnd)) : endsAtCandidate;

            attempt = await ExamAttempt.create({
                examId,
                studentId: userId,
                classId: exam.classId,
                status: 'in_progress',
                startedAt: now,
                endsAt,
                sectionTimers: sectionsNormalized.map((section) => ({
                    sectionId: section.sectionId,
                    remainingSeconds: section.durationSeconds || null,
                    completed: false
                })),
                questionTimers: questionMeta.map((question) => ({
                    questionId: question.questionId,
                    remainingSeconds: question.timeLimitSeconds ?? null,
                    completed: false
                })),
                currentSectionId: sectionsNormalized[0]?.sectionId || null,
                currentQuestionId: questionMeta[0]?.questionId || null
            });
        } else {
            attempt.status = 'in_progress';
            attempt.startedAt = attempt.startedAt || now;

            const sectionTimerMap = new Map((attempt.sectionTimers || []).map((timer) => [timer.sectionId, timer]));
            const updatedSectionTimers = sectionsNormalized.map((section) => {
                const existing = sectionTimerMap.get(section.sectionId);
                if (existing) {
                    return {
                        sectionId: section.sectionId,
                        remainingSeconds: typeof existing.remainingSeconds === 'number' ? existing.remainingSeconds : section.durationSeconds || null,
                        completed: existing.completed || false
                    };
                }
                return {
                    sectionId: section.sectionId,
                    remainingSeconds: section.durationSeconds || null,
                    completed: false
                };
            });

            const questionTimerMap = new Map((attempt.questionTimers || []).map((timer) => [String(timer.questionId), timer]));
            const updatedQuestionTimers = questionMeta.map((question) => {
                const existing = questionTimerMap.get(String(question.questionId));
                if (existing) {
                    return {
                        questionId: question.questionId,
                        remainingSeconds: typeof existing.remainingSeconds === 'number' ? existing.remainingSeconds : question.timeLimitSeconds ?? null,
                        completed: existing.completed || false
                    };
                }
                return {
                    questionId: question.questionId,
                    remainingSeconds: question.timeLimitSeconds ?? null,
                    completed: false
                };
            });

            attempt.sectionTimers = updatedSectionTimers;
            attempt.questionTimers = updatedQuestionTimers;
            attempt.currentSectionId = attempt.currentSectionId || sectionsNormalized[0]?.sectionId || null;
            attempt.currentQuestionId = attempt.currentQuestionId || questionMeta[0]?.questionId || null;

            const existingEndsAt = attempt.endsAt ? attempt.endsAt.getTime() : null;
            const candidateEndsAt = new Date((attempt.startedAt || now).getTime() + totalDurationSeconds * 1000).getTime();
            let resolvedEndsAt = candidateEndsAt;
            if (scheduleEnd) {
                resolvedEndsAt = Math.min(candidateEndsAt, scheduleEnd);
            }
            if (!existingEndsAt || existingEndsAt > resolvedEndsAt) {
                attempt.endsAt = new Date(resolvedEndsAt);
            }

            await attempt.save();
        }

        const questionMetaMap = new Map(questionMeta.map((meta) => [String(meta.questionId), meta]));
        const questionDocs = await Question.find({ _id: { $in: questionMeta.map((meta) => meta.questionId) } });
        const questionDetails = questionDocs.map((doc) => {
            const meta = questionMetaMap.get(String(doc._id)) || {};
            return {
                ...sanitizeQuestionForExam(doc),
                sectionId: meta.sectionId,
                points: meta.points ?? doc.points,
                timeLimitSeconds: meta.timeLimitSeconds
            };
        });

        res.json({
            exam: sanitizeExamForStudent(exam),
            attempt,
            questionDetails
        });
    } catch (err) {
        console.error('[ExamController] startExam error:', err);
        res.status(500).json({ error: 'Failed to start exam' });
    }
};

// Get attempt
exports.getAttempt = async (req, res) => {
    try {
        const { examId } = req.params;
        const attempt = await ExamAttempt.findOne({ examId, studentId: req.user._id });
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        res.json({ attempt });
    } catch (err) {
        console.error('[ExamController] getAttempt error:', err);
        res.status(500).json({ error: 'Failed to fetch attempt' });
    }
};

// Submit answer for a question during exam
exports.submitAnswer = async (req, res) => {
    try {
        const { examId } = req.params;
        const { attemptId, questionId, answer, language } = req.body;
        const userId = req.user._id;

        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const attempt = await ExamAttempt.findOne({ _id: attemptId, examId, studentId: userId });
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        if (['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Attempt already closed' });
        }

        const question = await Question.findById(questionId);
        if (!question) return res.status(404).json({ error: 'Question not found' });

        // Evaluate answer
        let isCorrect = false;
        let score = 0;
        let passedTestCases = 0;
        let totalTestCases = 0;
        let output = null;
        let codingTestResults = null;

        if (question.type === 'singleCorrectMcq') {
            isCorrect = parseInt(answer) === question.correctOption;
            score = isCorrect ? (resolvePoints(exam.questions.find(q => String(q.questionId) === String(questionId))?.points || question.points)) : 0;
            output = answer;
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
        } else if (question.type === 'multipleCorrectMcq') {
            const submittedOptions = Array.isArray(answer) ? answer.map(Number) : [parseInt(answer)];
            const correctOptions = question.correctOptions || [];
            isCorrect = submittedOptions.length === correctOptions.length &&
                submittedOptions.every(opt => correctOptions.includes(opt)) &&
                correctOptions.every(opt => submittedOptions.includes(opt));
            score = isCorrect ? (resolvePoints(exam.questions.find(q => String(q.questionId) === String(questionId))?.points || question.points)) : 0;
            output = JSON.stringify(submittedOptions);
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
        } else if (question.type === 'fillInTheBlanks') {
            isCorrect = answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
            score = isCorrect ? (resolvePoints(exam.questions.find(q => String(q.questionId) === String(questionId))?.points || question.points)) : 0;
            output = answer;
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
        } else if (question.type === 'fillInTheBlanksCoding' || question.type === 'coding' || question.type === 'codingWithDriver') {
            if (!language || !question.languages.includes(language)) {
                return res.status(400).json({ error: `Language ${language} is not supported for this question` });
            }

            let codeToExecute = answer;
            if (question.type === 'fillInTheBlanksCoding') {
                codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
            } else if (shouldMergeDriverForLanguage(question, language)) {
                const driverCodeObj = question.driverCode.find(d => d.language === language);
                if (driverCodeObj && driverCodeObj.code) {
                    codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                }
            }

            try {
                const testResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    question.testCases,
                    question.timeLimit,
                    question.memoryLimit,
                    { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
                );
                codingTestResults = testResults;
                totalTestCases = testResults.length;
                passedTestCases = testResults.filter(test => test.passed).length;
                isCorrect = testResults.every(test => test.passed);
                const questionPoints = resolvePoints(exam.questions.find(q => String(q.questionId) === String(questionId))?.points || question.points);
                score = isCorrect ? questionPoints : Math.floor((passedTestCases / totalTestCases) * questionPoints);
                output = JSON.stringify(sanitizeTestResultsForStudent(testResults));
            } catch (err) {
                isCorrect = false;
                score = 0;
                output = `Error: ${err.message}`;
                passedTestCases = 0;
                totalTestCases = question.testCases.length;
            }
        }

        // Create submission
        const submission = new Submission({
            questionId,
            classId: attempt.classId,
            studentId: userId,
            answer,
            language,
            isCorrect,
            score,
            output,
            isRun: false,
            passedTestCases,
            totalTestCases,
            examAttemptId: attempt._id
        });
        await submission.save();

        // Update attempt answer
        const existingAnswerIndex = attempt.answers.findIndex(a => String(a.questionId) === String(questionId));
        const answerData = {
            questionId,
            submissionId: submission._id,
            answer,
            score,
            maxScore: resolvePoints(exam.questions.find(q => String(q.questionId) === String(questionId))?.points || question.points),
            isCorrect,
            language,
            passedTestCases,
            totalTestCases
        };

        if (existingAnswerIndex >= 0) {
            attempt.answers[existingAnswerIndex] = answerData;
        } else {
            attempt.answers.push(answerData);
        }

        await attempt.save();

        const examSubmitPayload = { message: 'Answer submitted', submission, score, isCorrect, passedTestCases, totalTestCases };
        if (codingTestResults) {
            examSubmitPayload.testResults = sanitizeTestResultsForStudent(codingTestResults);
        }
        res.json(examSubmitPayload);
    } catch (err) {
        console.error('[ExamController] submitAnswer error:', err);
        res.status(500).json({ error: 'Failed to submit answer' });
    }
};

// Log proctoring event
exports.logProctoringEvent = async (req, res) => {
    try {
        const { examId } = req.params;
        const { attemptId, type, details } = req.body;
        if (!attemptId || !type) {
            return res.status(400).json({ error: 'attemptId and type are required' });
        }

        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const attempt = await ExamAttempt.findOne({ _id: attemptId, examId, studentId: req.user._id });
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        if (['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Attempt already closed' });
        }

        if (type === 'heartbeat') {
            attempt.lastHeartbeatAt = new Date();
            await attempt.save();
            return res.json({ success: true, terminate: false });
        }

        const violationEntry = { type, details, timestamp: new Date() };
        attempt.violations.push(violationEntry);

        if (type === 'network_loss') {
            attempt.networkDropCount += 1;
            await attempt.save();
            return res.json({ success: true, terminate: false });
        }

        attempt.violationCount += 1;

        if (type === 'tab_switch') attempt.tabSwitchCount += 1;
        if (type === 'fullscreen_exit') attempt.fullscreenExitCount += 1;
        if (type === 'copy_paste') attempt.copyPasteCount += 1;

        let terminate = false;
        if (type === 'tab_switch' && attempt.tabSwitchCount >= (exam.proctoring?.tabSwitchLimit ?? 5)) {
            attempt.status = 'terminated';
            attempt.submittedAt = new Date();
            terminate = true;
        }

        await attempt.save();
        res.json({ success: true, terminate });
    } catch (err) {
        console.error('[ExamController] logProctoringEvent error:', err);
        res.status(500).json({ error: 'Failed to log event' });
    }
};

// Update section timer
exports.updateSectionTimer = async (req, res) => {
    try {
        const { examId } = req.params;
        const { attemptId, sectionId, remainingSeconds, completed, currentQuestionId } = req.body;
        if (!attemptId || !sectionId) {
            return res.status(400).json({ error: 'attemptId and sectionId are required' });
        }

        const attempt = await ExamAttempt.findOne({ _id: attemptId, examId, studentId: req.user._id });
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        if (['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Attempt already closed' });
        }

        const timer = (attempt.sectionTimers || []).find((entry) => entry.sectionId === sectionId);
        if (timer) {
            if (typeof remainingSeconds === 'number') {
                timer.remainingSeconds = Math.max(0, Math.floor(remainingSeconds));
                if (timer.remainingSeconds === 0) timer.completed = true;
            }
            if (typeof completed === 'boolean') {
                timer.completed = completed;
            }
        } else {
            attempt.sectionTimers.push({
                sectionId,
                remainingSeconds: typeof remainingSeconds === 'number' ? Math.max(0, Math.floor(remainingSeconds)) : null,
                completed: !!completed
            });
        }

        if (currentQuestionId) {
            attempt.currentQuestionId = currentQuestionId;
        }
        attempt.currentSectionId = sectionId;
        await attempt.save();

        res.json({ success: true });
    } catch (err) {
        console.error('[ExamController] updateSectionTimer error:', err);
        res.status(500).json({ error: 'Failed to update section timer' });
    }
};

// Update question timer
exports.updateQuestionTimer = async (req, res) => {
    try {
        const { examId } = req.params;
        const { attemptId, questionId, remainingSeconds, completed } = req.body;
        if (!attemptId || !questionId) {
            return res.status(400).json({ error: 'attemptId and questionId are required' });
        }

        const attempt = await ExamAttempt.findOne({ _id: attemptId, examId, studentId: req.user._id });
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        if (['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Attempt already closed' });
        }

        const timer = (attempt.questionTimers || []).find((entry) => String(entry.questionId) === String(questionId));
        if (timer) {
            if (typeof remainingSeconds === 'number') {
                timer.remainingSeconds = Math.max(0, Math.floor(remainingSeconds));
                if (timer.remainingSeconds === 0) timer.completed = true;
            }
            if (typeof completed === 'boolean') {
                timer.completed = completed;
            }
        } else {
            attempt.questionTimers.push({
                questionId,
                remainingSeconds: typeof remainingSeconds === 'number' ? Math.max(0, Math.floor(remainingSeconds)) : null,
                completed: !!completed
            });
        }

        if (attempt.questionTimers && attempt.questionTimers.length) {
            attempt.currentQuestionId = questionId;
        }

        await attempt.save();
        res.json({ success: true });
    } catch (err) {
        console.error('[ExamController] updateQuestionTimer error:', err);
        res.status(500).json({ error: 'Failed to update question timer' });
    }
};

// Evaluate attempt
const evaluateAttempt = async (exam, attempt) => {
    const answers = [];
    let totalScore = 0;
    let maxScore = 0;

    for (const q of exam.questions) {
        const submission = await Submission.findOne({
            questionId: q.questionId,
            studentId: attempt.studentId,
            classId: attempt.classId,
            examAttemptId: attempt._id,
            isRun: false
        }).sort({ submittedAt: -1 });

        const current = {
            questionId: q.questionId,
            submissionId: submission?._id || null,
            answer: attempt.answers.find(a => String(a.questionId) === String(q.questionId))?.answer || null,
            score: submission?.score || attempt.answers.find(a => String(a.questionId) === String(q.questionId))?.score || 0,
            maxScore: q.points || 0,
            isCorrect: submission?.isCorrect || attempt.answers.find(a => String(a.questionId) === String(q.questionId))?.isCorrect || false,
            language: submission?.language || attempt.answers.find(a => String(a.questionId) === String(q.questionId))?.language || null,
            passedTestCases: submission?.passedTestCases || attempt.answers.find(a => String(a.questionId) === String(q.questionId))?.passedTestCases || 0,
            totalTestCases: submission?.totalTestCases || attempt.answers.find(a => String(a.questionId) === String(q.questionId))?.totalTestCases || 0
        };

        answers.push(current);
        totalScore += current.score;
        maxScore += current.maxScore;
    }

    attempt.answers = answers;
    attempt.totalScore = totalScore;
    attempt.maxScore = maxScore;
};

// Finalize attempt
const finalizeAttempt = async (exam, attempt, { autoSubmitted = false, manualSubmitted = false }) => {
    await evaluateAttempt(exam, attempt);
    attempt.status = autoSubmitted ? 'auto_submitted' : manualSubmitted ? 'submitted' : attempt.status;
    attempt.autoSubmitted = autoSubmitted;
    attempt.manualSubmitted = manualSubmitted;
    attempt.submittedAt = new Date();
    await attempt.save();
};

// Submit exam
exports.submitExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const { attemptId } = req.body;
        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const attempt = await ExamAttempt.findOne({ _id: attemptId, examId, studentId: req.user._id });
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        if (['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Attempt already closed' });
        }

        await finalizeAttempt(exam, attempt, { manualSubmitted: true });
        res.json({ message: 'Exam submitted', attempt });
    } catch (err) {
        console.error('[ExamController] submitExam error:', err);
        res.status(500).json({ error: 'Failed to submit exam' });
    }
};

// Auto submit exam
exports.autoSubmitExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const { attemptId } = req.body;
        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const attempt = await ExamAttempt.findById(attemptId);
        if (!attempt || attempt.examId.toString() !== examId) {
            return res.status(404).json({ error: 'Attempt not found' });
        }

        if (!['in_progress', 'not_started'].includes(attempt.status)) {
            return res.status(400).json({ error: 'Attempt already closed' });
        }

        await finalizeAttempt(exam, attempt, { autoSubmitted: true });
        res.json({ message: 'Attempt auto-submitted', attempt });
    } catch (err) {
        console.error('[ExamController] autoSubmitExam error:', err);
        res.status(500).json({ error: 'Failed to auto submit exam' });
    }
};

// Get exam report
exports.getExamReport = async (req, res) => {
    try {
        const { examId } = req.params;
        const exam = await Exam.findById(examId).populate('questions.questionId');
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const attempts = await ExamAttempt.find({ examId }).populate('studentId', 'name email');

        const attemptsWithSubmissions = await Promise.all(
            attempts.map(async (attempt) => {
                const answersWithSubmissions = [];
                if (attempt.answers && attempt.answers.length > 0) {
                    for (const ans of attempt.answers) {
                        if (ans.submissionId) {
                            const submission = await Submission.findById(ans.submissionId);
                            answersWithSubmissions.push({
                                ...ans,
                                submission: submission ? {
                                    answer: submission.answer,
                                    language: submission.language,
                                    passedTestCases: submission.passedTestCases,
                                    totalTestCases: submission.totalTestCases,
                                    submittedAt: submission.submittedAt
                                } : null
                            });
                        } else {
                            answersWithSubmissions.push(ans);
                        }
                    }
                }
                return {
                    ...attempt.toObject(),
                    answers: answersWithSubmissions
                };
            })
        );

        res.json({ exam, attempts: attemptsWithSubmissions });
    } catch (err) {
        console.error('[ExamController] getExamReport error:', err);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
};

// Get student exam results
exports.getStudentExamResults = async (req, res) => {
    try {
        const { examId } = req.params;
        const userId = req.user._id;

        const exam = await Exam.findById(examId).populate('questions.questionId');
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const attempt = await ExamAttempt.findOne({ examId, studentId: userId });
        if (!attempt) {
            return res.status(404).json({ error: 'No attempt found for this exam' });
        }

        if (!['submitted', 'auto_submitted', 'terminated'].includes(attempt.status)) {
            return res.status(403).json({ error: 'Results not available yet. Exam not submitted.' });
        }

        // Check if scores are released
        if (exam.scoring?.releaseStatus !== 'released' && !exam.scoring?.immediateScoreRelease) {
            return res.status(403).json({ error: 'Results not released yet' });
        }

        const answersWithSubmissions = [];
        if (attempt.answers && attempt.answers.length > 0) {
            for (const ans of attempt.answers) {
                if (ans.submissionId) {
                    const submission = await Submission.findById(ans.submissionId);
                    answersWithSubmissions.push({
                        ...ans,
                        submission: submission ? {
                            answer: submission.answer,
                            language: submission.language,
                            passedTestCases: submission.passedTestCases,
                            totalTestCases: submission.totalTestCases,
                            submittedAt: submission.submittedAt
                        } : null
                    });
                } else {
                    answersWithSubmissions.push(ans);
                }
            }
        }

        res.json({
            exam,
            attempt: {
                ...attempt.toObject(),
                answers: answersWithSubmissions
            }
        });
    } catch (err) {
        console.error('[ExamController] getStudentExamResults error:', err);
        res.status(500).json({ error: 'Failed to fetch exam results' });
    }
};

// Release scores
exports.releaseScores = async (req, res) => {
    try {
        const { examId } = req.params;
        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        exam.scoring = exam.scoring || {};
        exam.scoring.releaseStatus = 'released';
        await exam.save();

        res.json({ message: 'Scores released' });
    } catch (err) {
        console.error('[ExamController] releaseScores error:', err);
        res.status(500).json({ error: 'Failed to release scores' });
    }
};

// Edit/Update exam
exports.editExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const { title, description, questions, proctoring, scoring, sections: sectionsInput, newQuestions } = req.body;
        const user = req.user;

        if (!['admin', 'teacher'].includes(user.role)) {
            return res.status(403).json({ error: 'Only admin or teacher can edit exams' });
        }

        const exam = await Exam.findById(examId);
        if (!exam) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        // Check if exam has attempts (if so, only allow limited edits)
        const attemptCount = await ExamAttempt.countDocuments({ examId });
        if (attemptCount > 0) {
            // Allow editing even with attempts, but show a warning
            console.warn(`[editExam] Editing exam ${examId} with ${attemptCount} existing attempts`);
        }

        // Handle new questions
        let newQuestionIds = [];
        if (newQuestions && Array.isArray(newQuestions) && newQuestions.length > 0) {
            for (const newQ of newQuestions) {
                const question = new Question({
                    ...newQ,
                    createdBy: user._id,
                    isExamOnly: true,
                    status: 'published',
                    examId: exam._id
                });
                await question.save();
                newQuestionIds.push(question._id);
            }
        }

        // Combine questions
        const allQuestions = [
            ...(questions?.length ? questions : []),
            ...newQuestionIds.map(qId => ({ questionId: qId }))
        ];

        const questionPayload = normalizeQuestions(allQuestions);
        const fallbackMinutes = proctoring?.durationMinutes ?? exam.proctoring?.durationMinutes ?? 60;
        const fallbackSeconds = fallbackMinutes * 60;
        const sectionPayload = normalizeSections(
            sectionsInput && sectionsInput.length ? sectionsInput : exam.sections || [],
            questionPayload,
            fallbackSeconds
        );

        // Update exam
        if (title) exam.title = title;
        if (description !== undefined) exam.description = description;
        if (questionPayload.length > 0) exam.questions = questionPayload;
        if (sectionPayload.length > 0) exam.sections = sectionPayload;
        
        // Handle proctoring updates, especially startTime and endTime
        if (proctoring) {
            // Ensure proctoring object exists
            if (!exam.proctoring) {
                exam.proctoring = {};
            }
            
            // Process startTime if provided
            if ('startTime' in proctoring) {
                if (proctoring.startTime) {
                    const startDate = typeof proctoring.startTime === 'string' 
                        ? new Date(proctoring.startTime) 
                        : proctoring.startTime;
                    if (!isNaN(startDate.getTime())) {
                        exam.proctoring.startTime = startDate;
                        console.log('[editExam] Updating startTime to:', startDate);
                    } else {
                        console.warn('[editExam] Invalid startTime provided, keeping existing');
                    }
                } else {
                    // Explicitly set to null if provided as null/empty
                    exam.proctoring.startTime = null;
                    console.log('[editExam] startTime explicitly set to null');
                }
            }
            
            // Process endTime if provided
            if ('endTime' in proctoring) {
                if (proctoring.endTime) {
                    const endDate = typeof proctoring.endTime === 'string' 
                        ? new Date(proctoring.endTime) 
                        : proctoring.endTime;
                    if (!isNaN(endDate.getTime())) {
                        exam.proctoring.endTime = endDate;
                        console.log('[editExam] Updating endTime to:', endDate);
                    } else {
                        console.warn('[editExam] Invalid endTime provided, keeping existing');
                    }
                } else {
                    // Explicitly set to null if provided as null/empty
                    exam.proctoring.endTime = null;
                    console.log('[editExam] endTime explicitly set to null');
                }
            }
            
            // Update other proctoring fields (excluding startTime/endTime to avoid overwriting)
            const { startTime, endTime, ...otherProctoring } = proctoring;
            exam.proctoring = {
                ...exam.proctoring,
                ...otherProctoring
            };
            
            // Mark proctoring as modified for Mongoose
            exam.markModified('proctoring');
            console.log('[editExam] Proctoring after update:', JSON.stringify({
                startTime: exam.proctoring.startTime,
                endTime: exam.proctoring.endTime,
                durationMinutes: exam.proctoring.durationMinutes
            }, null, 2));
        }
        if (scoring) {
            exam.scoring = {
                ...exam.scoring,
                ...scoring
            };
        }

        await exam.save();
        console.log('[editExam] Exam saved. Final proctoring values:', {
            startTime: exam.proctoring?.startTime,
            endTime: exam.proctoring?.endTime
        });

        res.json({ message: 'Exam updated successfully', exam });
    } catch (err) {
        console.error('[ExamController] editExam error:', err);
        res.status(500).json({ error: 'Failed to update exam' });
    }
};

// Delete exam
exports.deleteExam = async (req, res) => {
    try {
        const { examId } = req.params;
        const user = req.user;

        if (!['admin', 'teacher'].includes(user.role)) {
            return res.status(403).json({ error: 'Only admin or teacher can delete exams' });
        }

        const exam = await Exam.findById(examId);
        if (!exam) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        if (user.role === 'teacher') {
            const classData = await Class.findById(exam.classId);
            if (!classData) {
                return res.status(404).json({ error: 'Class not found' });
            }

            const isCreator = classData.createdBy && classData.createdBy.toString() === user._id.toString();
            const isTeacher = classData.teachers && classData.teachers.some(
                teacherId => teacherId.toString() === user._id.toString()
            );

            if (!isCreator && !isTeacher) {
                return res.status(403).json({ error: 'You can only delete exams from your own classes' });
            }
        }

        await ExamAttempt.deleteMany({ examId });
        await Exam.deleteOne({ _id: examId });

        res.json({ message: 'Exam deleted successfully' });
    } catch (err) {
        console.error('[ExamController] deleteExam error:', err);
        res.status(500).json({ error: 'Failed to delete exam' });
    }
};

