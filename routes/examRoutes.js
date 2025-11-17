const express = require('express');
const router = express.Router();
const examController = require('../controllers/examController');
const { authMiddleware, requireRole } = require('../middleware/auth');

// Templates
router.post(
  '/templates',
  authMiddleware,
  requireRole('admin', 'teacher'),
  examController.createTemplate
);

router.get(
  '/templates',
  authMiddleware,
  requireRole('admin', 'teacher'),
  examController.listTemplates
);

// Exams
router.post(
  '/',
  authMiddleware,
  requireRole('admin', 'teacher'),
  examController.createExam
);

router.get(
  '/class/:classId',
  authMiddleware,
  requireRole('student', 'teacher', 'admin'),
  examController.listClassExams
);

router.get(
  '/:examId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  examController.getExamDetails
);

// Attempts
router.post(
  '/:examId/start',
  authMiddleware,
  requireRole('student'),
  examController.startExam
);

router.get(
  '/:examId/attempt',
  authMiddleware,
  requireRole('student'),
  examController.getAttempt
);

router.post(
  '/:examId/events',
  authMiddleware,
  requireRole('student'),
  examController.logProctoringEvent
);

router.patch(
  '/:examId/section-timer',
  authMiddleware,
  requireRole('student'),
  examController.updateSectionTimer
);

router.patch(
  '/:examId/question-timer',
  authMiddleware,
  requireRole('student'),
  examController.updateQuestionTimer
);

router.post(
  '/:examId/submit',
  authMiddleware,
  requireRole('student'),
  examController.submitExam
);

router.post(
  '/:examId/auto-submit',
  authMiddleware,
  requireRole('student', 'admin', 'teacher'),
  examController.autoSubmitExam
);

// Reporting
router.get(
  '/:examId/report',
  authMiddleware,
  requireRole('admin', 'teacher'),
  examController.getExamReport
);

router.post(
  '/:examId/release',
  authMiddleware,
  requireRole('admin', 'teacher'),
  examController.releaseScores
);

module.exports = router;
