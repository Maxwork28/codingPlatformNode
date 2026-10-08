'use strict';

/**
 * Central authorization helpers. Every class- or question-scoped handler must go through
 * these instead of trusting the role alone (route-level requireRole only proves the user is
 * *a* teacher, not that they teach *this* class).
 *
 * All `assert*` helpers throw an Error with `.status` (403/404) so controllers can do:
 *   try { ... } catch (err) { return sendError(res, err) }
 */

const mongoose = require('mongoose');
const Class = require('../models/Class');
const Question = require('../models/Question');

const idOf = (v) => String(v?._id ?? v);
const idEq = (a, b) => a != null && b != null && idOf(a) === idOf(b);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const forbidden = (message = 'You do not have access to this resource') => httpError(403, message);
const notFound = (message = 'Not found') => httpError(404, message);

const isAdmin = (user) => !!user && (user.role === 'admin' || user.role === 'superAdmin');
const isTeacher = (user) => !!user && user.role === 'teacher';
const isStudent = (user) => !!user && user.role === 'student';
const isStaff = (user) => isAdmin(user) || isTeacher(user);

/** Teacher assigned to or creator of the class (admins always). */
const classManagedBy = (cls, user) => {
    if (!cls || !user) return false;
    if (isAdmin(user)) return true;
    if (!isTeacher(user)) return false;
    return (cls.teachers || []).some((t) => idEq(t, user._id)) || idEq(cls.createdBy, user._id);
};

const classHasStudent = (cls, user) => !!cls && !!user && (cls.students || []).some((s) => idEq(s, user._id));

/** Manager, or an enrolled student. */
const classAccessibleBy = (cls, user) => classManagedBy(cls, user) || (isStudent(user) && classHasStudent(cls, user));

/** True for a mongoose document / lean object, false for an ObjectId (which also has an `_id` getter). */
const isDocLike = (v, probeKeys) =>
    !!v &&
    typeof v === 'object' &&
    !(v instanceof mongoose.Types.ObjectId) &&
    typeof v.toHexString !== 'function' &&
    (typeof v.toObject === 'function' || probeKeys.some((k) => k in v));

const loadClass = async (classId, select) => {
    if (!classId) return null;
    if (isDocLike(classId, ['teachers', 'students', 'createdBy'])) return classId; // already a document
    const q = Class.findById(classId);
    if (select) q.select(select);
    return q;
};

/** Returns the class doc or throws 404/403. Teacher must manage it; admin always passes. */
const assertClassManager = async (user, classId, select) => {
    const cls = await loadClass(classId, select);
    if (!cls) throw notFound('Class not found');
    if (!classManagedBy(cls, user)) throw forbidden('You are not assigned to this class');
    return cls;
};

/** Returns the class doc or throws. Manager or enrolled student. */
const assertClassMember = async (user, classId, select) => {
    const cls = await loadClass(classId, select);
    if (!cls) throw notFound('Class not found');
    if (!classAccessibleBy(cls, user)) throw forbidden('You are not a member of this class');
    return cls;
};

/** Class ids a teacher manages (admins: null = all). */
const managedClassIds = async (user) => {
    if (isAdmin(user)) return null;
    if (!isTeacher(user)) return [];
    const rows = await Class.find({ $or: [{ teachers: user._id }, { createdBy: user._id }] }).select('_id').lean();
    return rows.map((r) => r._id);
};

/** Class ids a student is enrolled in. */
const enrolledClassIds = async (user) => {
    if (!isStudent(user)) return [];
    const rows = await Class.find({ students: user._id }).select('_id').lean();
    return rows.map((r) => r._id);
};

/**
 * Teacher may manage a question when they created it, or it is attached to a class they manage.
 * Admins always. Students never.
 */
const canManageQuestion = async (user, question) => {
    if (!user || !question) return false;
    if (isAdmin(user)) return true;
    if (!isTeacher(user)) return false;
    if (idEq(question.createdBy, user._id)) return true;
    const ids = await managedClassIds(user);
    if (!ids.length) return false;
    const owned = new Set(ids.map(String));
    if ((question.classes || []).some((c) => owned.has(idOf(c.classId)))) return true;
    return Boolean(await Class.exists({ _id: { $in: ids }, questions: question._id }));
};

const assertQuestionManager = async (user, questionOrId, select) => {
    const question = isDocLike(questionOrId, ['createdBy', 'classes', 'title'])
        ? questionOrId
        : await (select ? Question.findById(questionOrId).select(select) : Question.findById(questionOrId));
    if (!question) throw notFound('Question not found');
    if (!(await canManageQuestion(user, question))) throw forbidden('You do not manage this question');
    return question;
};

/**
 * A student may see a question only through a class they are enrolled in where it is published.
 * Returns the matching class entry on the question, or throws.
 */
const assertStudentCanViewQuestion = async (user, question, classId) => {
    if (!question) throw notFound('Question not found');
    if (question.isExamOnly) throw forbidden('This question is only available inside its exam');
    const entry = (question.classes || []).find((c) => idEq(c.classId, classId));
    if (!entry) throw httpError(400, 'Question is not associated with this class');
    if (!entry.isPublished) throw forbidden('Question is not published for this class');
    const cls = await Class.findById(classId).select('students').lean();
    if (!cls || !classHasStudent(cls, user)) throw forbidden('You are not enrolled in this class');
    return entry;
};

/** Send an error produced by the helpers above (or any error) as JSON. */
const sendError = (res, err, fallback = 'Server error', tag) => {
    const status = Number(err?.status) || Number(err?.statusCode) || 500;
    if (status >= 500) {
        console.error(`[${tag || 'error'}]`, err?.message || err);
        return res.status(500).json({ error: fallback });
    }
    return res.status(status).json({ error: err.message || fallback });
};

module.exports = {
    idOf,
    idEq,
    httpError,
    forbidden,
    notFound,
    isAdmin,
    isTeacher,
    isStudent,
    isStaff,
    classManagedBy,
    classHasStudent,
    classAccessibleBy,
    assertClassManager,
    assertClassMember,
    managedClassIds,
    enrolledClassIds,
    canManageQuestion,
    assertQuestionManager,
    assertStudentCanViewQuestion,
    sendError,
};
