const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const Class = require('../models/Class');
const Submission = require('../models/Submission');
const Question = require('../models/Question');

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
  examples: questionDoc.examples,
  languages: questionDoc.languages,
  hints: questionDoc.hints,
  solution: questionDoc.solution,
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

  if (startTime && now < new Date(startTime).getTime()) return 'scheduled';
  if (endTime && now > new Date(endTime).getTime()) return 'completed';
  if (durationMinutes && !startTime && !endTime) {
    // duration-based exam without explicit window
    if (exam.status === 'completed') return 'completed';
  }
  return 'active';
};

const sanitizeExamForStudent = (exam) => {
  const status = computeExamStatus(exam);
  return {
    _id: exam._id,
    title: exam.title,
    description: exam.description,
    classId: exam.classId,
    status,
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
    },
    scoring: {
      immediateScoreRelease: exam.scoring?.immediateScoreRelease,
      releaseStatus: exam.scoring?.releaseStatus,
    },
  };
};

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

exports.listTemplates = async (req, res) => {
  try {
    const templates = await Exam.find({ 'template.isTemplate': true, createdBy: req.user._id }).sort({ updatedAt: -1 });
    res.json({ templates });
  } catch (err) {
    console.error('[ExamController] listTemplates error:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
};

exports.createExam = async (req, res) => {
  try {
    const { title, description, classId, questions, proctoring, scoring, templateId, sections: sectionsInput } = req.body;
    let templateData = null;

    if (templateId) {
      templateData = await Exam.findById(templateId);
      if (!templateData || !templateData.template?.isTemplate) {
        return res.status(404).json({ error: 'Template not found' });
      }
    }

    const questionPayload = normalizeQuestions(
      questions?.length ? questions : templateData ? templateData.questions : []
    );

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

    const exam = await Exam.create({
      title: title || templateData?.title,
      description: description || templateData?.description,
      classId: classId || templateData?.classId,
      questions: questionPayload,
      sections: sectionPayload,
      proctoring: {
        durationMinutes: proctoring?.durationMinutes ?? templateData?.proctoring?.durationMinutes ?? Math.ceil(fallbackSeconds / 60),
        startTime: proctoring?.startTime || templateData?.proctoring?.startTime,
        endTime: proctoring?.endTime || templateData?.proctoring?.endTime,
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

    const examQuestionIds = questionPayload.map((q) => q.questionId).filter(Boolean);
    if (examQuestionIds.length) {
      await Question.updateMany(
        { _id: { $in: examQuestionIds }, isExamOnly: true },
        { examId: exam._id }
      );
    }

    res.status(201).json({ message: 'Exam created', exam });
  } catch (err) {
    console.error('[ExamController] createExam error:', err);
    res.status(500).json({ error: 'Failed to create exam' });
  }
};

exports.listClassExams = async (req, res) => {
  try {
    const { classId } = req.params;
    const userId = req.user._id;
    const exams = await Exam.find({ classId, 'template.isTemplate': { $ne: true } }).sort({ 'proctoring.startTime': 1, createdAt: -1 });
    
    // Fetch attempt status for each exam
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

exports.startExam = async (req, res) => {
  try {
    const { examId } = req.params;
    const userId = req.user._id;
    const exam = await Exam.findById(examId);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.template?.isTemplate) return res.status(400).json({ error: 'Templates cannot be started as exams' });

    const status = computeExamStatus(exam);
    if (status === 'scheduled') return res.status(403).json({ error: 'Exam has not started yet' });
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

    // Ensure exam document stays in sync with normalized structure
    const needsUpdate =
      (exam.sections || []).length !== sectionsNormalized.length ||
      exam.questions.some((q, idx) => {
        const meta = questionMeta[idx];
        return q.sectionId !== meta.sectionId || (q.timeLimitSeconds || null) !== (meta.timeLimitSeconds || null);
      });

    if (needsUpdate) {
      exam.sections = sectionsNormalized;
      exam.questions = questionMeta.map((meta, idx) => ({
        questionId: meta.questionId,
        points: meta.points,
        order: meta.order ?? idx,
        sectionId: meta.sectionId,
        timeLimitSeconds: meta.timeLimitSeconds
      }));
      await exam.save();
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

      // Ensure section timers exist for every section
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

      // Ensure question timers exist for every question
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
      score: submission?.score || 0,
      maxScore: q.points || submission?.score || 0,
      isCorrect: submission?.isCorrect || false
    };

    answers.push(current);
    totalScore += current.score;
    maxScore += current.maxScore;
  }

  attempt.answers = answers;
  attempt.totalScore = totalScore;
  attempt.maxScore = maxScore;
};

const finalizeAttempt = async (exam, attempt, { autoSubmitted = false, manualSubmitted = false }) => {
  await evaluateAttempt(exam, attempt);
  attempt.status = autoSubmitted ? 'auto_submitted' : manualSubmitted ? 'submitted' : attempt.status;
  attempt.autoSubmitted = autoSubmitted;
  attempt.manualSubmitted = manualSubmitted;
  attempt.submittedAt = new Date();
  await attempt.save();
};

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

exports.getExamReport = async (req, res) => {
  try {
    const { examId } = req.params;
    const exam = await Exam.findById(examId);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    const attempts = await ExamAttempt.find({ examId }).populate('studentId', 'name email');
    res.json({ exam, attempts });
  } catch (err) {
    console.error('[ExamController] getExamReport error:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
};

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
