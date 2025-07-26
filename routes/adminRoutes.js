const express = require('express');
const multer = require('multer');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authMiddleware, requireRole } = require('../middleware/auth');

const upload = multer({ dest: 'uploads/' });

// User Management Routes
router.post(
  '/upload',
  authMiddleware,
  requireRole('admin'),
  upload.single('file'),
  adminController.uploadExcel
);

// Class Management Routes
router.post(
  '/class',
  authMiddleware,
  upload.single('file'),
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
  requireRole('admin'),
  adminController.editClass
);

router.put(
  '/classes/:classId/status',
  authMiddleware,
  requireRole('admin'),
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
  requireRole('admin', 'student'),
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
  requireRole('admin'),
  adminController.removeStudentFromClass
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

// Question Management Routes
router.post(
  '/questions',
  authMiddleware,
  requireRole('admin'),
  adminController.adminCreateQuestion
);

router.get(
  '/questions/paginated',
  authMiddleware,
  requireRole('admin'),
  adminController.getAllQuestionsPaginated
);

router.put(
  '/questions/:questionId',
  authMiddleware,
  requireRole('admin'),
  adminController.editQuestion
);

router.delete(
  '/questions/:questionId',
  authMiddleware,
  requireRole('admin'),
  adminController.deleteQuestion
);

router.get(
  '/questions/search-by-id',
  authMiddleware,
  requireRole('admin'),
  adminController.searchQuestionsById
);

module.exports = router;