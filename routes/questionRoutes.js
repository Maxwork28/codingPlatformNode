const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const questionController = require('../controllers/questionController');
const { authMiddleware, requireRole } = require('../middleware/auth');

const questionImageDir = path.join(__dirname, '..', 'uploads', 'questions');
if (!fs.existsSync(questionImageDir)) {
  fs.mkdirSync(questionImageDir, { recursive: true });
}

const questionImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, questionImageDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      const safeExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? ext : '.png';
      cb(null, `${req.user._id}-${Date.now()}${safeExt}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!file.mimetype || !allowed.includes(file.mimetype)) {
      return cb(new Error('Only PNG, JPG, GIF, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

router.post(
  '/upload-image',
  authMiddleware,
  requireRole('admin', 'teacher'),
  (req, res, next) => {
    questionImageUpload.single('image')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Failed to upload image' });
      }
      next();
    });
  },
  questionController.uploadQuestionImage
);

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

router.post('/:questionId/assign', 
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.assignQuestionToClass
);

router.get('/:questionId', 
  authMiddleware,
  questionController.getQuestion
);

router.get('/', 
  authMiddleware,
  questionController.getAllQuestions
);

router.post('/:questionId/run-custom', 
    authMiddleware,
    requireRole('student'),
    questionController.runWithCustomInput
);

router.get('/submissions/:submissionId/code',
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.viewSubmissionCode
);

router.post('/submissions/:submissionId/mark-correct',
  authMiddleware,
  requireRole('admin', 'teacher'),
  questionController.markSubmissionCorrect
);

// Teacher-specific testing routes (no leaderboard impact)
router.post('/:questionId/teacher-test', 
  authMiddleware,
  requireRole('teacher', 'admin'),
  questionController.teacherTestQuestion
);

router.post('/:questionId/teacher-test-custom', 
  authMiddleware,
  requireRole('teacher', 'admin'),
  questionController.teacherTestWithCustomInput
);

module.exports = router;