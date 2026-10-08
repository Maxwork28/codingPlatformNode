const express = require('express');
const multer = require('multer');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authMiddleware, requireRole } = require('../middleware/auth');

const os = require('os');
const path = require('path');

const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xls', '.csv'];
// Browsers are inconsistent about spreadsheet MIME types, so accept the common ones plus octet-stream,
// and always require a matching extension. The controller re-validates by actually parsing the file.
const SPREADSHEET_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls (and .csv on some Windows browsers)
  'text/csv',
  'text/plain',
  'application/csv',
  'application/octet-stream',
]);
const upload = multer({
  // OS temp dir: outside the project tree, never served, cleaned up by the controller in `finally`.
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimetype = String(file.mimetype || '').toLowerCase();
    if (SPREADSHEET_EXTENSIONS.includes(ext) && SPREADSHEET_MIMETYPES.has(mimetype)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
  },
});

/** Single spreadsheet upload that answers with a 400 instead of a generic 500 on bad files. */
const spreadsheet = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is larger than 5 MB' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Upload an Excel (.xlsx, .xls) or CSV file' });
    }
    return next(err);
  });

// User Management Routes
router.post(
  '/upload',
  authMiddleware,
  requireRole('admin'),
  spreadsheet,
  adminController.uploadExcel
);

// Class Management Routes
router.post(
  '/class',
  authMiddleware,
  requireRole('admin', 'teacher'),
  spreadsheet,
  adminController.createClass
);

router.get(
  '/classes',
  authMiddleware,
  requireRole('admin', 'student', 'teacher'),
  adminController.getAllClasses
);

router.get(
  '/getClass/:classId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getClassDetails
);

router.put(
  '/classes/:classId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.editClass
);

router.post(
  '/classes/:classId/students',
  authMiddleware,
  requireRole('admin', 'teacher'),
  spreadsheet,
  adminController.addStudentsToClass
);

router.put(
  '/classes/:classId/status',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.changeClassStatus
);

router.delete(
  '/classes/:classId',
  authMiddleware,
  requireRole('admin'),
  adminController.deleteClass
);

// Teacher Management Routes
router.post(
  '/teacher-permission',
  authMiddleware,
  requireRole('admin'),
  adminController.manageTeacherPermission
);

router.get(
  '/teachers',
  authMiddleware,
  requireRole('admin', 'student', 'teacher'),
  adminController.getAllTeachers
);

router.delete(
  '/teachers/:teacherId',
  authMiddleware,
  requireRole('admin'),
  adminController.deleteTeacher
);

router.post(
  '/classes/assign-teacher',
  authMiddleware,
  requireRole('admin'),
  adminController.assignTeacherToClass
);

router.post(
  '/classes/remove-teacher',
  authMiddleware,
  requireRole('admin'),
  adminController.removeTeacherFromClass
);

router.get(
  '/classes/:classId/teachers',
  authMiddleware,
  requireRole('admin', 'student', 'teacher'),
  adminController.getTeachersByClass
);

// Student Management Routes
router.get(
  '/students',
  authMiddleware,
  requireRole('admin'),
  adminController.getAllStudents
);

router.get(
  '/classes/:classId/students',
  authMiddleware,
  requireRole('admin', 'student', 'teacher'),
  adminController.getStudentsByClass
);

router.post(
  '/classes/remove-student',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.removeStudentFromClass
);

// New Student Management Routes
router.put(
  '/students/:studentId',
  authMiddleware,
  requireRole('admin'),
  adminController.editStudent
);

router.delete(
  '/students/:studentId',
  authMiddleware,
  requireRole('admin'),
  adminController.deleteStudent
);

router.put(
  '/classes/:classId/block-user',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.blockUser
);

router.put(
  '/classes/:classId/block-all',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.blockAllUsers
);

// Student Focus Management Route
router.patch(
  '/classes/:classId/focus-student',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.focusUnfocusStudent
);

// Assignment Management Routes
router.post(
  '/classes/:classId/assignments',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.createAssignment
);

router.get(
  '/classes/:classId/assignments',
  authMiddleware,
  requireRole('admin', 'teacher', 'student'),
  adminController.getAssignments
);

router.delete(
  '/classes/:classId/assignments/:assignmentId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.deleteAssignment
);

// Leaderboard and Stats Routes
router.get(
  '/classes/:classId/question-summary',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getQuestionSummary
);

router.get(
  '/classes/:classId/participant-stats',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getParticipantStats
);

router.get(
  '/classes/:classId/run-submit-stats',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getRunSubmitStats
);

router.get(
  '/classes/:classId/leaderboard/search',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.searchLeaderboard
);

// Additional Route for Blocking/Unblocking a Student (Explicit Mapping)
router.patch(
  '/classes/:classId/block-student',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.blockUnblockStudent
);

router.get(
  '/counts',
  authMiddleware,
  requireRole('admin'),
  adminController.getCounts
);

router.get(
  '/classes/:classId/overview',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getClassOverview
);

router.delete(
  '/classes/:classId/questions/:questionId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.removeQuestionFromClass
);

router.get(
  '/dashboard',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getDashboard
);

router.get(
  '/student-dashboard',
  authMiddleware,
  requireRole('student'),
  adminController.getStudentDashboard
);

// Question Management Routes
router.post(
  '/questions',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.adminCreateQuestion
);

router.get(
  '/questions/paginated',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getAllQuestionsPaginated
);

router.put(
  '/questions/:questionId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.editQuestion
);

router.delete(
  '/questions/:questionId',
  authMiddleware,
  requireRole('admin'),
  adminController.deleteQuestion
);

router.get(
  '/questions/:questionId/overview',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getQuestionOverview
);

router.get(
  '/questions/search-by-id',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.searchQuestionsById
);

// Draft Question Routes (Admin and Teacher)
router.post(
  '/questions/draft',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.createDraftQuestion
);

router.get(
  '/questions/drafts',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getDrafts
);

router.get(
  '/questions/drafts/count',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getDraftCount
);

router.get(
  '/questions/drafts/:questionId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.getDraftQuestion
);

router.put(
  '/questions/drafts/:questionId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.updateDraftQuestion
);

router.put(
  '/questions/drafts/:questionId/publish',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.publishDraftQuestion
);

router.delete(
  '/questions/drafts/:questionId',
  authMiddleware,
  requireRole('admin', 'teacher'),
  adminController.deleteDraftQuestion
);

module.exports = router;