const express = require('express');
const router = express.Router();
const examController = require('../controllers/examController');
const { authMiddleware, requireRole } = require('../middleware/auth');

const staff = [authMiddleware, requireRole('admin', 'teacher')];
const student = [authMiddleware, requireRole('student')];

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

// Student attempt
router.get('/:examId/summary', student, examController.getStudentExamSummary);
router.post('/:examId/start', student, examController.startExam);
router.get('/:examId/attempt', student, examController.getAttempt);
router.post('/:examId/submit-answer', student, examController.submitAnswer);
router.post('/:examId/run', student, examController.runCode);
router.post('/:examId/events', student, examController.logProctoringEvent);
router.patch('/:examId/section-timer', student, examController.updateSectionTimer);
router.patch('/:examId/question-timer', student, examController.updateQuestionTimer);
router.post('/:examId/submit', student, examController.submitExam);
router.post('/:examId/auto-submit', student, examController.autoSubmitExam);
router.get('/:examId/results', student, examController.getStudentExamResults);

module.exports = router;
