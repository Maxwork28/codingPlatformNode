const express = require('express');
const router = express.Router();
const questionController = require('../controllers/questionController');
const { authMiddleware, requireRole } = require('../middleware/auth');

// Search questions route must come before /:questionId to avoid misinterpretation
router.get('/search', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.searchQuestions
);

router.post('/assign', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.assignQuestion
);

router.put('/:questionId', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.editQuestion
);

router.delete('/:questionId', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.deleteQuestion
);

router.get('/:questionId/solution', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.viewSolution
);

router.get('/:questionId/test-cases', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.viewTestCases
);

router.get('/:questionId/statement', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.viewStatement
);

router.put('/:questionId/publish', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.publishQuestion
);

router.put('/:questionId/unpublish', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.unpublishQuestion
);

router.put('/:questionId/disable', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.disableQuestion
);

router.put('/:questionId/enable', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.enableQuestion
);

router.post('/:questionId/submit', 
  authMiddleware,
  requireRole('student'),
  questionController.submitAnswer
);

router.post('/:questionId/run', 
  authMiddleware,
  questionController.runQuestion
);

router.get('/classes/:classId/leaderboard', 
  authMiddleware,
  questionController.getLeaderboard
);

router.get('/classes/:classId/questions', 
  authMiddleware,
  questionController.getQuestionsByClass
);

router.get('/classes/:classId/questions/:questionId/report',
  authMiddleware,
  questionController.getQuestionPerspectiveReport
);

router.get('/:questionId', 
  authMiddleware,
  questionController.getQuestion
);

router.get('/', 
  authMiddleware,
  questionController.getAllQuestions
);

router.post('/:questionId/assign', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.assignQuestionToClass
);

router.get('/submissions/:submissionId/code',
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.viewSubmissionCode
);

router.post('/:questionId/run-custom', 
    authMiddleware,
    requireRole('student'),
    questionController.runWithCustomInput
);

module.exports = router;