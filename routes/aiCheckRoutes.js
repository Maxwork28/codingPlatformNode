const express = require('express');
const controller = require('../controllers/aiCheckController');
const { authMiddleware, requireRole } = require('../middleware/auth');

/**
 * Staff endpoints for AI-generated-code detection on exam coding answers (mounted at /ai-check).
 * Students get 403 on every route; class-level access is checked in the controller.
 */
const router = express.Router();

const OBJECT_ID = /^[a-f\d]{24}$/i;
['examId', 'referenceId', 'submissionId'].forEach((name) => {
    router.param(name, (req, res, next, value) => (OBJECT_ID.test(value) ? next() : res.status(400).json({ error: `Invalid ${name}` })));
});

router.use(authMiddleware, requireRole('admin', 'teacher'));

router.get('/config', controller.getConfig);
router.get('/exams/:examId', controller.getExamAiReport);
router.get('/exams/:examId/references', controller.listReferences);
router.post('/exams/:examId/references', controller.addReference);
router.delete('/exams/:examId/references/:referenceId', controller.deleteReference);
router.post('/exams/:examId/generate', controller.generateReferences);
router.get('/exams/:examId/generate', controller.generationStatus);
router.post('/exams/:examId/recheck', controller.recheckExam);
router.get('/submissions/:submissionId', controller.getSubmissionComparison);

module.exports = router;
