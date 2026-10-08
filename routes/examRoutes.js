const express = require('express');
const router = express.Router();
const examController = require('../controllers/examController');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { requireSeb } = require('../middleware/seb');

const staff = [authMiddleware, requireRole('admin', 'teacher')];
const student = [authMiddleware, requireRole('student')];
// Student routes that must come from Safe Exam Browser when the exam requires it.
// (summary and results stay readable so the lobby can offer "Open in Safe Exam Browser".)
const studentInSeb = [...student, requireSeb];

const OBJECT_ID = /^[a-f\d]{24}$/i;
['examId', 'classId', 'attemptId'].forEach((name) => {
    router.param(name, (req, res, next, value) =>
        OBJECT_ID.test(value) ? next() : res.status(400).json({ error: `Invalid ${name}` })
    );
});

// Templates and question picker (must precede '/:examId')
router.post('/templates', staff, examController.createTemplate);
router.get('/templates', staff, examController.listTemplates);
router.get('/question-bank', staff, examController.listQuestionBank);

// Exams
router.post('/', staff, examController.createExam);
router.get('/', staff, examController.listStaffExams);
router.get('/class/:classId', authMiddleware, requireRole('student', 'teacher', 'admin'), examController.listClassExams);
router.get('/:examId', staff, examController.getExamDetails);
router.put('/:examId', staff, examController.editExam);
router.patch('/:examId/status', staff, examController.setExamStatus);
router.post('/:examId/duplicate', staff, examController.duplicateExam);
router.delete('/:examId', staff, examController.deleteExam);

// Reporting and live monitoring
router.get('/:examId/report', staff, examController.getExamReport);
router.post('/:examId/release', staff, examController.releaseScores);
router.post('/:examId/attempts/:attemptId/submit', staff, examController.forceSubmitAttempt);
router.post('/:examId/attempts/:attemptId/extend', staff, examController.extendAttempt);
router.delete('/:examId/attempts/:attemptId', staff, examController.resetAttempt);

// Safe Exam Browser
router.post('/:examId/seb/regenerate', staff, examController.regenerateSebPasswords);
router.get('/:examId/seb-config', staff, examController.downloadSebConfigStaff);
// No bearer auth: SEB downloads this itself after a seb:// / sebs:// link; the random token authorises it.
router.get('/:examId/seb-config/:token', examController.downloadSebConfig);
router.get('/:examId/seb-check', authMiddleware, requireRole('student', 'teacher', 'admin'), examController.sebCheck);

// Student attempt
router.get('/:examId/summary', student, examController.getStudentExamSummary);
router.post('/:examId/start', studentInSeb, examController.startExam);
router.get('/:examId/attempt', studentInSeb, examController.getAttempt);
router.post('/:examId/submit-answer', studentInSeb, examController.submitAnswer);
router.post('/:examId/run', studentInSeb, examController.runCode);
router.post('/:examId/events', studentInSeb, examController.logProctoringEvent);
router.post('/:examId/navigate', studentInSeb, examController.navigate);
// Legacy timer routes: can switch the current question/section or lock a timer, never set time.
router.patch('/:examId/section-timer', studentInSeb, examController.updateSectionTimer);
router.patch('/:examId/question-timer', studentInSeb, examController.updateQuestionTimer);
router.post('/:examId/submit', studentInSeb, examController.submitExam);
router.post('/:examId/auto-submit', studentInSeb, examController.autoSubmitExam);
router.get('/:examId/results', student, examController.getStudentExamResults);

module.exports = router;
