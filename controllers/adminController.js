const fs = require('fs').promises;
const xlsx = require('xlsx');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Class = require('../models/Class');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Leaderboard = require('../models/Leaderboard');
const Exam = require('../models/Exam');
const ExamAttempt = require('../models/ExamAttempt');
const generatePassword = require('../utils/generatePassword');
const sendEmail = require('../utils/sendEmail');
const { normalizeQuestionRichTextFields } = require('../utils/normalizeRichTextField');
const { parseOptionalPoints } = require('../utils/optionalPoints');
const { applyDefaultSolutions } = require('../utils/buildDefaultSolutions');
const { examPhase } = require('../utils/examPhase');
const mongoose = require('mongoose');
const supportedLanguages = ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'];

// Helper function to validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD || 'Password123!';

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const teacherClassIds = async (user) =>
    (await Class.find({ $or: [{ teachers: user._id }, { createdBy: user._id }] }).select('_id').lean()).map((c) => c._id);

const canAccessClass = async (user, classIdOrDoc) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (user.role !== 'teacher') return false;
    const cls =
        classIdOrDoc && typeof classIdOrDoc === 'object' && (classIdOrDoc.teachers || classIdOrDoc.createdBy)
            ? classIdOrDoc
            : await Class.findById(classIdOrDoc).select('teachers createdBy').lean();
    if (!cls) return false;
    const uid = String(user._id);
    return (
        (cls.teachers || []).some((t) => String(t._id || t) === uid) ||
        String(cls.createdBy?._id || cls.createdBy) === uid
    );
};

const canAccessQuestion = async (user, question) => {
    if (user.role === 'admin') return true;
    if (user.role !== 'teacher' || !question) return false;
    if (String(question.createdBy?._id || question.createdBy) === String(user._id)) return true;
    const classIds = await teacherClassIds(user);
    const owned = new Set(classIds.map(String));
    if ((question.classes || []).some((c) => owned.has(String(c.classId?._id || c.classId)))) return true;
    return Boolean(await Class.exists({ _id: { $in: classIds }, questions: question._id }));
};

function getRowField(entry, aliases) {
    if (!entry) return undefined;
    const normalized = {};
    for (const key of Object.keys(entry)) {
        normalized[key.trim().toLowerCase()] = entry[key];
    }
    for (const alias of aliases) {
        const value = normalized[alias];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return undefined;
}

function parseIdentifiersFromText(text) {
    return [...new Set(
        String(text || '')
            .split(/[\n,;]+/)
            .map((value) => value.trim())
            .filter(Boolean)
    )];
}

function isPhoneIdentifier(value) {
    return /^\+?\d[\d\s-]{6,}$/.test(String(value).trim());
}

async function findExistingStudentsByIdentifiers(identifiers) {
    const unique = [...new Set((identifiers || []).map((value) => String(value).trim()).filter(Boolean))];
    const emails = unique.filter((value) => value.includes('@')).map((value) => value.toLowerCase());
    const numbers = unique.filter((value) => !value.includes('@') && isPhoneIdentifier(value))
        .map((value) => value.replace(/[\s-]/g, ''));
    const names = unique.filter((value) => !value.includes('@') && !isPhoneIdentifier(value));

    const or = [];
    if (emails.length) {
        or.push({ email: { $regex: `^(${emails.map(escapeRegex).join('|')})$`, $options: 'i' } });
    }
    if (names.length) {
        or.push({ name: { $regex: `^(${names.map(escapeRegex).join('|')})$`, $options: 'i' } });
    }
    if (numbers.length) {
        or.push({ number: { $in: numbers } });
    }
    if (!or.length) {
        return { userIds: [], unmatched: unique, ambiguous: [] };
    }

    const users = await User.find({ role: 'student', $or: or }).select('_id email name number');
    const byEmail = new Map();
    const byName = new Map();
    const byNumber = new Map();
    for (const user of users) {
        byEmail.set(String(user.email).toLowerCase(), user);
        const nameKey = String(user.name || '').trim().toLowerCase();
        if (nameKey) {
            if (!byName.has(nameKey)) byName.set(nameKey, []);
            byName.get(nameKey).push(user);
        }
        if (user.number) byNumber.set(String(user.number).replace(/[\s-]/g, ''), user);
    }

    const userIds = [];
    const seen = new Set();
    const unmatched = [];
    const ambiguous = [];
    const addUser = (user) => {
        const id = user._id.toString();
        if (seen.has(id)) return;
        seen.add(id);
        userIds.push(user._id);
    };

    for (const raw of unique) {
        if (raw.includes('@')) {
            const user = byEmail.get(raw.toLowerCase());
            if (user) addUser(user);
            else unmatched.push(raw);
            continue;
        }
        if (isPhoneIdentifier(raw)) {
            const user = byNumber.get(raw.replace(/[\s-]/g, ''));
            if (user) addUser(user);
            else unmatched.push(raw);
            continue;
        }
        const matches = byName.get(raw.toLowerCase()) || [];
        if (matches.length === 1) addUser(matches[0]);
        else if (matches.length > 1) ambiguous.push(raw);
        else unmatched.push(raw);
    }

    return { userIds, unmatched, ambiguous };
}

function nameFromEmail(email) {
    const local = String(email).split('@')[0] || 'student';
    const spaced = local.replace(/[._-]+/g, ' ').replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return spaced.replace(/\b\w/g, (char) => char.toUpperCase()) || 'Student';
}

function parseExcelUserRow(entry) {
    const emailRaw = getRowField(entry, ['email']);
    if (!emailRaw) return null;
    const email = emailRaw.toLowerCase();
    return {
        email,
        name: getRowField(entry, ['name']) || nameFromEmail(email),
        number: getRowField(entry, ['number', 'phone']) || '',
    };
}

/** Case-insensitive email lookup (unique index is exact string; DB may have mixed case). */
async function findUserByEmailInsensitive(email) {
    const trimmed = String(email).trim();
    if (!trimmed) return null;
    return User.findOne({ email: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') } });
}

async function findUsersByEmailsInsensitive(emails) {
    if (!emails.length) return [];
    const pattern = `^(${emails.map(escapeRegex).join('|')})$`;
    return User.find({ email: { $regex: pattern, $options: 'i' } });
}

/**
 * Enroll/create users from Excel rows. Email is required; name and number are optional.
 * Missing accounts are created as `role` with DEFAULT_USER_PASSWORD when SMTP is unset.
 */
async function ensureUsersFromExcelRows(data, role) {
    const parsed = [];
    const seen = new Set();
    const skipped = [];
    const invalid = [];
    const existing = [];

    data.forEach((entry, index) => {
        // Spreadsheet row number as the admin sees it (row 1 is the header).
        const rowNumber = index + 2;
        const row = parseExcelUserRow(entry);
        if (!row) {
            invalid.push({ row: rowNumber, email: '(missing)', reason: 'missing_email' });
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
            invalid.push({ row: rowNumber, email: row.email, reason: 'invalid_email' });
            return;
        }
        if (seen.has(row.email)) {
            skipped.push({ row: rowNumber, email: row.email, reason: 'duplicate_in_file' });
            return;
        }
        seen.add(row.email);
        parsed.push({ ...row, rowNumber });
    });

    const existingUsers = await findUsersByEmailsInsensitive(parsed.map((row) => row.email));
    const existingByEmail = new Map(existingUsers.map((user) => [String(user.email).toLowerCase(), user]));

    const smtpReady = sendEmail.isSmtpConfigured();
    const hashedDefault = await bcrypt.hash(DEFAULT_USER_PASSWORD, 10);
    const userIds = [];
    const created = [];
    const toInsert = [];
    const generatedPasswords = [];

    for (let i = 0; i < parsed.length; i++) {
        const row = parsed[i];
        const existingUser = existingByEmail.get(row.email);
        if (existingUser) {
            if (existingUser.role === role) {
                userIds.push(existingUser._id);
                existing.push({ row: row.rowNumber, email: row.email, name: existingUser.name });
            } else {
                skipped.push({ row: row.rowNumber, email: row.email, reason: 'already_registered', role: existingUser.role });
            }
            continue;
        }

        const password = smtpReady ? generatePassword() : DEFAULT_USER_PASSWORD;
        const hashedPassword = smtpReady ? await bcrypt.hash(password, 10) : hashedDefault;
        toInsert.push({
            name: row.name,
            email: row.email,
            number: row.number || String(9000000000 + i),
            role,
            password: hashedPassword,
            canCreateQuestion: role === 'teacher',
            isBlocked: {},
        });
        generatedPasswords.push({ email: row.email, password });
    }

    if (toInsert.length) {
        const inserted = await User.insertMany(toInsert);
        const rowByEmail = new Map(parsed.map((row) => [row.email, row.rowNumber]));
        for (const user of inserted) {
            userIds.push(user._id);
            created.push({ row: rowByEmail.get(user.email), email: user.email, name: user.name, id: user._id });
        }
    }

    if (smtpReady) {
        for (const cred of generatedPasswords) {
            try {
                await sendEmail(
                    cred.email,
                    'Your Login Credentials',
                    `Email: ${cred.email}\nPassword: ${cred.password}\nRole: ${role}`
                );
            } catch (emailError) {
                console.error('Failed to send email to:', cred.email, emailError.message || emailError);
            }
        }
    } else if (created.length) {
        console.log(`${role} accounts created without SMTP; default password used for ${created.length} new user(s)`);
    }

    return { userIds, created, existing, skipped, invalid, usedDefaultPassword: !smtpReady && created.length > 0 };
}

/** Fields a publish request may never overwrite on a draft. */
const DRAFT_PROTECTED_FIELDS = new Set([
    '_id', 'createdBy', 'createdAt', 'status', 'isDraft', 'publishedAt', 'publishedBy', 'classes', 'examId', 'isExamOnly',
]);

const hasText = (value) => typeof value === 'string' && value.replace(/<[^>]*>/g, '').trim() !== '';

/** Human-readable list of what a draft still needs before it can be published (empty = ready). */
function getDraftIssues(question) {
    const issues = [];
    if (!hasText(question.title)) issues.push('title');
    if (!hasText(question.description)) issues.push('description');
    const options = (question.options || []).filter((o) => hasText(o));
    switch (question.type) {
        case 'singleCorrectMcq':
            if (options.length < 2) issues.push('at least 2 options');
            if (typeof question.correctOption !== 'number') issues.push('correct option');
            break;
        case 'multipleCorrectMcq':
            if (options.length < 2) issues.push('at least 2 options');
            if (!question.correctOptions?.length) issues.push('correct options');
            break;
        case 'fillInTheBlanks':
            if (!hasText(question.correctAnswer)) issues.push('correct answer');
            break;
        case 'coding':
        case 'codingWithDriver':
        case 'fillInTheBlanksCoding':
            if (!question.languages?.length) issues.push('a language');
            if (!question.testCases?.length) issues.push('a test case');
            break;
        default:
            issues.push('question type');
    }
    return issues;
}

// Helper function to validate question data
const validateQuestion = async (questionId) => {
    const question = await Question.findById(questionId);
   
    return question;
};


 exports.uploadExcel = async (req, res) => {
    try {
        if (!req.file?.path) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const role = req.body.role;
        if (!['student', 'teacher'].includes(role)) {
            return res.status(400).json({ error: 'Role must be student or teacher' });
        }

        let data;
        try {
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            data = sheet ? xlsx.utils.sheet_to_json(sheet) : [];
        } catch {
            return res.status(400).json({ error: 'Could not read the file. Save it as .xlsx or .csv and try again.' });
        }

        if (data.length === 0) {
            return res.status(400).json({ error: 'The first sheet has no data rows' });
        }
        const hasEmailColumn = data.some((row) => Object.keys(row).some((key) => key.trim().toLowerCase() === 'email'));
        if (!hasEmailColumn) {
            return res.status(400).json({ error: 'No "email" column found. Add a header row with an email column.' });
        }

        const { created, existing, skipped, invalid, usedDefaultPassword } = await ensureUsersFromExcelRows(data, role);

        const label = role === 'teacher' ? 'teacher' : 'student';
        const plural = (n) => `${n} ${label}${n === 1 ? '' : 's'}`;
        const message = created.length
            ? `${plural(created.length)} added`
            : 'No new accounts were created';

        console.log('uploadExcel: done', { role, rows: data.length, created: created.length, existing: existing.length, skipped: skipped.length, invalid: invalid.length });
        res.status(200).json({
            message,
            role,
            totalRows: data.length,
            created: created.length,
            createdUsers: created.map(({ row, email, name }) => ({ row, email, name })),
            existing,
            skipped,
            invalid,
            defaultPassword: usedDefaultPassword ? DEFAULT_USER_PASSWORD : null,
            credentialsEmailed: created.length > 0 && !usedDefaultPassword,
        });
    } catch (err) {
        console.error('uploadExcel: Error:', err);
        res.status(500).json({ error: 'Something went wrong while importing the file' });
    } finally {
        if (req.file?.path) {
            try {
                await fs.unlink(req.file.path);
            } catch (unlinkErr) {
                console.warn('uploadExcel: Could not delete temp file:', unlinkErr.message);
            }
        }
    }
};

exports.createClass = async (req, res) => {
    try {
        const { name, description } = req.body;
        const user = req.user;

        console.log('createClass: Request received:', { name, description, file: req.file?.path });
        console.log('createClass: User:', { id: user._id, role: user.role, canCreateQuestion: user.canCreateQuestion });

        if (!name) {
            console.log('createClass: Validation failed: Class name is missing');
            return res.status(400).json({ error: 'Class name is required' });
        }

        if (user.role !== 'admin' && !(user.role === 'teacher' && user.canCreateQuestion)) {
            console.log('createClass: Authorization failed: User not allowed to create class');
            return res.status(403).json({ error: 'Unauthorized to create class' });
        }

        const newClass = new Class({
            name,
            description,
            createdBy: user._id,
            students: [],
            teachers: [],
            questions: []
        });
        console.log('createClass: New class object created:', newClass);

        if (req.file) {
            console.log('createClass: Processing Excel file:', req.file.path);
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = xlsx.utils.sheet_to_json(sheet);
            console.log('createClass: Excel rows parsed:', data.length);

            const { userIds, created, skipped, invalid, usedDefaultPassword } = await ensureUsersFromExcelRows(
                data,
                'student'
            );
            console.log('createClass: Excel students resolved:', {
                enrolled: userIds.length,
                created: created.length,
                skipped: skipped.length,
                invalid: invalid.length,
            });

            if (userIds.length === 0) {
                console.log('createClass: Validation failed: No valid student emails in Excel');
                return res.status(400).json({ error: 'No valid student emails found in Excel' });
            }

            newClass.students = userIds;
            console.log('createClass: Students assigned to class:', newClass.students);

            await newClass.save();
            console.log('createClass: Class saved successfully:', newClass._id);

            const parts = [`Class created successfully`, `enrolled ${userIds.length} student(s)`];
            if (created.length) parts.push(`${created.length} newly created`);
            if (usedDefaultPassword) parts.push(`new students can log in with password ${DEFAULT_USER_PASSWORD}`);
            return res.status(201).json({
                message: parts.join('. ') + '.',
                class: newClass,
                created: created.length,
                skipped,
                invalid,
            });
        }

        await newClass.save();
        console.log('createClass: Class saved successfully:', newClass);

        res.status(201).json({ message: 'Class created successfully', class: newClass });
    } catch (err) {
        console.error('createClass: Error:', err);
        res.status(500).json({ error: 'Error creating class' });
    } finally {
        if (req.file?.path) {
            try {
                await fs.unlink(req.file.path);
            } catch (unlinkErr) {
                console.warn('createClass: Could not delete temp file:', unlinkErr.message);
            }
        }
    }
};

exports.manageTeacherPermission = async (req, res) => {
    try {
        const { teacherId, canCreateQuestion } = req.body;
        console.log('manageTeacherPermission: Request received:', { teacherId, canCreateQuestion, userRole: req.user.role });

        if (req.user.role !== 'admin') {
            console.log('manageTeacherPermission: Authorization failed: User is not admin');
            return res.status(403).json({ error: 'Only admins can manage teacher permissions' });
        }

        if (!teacherId || typeof canCreateQuestion !== 'boolean') {
            console.log('manageTeacherPermission: Validation failed: Invalid teacherId or canCreateQuestion');
            return res.status(400).json({ error: 'Teacher ID and canCreateQuestion (boolean) are required' });
        }

        if (!isValidObjectId(teacherId)) {
            return res.status(400).json({ error: 'Invalid teacherId format' });
        }

        const teacher = await User.findById(teacherId);

        if (!teacher || teacher.role !== 'teacher') {
            console.log('manageTeacherPermission: Validation failed: Teacher not found or invalid role');
            return res.status(404).json({ error: 'Teacher not found' });
        }

        teacher.canCreateQuestion = canCreateQuestion;
        await teacher.save();
        console.log('manageTeacherPermission: Teacher updated:', { id: teacher._id, canCreateQuestion });

        const action = canCreateQuestion ? 'granted' : 'revoked';
        console.log(`manageTeacherPermission: Permission ${action} for teacher`);
        res.status(200).json({ message: `Question creation permission ${action} for teacher` });
    } catch (err) {
        console.error('manageTeacherPermission: Error:', err);
        res.status(500).json({ error: 'Error managing teacher permission' });
    }
};


exports.getAllClasses = async (req, res) => {
    try {
        const { search } = req.query;
        const userRole = req.user.role;
        const userId = req.user._id;

        // Build query
        let query = {};
        
        // Filter by role: Teachers and Students should only see their assigned classes
        if (userRole === 'teacher') {
            // Ensure userId is treated as ObjectId for proper MongoDB matching
            query = {
                $or: [
                    { teachers: mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId },
                    { createdBy: mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId }
                ]
            };
        } else if (userRole === 'student') {
            query = {
                students: mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId
            };
        }
        // Admin sees all classes (no additional filter)
        
        // If search parameter is provided, add search filter
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            
            // First, find users whose names match the search
            const matchingUsers = await User.find({ name: searchRegex }).select('_id');
            const matchingUserIds = matchingUsers.map(u => u._id);
            
            // Combine role-based filter with search filter
            const searchFilter = {
                $or: [
                    { name: searchRegex },
                    { createdBy: { $in: matchingUserIds } }
                ]
            };
            
            // Merge search filter with existing query
            if (Object.keys(query).length > 0) {
                query = {
                    $and: [
                        query,
                        searchFilter
                    ]
                };
            } else {
                query = searchFilter;
            }
        }
        
        const classDocs = await Class.find(query)
            .sort({ createdAt: -1 })
            .populate('createdBy', 'name email')
            .populate('students', 'name email')
            .populate('teachers', 'name email')
            .populate('questions', 'title type description points classes');

        const examCounts = await Exam.aggregate([
            { $match: { classId: { $in: classDocs.map((c) => c._id) }, 'template.isTemplate': { $ne: true } } },
            { $group: { _id: '$classId', count: { $sum: 1 } } },
        ]);
        const examCountByClass = new Map(examCounts.map((e) => [e._id.toString(), e.count]));

        const classes = classDocs.map((c) => ({
            ...c.toObject(),
            examCount: examCountByClass.get(c._id.toString()) || 0,
        }));
        res.status(200).json({ classes });
    } catch (err) {
        console.error('getAllClasses: Error:', err);
        res.status(500).json({ error: 'Error fetching classes' });
    }
};

exports.getAllTeachers = async (req, res) => {
    try {
        const { search } = req.query;
        let query = { role: 'teacher' };

        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query = {
                role: 'teacher',
                $or: [
                    { name: searchRegex },
                    { email: searchRegex }
                ]
            };
        }

        const teacherDocs = await User.find(query).select('name email canCreateQuestion').sort({ name: 1 }).lean();
        if (req.user.role !== 'admin' || teacherDocs.length === 0) {
            return res.status(200).json({ teachers: teacherDocs });
        }

        const teacherIds = teacherDocs.map((t) => t._id);
        const [classDocs, questionCounts] = await Promise.all([
            Class.find({ teachers: { $in: teacherIds } }).select('name status teachers').lean(),
            Question.aggregate([
                { $match: { createdBy: { $in: teacherIds }, status: { $ne: 'archived' } } },
                { $group: { _id: '$createdBy', count: { $sum: 1 } } },
            ]),
        ]);
        const questionCountBy = new Map(questionCounts.map((q) => [q._id.toString(), q.count]));

        const teachers = teacherDocs.map((t) => {
            const id = t._id.toString();
            return {
                ...t,
                classes: classDocs
                    .filter((c) => c.teachers.some((tid) => tid.toString() === id))
                    .map(({ _id, name, status }) => ({ _id, name, status })),
                questionCount: questionCountBy.get(id) || 0,
            };
        });
        res.status(200).json({ teachers });
    } catch (err) {
        console.error('getAllTeachers: Error:', err);
        res.status(500).json({ error: 'Error fetching teachers' });
    }
};

/**
 * Remove a teacher account from the teacher list only.
 * Does not delete classes, questions, exams, submissions, or other related records.
 */
exports.deleteTeacher = async (req, res) => {
    console.log('[Delete Teacher] Deleting teacher:', req.params.teacherId);
    try {
        const { teacherId } = req.params;
        const user = req.user;

        if (!['admin'].includes(user.role)) {
            console.warn('[Delete Teacher] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can delete teachers' });
        }

        if (!isValidObjectId(teacherId)) {
            console.error('[Delete Teacher] Error: Invalid teacherId');
            return res.status(400).json({ error: 'Valid teacherId is required' });
        }

        const teacher = await User.findById(teacherId);
        if (!teacher) {
            console.error('[Delete Teacher] Error: Teacher not found');
            return res.status(404).json({ error: 'Teacher not found' });
        }

        if (teacher.role !== 'teacher') {
            console.error('[Delete Teacher] Error: User is not a teacher');
            return res.status(400).json({ error: 'User is not a teacher' });
        }

        // Unassign from class teacher lists only — keep classes and created content.
        await Class.updateMany(
            { teachers: teacherId },
            { $pull: { teachers: teacherId } }
        );

        await teacher.deleteOne();

        console.log('[Delete Teacher] Teacher removed from list:', teacherId);
        res.status(200).json({ message: 'Teacher deleted successfully' });
    } catch (err) {
        console.error('[Delete Teacher] Error:', err.message);
        res.status(500).json({ error: 'Error deleting teacher' });
    }
};

exports.getAllStudents = async (req, res) => {
    try {
        const { search } = req.query;
        let query = { role: 'student' };

        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query = {
                role: 'student',
                $or: [
                    { name: searchRegex },
                    { email: searchRegex },
                    { number: searchRegex }
                ]
            };
        }

        const studentDocs = await User.find(query).select('name email number isBlocked').sort({ name: 1 }).lean();
        if (studentDocs.length === 0) return res.status(200).json({ students: [] });

        const studentIds = studentDocs.map((s) => s._id);
        const [classDocs, activity] = await Promise.all([
            Class.find({ students: { $in: studentIds } }).select('name status students').lean(),
            Submission.aggregate([
                { $match: { studentId: { $in: studentIds } } },
                {
                    $group: {
                        _id: '$studentId',
                        submits: { $sum: { $cond: ['$isRun', 0, 1] } },
                        lastActiveAt: { $max: '$submittedAt' },
                    },
                },
            ]),
        ]);
        const activityBy = new Map(activity.map((a) => [a._id.toString(), a]));

        const students = studentDocs.map(({ isBlocked, ...s }) => {
            const id = s._id.toString();
            const blocked = isBlocked || {};
            const classes = classDocs
                .filter((c) => c.students.some((sid) => sid.toString() === id))
                .map(({ _id, name, status }) => ({ _id, name, status, isBlocked: Boolean(blocked[_id.toString()]) }));
            const stats = activityBy.get(id);
            return {
                ...s,
                classes,
                submissionCount: stats?.submits || 0,
                lastActiveAt: stats?.lastActiveAt || null,
            };
        });
        res.status(200).json({ students });
    } catch (err) {
        console.error('getAllStudents: Error:', err);
        res.status(500).json({ error: 'Error fetching students' });
    }
};

exports.getStudentsByClass = async (req, res) => {
    try {
        const { classId } = req.params;
        const userRole = req.user.role;
        const userId = req.user._id;
        console.log('[getStudentsByClass] Request received:', { classId, user: { id: userId, role: userRole } });

        if (!isValidObjectId(classId)) {
            console.error('[getStudentsByClass] Validation failed: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId)
            .populate('students', 'name email number isBlocked')
            .populate('teachers', '_id');
        if (!classData) {
            console.error('[getStudentsByClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        // Authorization: Admin can see all, Teacher can only see students in classes they're assigned to
        if (userRole === 'teacher') {
            const isAssignedTeacher = classData.teachers.some(t => String(t._id) === String(userId));
            const isCreator = String(classData.createdBy) === String(userId);
            
            if (!isAssignedTeacher && !isCreator) {
                console.error('[getStudentsByClass] Authorization failed: Teacher not assigned to class');
                return res.status(403).json({ error: 'Unauthorized: You are not assigned to this class' });
            }
            console.log('[getStudentsByClass] Teacher authorized:', { isAssignedTeacher, isCreator });
        } else if (userRole !== 'admin' && userRole !== 'student') {
            console.error('[getStudentsByClass] Authorization failed: Invalid role');
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const students = classData.students.map((student) => ({
            _id: student._id,
            name: student.name,
            email: student.email,
            number: student.number,
            isBlocked: student.isBlocked?.get?.(classId.toString()) || false,
        }));

        console.log('[getStudentsByClass] Students fetched:', students.length, 'for role:', userRole);
        res.status(200).json({ students });
    } catch (err) {
        console.error('[getStudentsByClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error fetching students for class' });
    }
};

exports.getTeachersByClass = async (req, res) => {
    try {
        const { classId } = req.params;
        console.log('[getTeachersByClass] Request received:', { classId, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId)) {
            console.error('[getTeachersByClass] Validation failed: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId)
            .populate('teachers', 'name email canCreateQuestion');
        if (!classData) {
            console.error('[getTeachersByClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        console.log('[getTeachersByClass] Teachers fetched:', classData.teachers.length);
        res.status(200).json({ teachers: classData.teachers });
    } catch (err) {
        console.error('[getTeachersByClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error fetching teachers for class' });
    }
};

exports.assignTeacherToClass = async (req, res) => {
    try {
        const { classId, teacherId } = req.body;
        console.log('[assignTeacherToClass] Request received:', { classId, teacherId, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId) || !isValidObjectId(teacherId)) {
            console.error('[assignTeacherToClass] Validation failed: Invalid classId or teacherId');
            return res.status(400).json({ error: 'Valid class ID and teacher ID are required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[assignTeacherToClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const teacher = await User.findById(teacherId);
        if (!teacher || teacher.role !== 'teacher') {
            console.error('[assignTeacherToClass] Validation failed: Teacher not found or invalid role');
            return res.status(404).json({ error: 'Teacher not found' });
        }

        if (classData.teachers.some((id) => String(id) === String(teacherId))) {
            console.error('[assignTeacherToClass] Validation failed: Teacher already assigned');
            return res.status(400).json({ error: 'Teacher already assigned to class' });
        }

        classData.teachers.push(teacherId);
        await classData.save();
        console.log('[assignTeacherToClass] Teacher assigned:', teacherId);

        res.status(200).json({ message: 'Teacher assigned to class', class: classData });
    } catch (err) {
        console.error('[assignTeacherToClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error assigning teacher to class' });
    }
};

exports.removeTeacherFromClass = async (req, res) => {
    try {
        const { classId, teacherId } = req.body.data || req.body;
        console.log('[removeTeacherFromClass] Request received:', { classId, teacherId, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId) || !isValidObjectId(teacherId)) {
            console.error('[removeTeacherFromClass] Validation failed: Invalid classId or teacherId');
            return res.status(400).json({ error: 'Valid class ID and teacher ID are required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[removeTeacherFromClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (!classData.teachers.some((id) => String(id) === String(teacherId))) {
            console.error('[removeTeacherFromClass] Validation failed: Teacher not assigned');
            return res.status(400).json({ error: 'Teacher not assigned to class' });
        }

        classData.teachers = classData.teachers.filter(id => id.toString() !== teacherId.toString());
        await classData.save();
        console.log('[removeTeacherFromClass] Teacher removed:', teacherId);

        res.status(200).json({ message: 'Teacher removed from class', class: classData });
    } catch (err) {
        console.error('[removeTeacherFromClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error removing teacher from class' });
    }
};

exports.removeStudentFromClass = async (req, res) => {
    try {
        const { classId, studentId } = req.body.data || req.body;
        console.log('[removeStudentFromClass] Request received:', { classId, studentId, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId) || !isValidObjectId(studentId)) {
            console.error('[removeStudentFromClass] Validation failed: Invalid classId or studentId');
            return res.status(400).json({ error: 'Valid class ID and student ID are required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[removeStudentFromClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }
        if (!(await canAccessClass(req.user, classData))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }

        if (!classData.students.some((id) => String(id) === String(studentId))) {
            console.error('[removeStudentFromClass] Validation failed: Student not enrolled');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        classData.students = classData.students.filter(id => id.toString() !== studentId.toString());
        await classData.save();
        console.log('[removeStudentFromClass] Student removed:', studentId);

        // Remove student-related data
        await Promise.all([
            Submission.deleteMany({ classId, studentId }),
            Leaderboard.deleteMany({ classId, studentId }),
            User.updateOne({ _id: studentId }, { $unset: { [`isBlocked.${classId}`]: '' } }),
        ]);
        console.log('[removeStudentFromClass] Cleared submissions and leaderboard for student:', studentId);

        res.status(200).json({ message: 'Student removed from class', class: classData });
    } catch (err) {
        console.error('[removeStudentFromClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error removing student from class' });
    }
};

exports.editClass = async (req, res) => {
    try {
        const { classId } = req.params;
        const { name, description, studentIds, teacherIds, questionIds } = req.body;
        console.log('[editClass] Request received:', { classId, name, description, studentIds, teacherIds, questionIds, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId)) {
            console.error('[editClass] Validation failed: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[editClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }
        if (!(await canAccessClass(req.user, classData))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }
        if (req.user.role !== 'admin' && (studentIds || teacherIds || questionIds)) {
            return res.status(403).json({ error: 'Teachers can only update class name and description' });
        }

        if (name !== undefined) {
            const trimmedName = String(name).trim();
            if (!trimmedName) return res.status(400).json({ error: 'Class name cannot be empty' });
            classData.name = trimmedName;
        }
        if (typeof description === 'string') classData.description = description.trim();

        if (studentIds && Array.isArray(studentIds)) {
            if (!studentIds.every(isValidObjectId)) {
                console.error('[editClass] Validation failed: Invalid studentIds');
                return res.status(400).json({ error: 'Invalid student IDs' });
            }
            const students = await User.find({ _id: { $in: studentIds }, role: 'student' }).select('_id');
            if (students.length === 0) {
                console.error('[editClass] Validation failed: No valid students found');
                return res.status(400).json({ error: 'No valid students found' });
            }
            const newStudentIds = students.map(student => student._id.toString());
            const uniqueStudentIds = newStudentIds.filter(id => !classData.students.includes(id));
            classData.students.push(...uniqueStudentIds);
            console.log('[editClass] Students added:', uniqueStudentIds.length);
        }

        if (teacherIds && Array.isArray(teacherIds)) {
            if (!teacherIds.every(isValidObjectId)) {
                console.error('[editClass] Validation failed: Invalid teacherIds');
                return res.status(400).json({ error: 'Invalid teacher IDs' });
            }
            const teachers = await User.find({ _id: { $in: teacherIds }, role: 'teacher' }).select('_id');
            if (teachers.length === 0) {
                console.error('[editClass] Validation failed: No valid teachers found');
                return res.status(400).json({ error: 'No valid teachers found' });
            }
            const newTeacherIds = teachers.map(teacher => teacher._id.toString());
            const uniqueTeacherIds = newTeacherIds.filter(id => !classData.teachers.includes(id));
            classData.teachers.push(...uniqueTeacherIds);
            console.log('[editClass] Teachers added:', uniqueTeacherIds.length);
        }

        if (questionIds && Array.isArray(questionIds)) {
            if (!questionIds.every(isValidObjectId)) {
                console.error('[editClass] Validation failed: Invalid questionIds');
                return res.status(400).json({ error: 'Invalid question IDs' });
            }
            const questions = await Promise.all(questionIds.map(async (qid) => {
                try {
                    return await validateQuestion(qid);
                } catch (err) {
                    console.error('[editClass] Question validation failed:', qid, err.message);
                    throw new Error(`Invalid question ${qid}: ${err.message}`);
                }
            }));
            if (questions.length === 0) {
                console.error('[editClass] Validation failed: No valid questions found');
                return res.status(400).json({ error: 'No valid questions found' });
            }
            for (const question of questions) {
                if (!question.classes.some(c => c.classId.toString() === classId)) {
                    question.classes.push({ classId, isPublished: false, isDisabled: false });
                    await question.save();
                }
                if (!classData.questions.includes(question._id)) {
                    classData.questions.push(question._id);
                }
            }
            console.log('[editClass] Questions added:', questionIds.length);
        }

        await classData.save();
        console.log('[editClass] Class updated:', classData._id);

        const updatedClass = await Class.findById(classId)
            .populate('createdBy', 'name email')
            .populate('students', 'name email')
            .populate('teachers', 'name email')
            .populate('questions', 'title type description points classes');

        res.status(200).json({ message: 'Class updated successfully', class: updatedClass });
    } catch (err) {
        console.error('[editClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error updating class' });
    }
};

exports.addStudentsToClass = async (req, res) => {
    try {
        const { classId } = req.params;
        if (!isValidObjectId(classId)) {
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            return res.status(404).json({ error: 'Class not found' });
        }
        if (!(await canAccessClass(req.user, classData))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }

        let emailRows = [];
        const identifiers = parseIdentifiersFromText(req.body.emails);
        if (req.file) {
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = xlsx.utils.sheet_to_json(sheet);
            for (const entry of data) {
                const email = getRowField(entry, ['email']);
                if (email) {
                    emailRows.push(entry);
                    continue;
                }
                const name = getRowField(entry, ['name']);
                const number = getRowField(entry, ['number', 'phone']);
                if (name) identifiers.push(name);
                if (number) identifiers.push(number);
            }
        }

        if (emailRows.length === 0 && identifiers.length === 0) {
            return res.status(400).json({ error: 'Upload an Excel file or paste student emails / names' });
        }

        const userIds = [];
        let created = [];
        let skipped = [];
        let invalid = [];
        let usedDefaultPassword = false;

        if (emailRows.length) {
            const fromExcel = await ensureUsersFromExcelRows(emailRows, 'student');
            userIds.push(...fromExcel.userIds);
            created = fromExcel.created;
            skipped = fromExcel.skipped;
            invalid = fromExcel.invalid;
            usedDefaultPassword = fromExcel.usedDefaultPassword;
        }

        const fromIdentifiers = await findExistingStudentsByIdentifiers(identifiers);
        userIds.push(...fromIdentifiers.userIds);

        if (userIds.length === 0) {
            return res.status(400).json({
                error: 'No matching students found. Paste emails, exact names, or phone numbers from Data Import.',
                skipped,
                invalid,
                unmatched: fromIdentifiers.unmatched,
                ambiguous: fromIdentifiers.ambiguous,
            });
        }

        const existingSet = new Set(classData.students.map((id) => id.toString()));
        let addedCount = 0;
        let alreadyInClass = 0;
        for (const id of userIds) {
            const sid = id.toString();
            if (existingSet.has(sid)) {
                alreadyInClass += 1;
                continue;
            }
            classData.students.push(id);
            existingSet.add(sid);
            addedCount += 1;
        }
        await classData.save();

        const parts = [`Added ${addedCount} student(s) to the class`];
        if (alreadyInClass) parts.push(`${alreadyInClass} already enrolled`);
        if (created.length) parts.push(`${created.length} newly created`);
        if (fromIdentifiers.unmatched.length) parts.push(`${fromIdentifiers.unmatched.length} not found`);
        if (fromIdentifiers.ambiguous.length) parts.push(`${fromIdentifiers.ambiguous.length} name(s) matched more than one student — use email for those`);
        if (usedDefaultPassword) parts.push(`new students can log in with password ${DEFAULT_USER_PASSWORD}`);

        res.status(200).json({
            message: parts.join('. ') + '.',
            added: addedCount,
            alreadyInClass,
            created: created.length,
            skipped,
            invalid,
            unmatched: fromIdentifiers.unmatched,
            ambiguous: fromIdentifiers.ambiguous,
        });
    } catch (err) {
        console.error('[addStudentsToClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error adding students to class' });
    } finally {
        if (req.file?.path) {
            try {
                await fs.unlink(req.file.path);
            } catch (unlinkErr) {
                console.warn('[addStudentsToClass] Could not delete temp file:', unlinkErr.message);
            }
        }
    }
};

exports.changeClassStatus = async (req, res) => {
    try {
        const { classId } = req.params;
        const { status } = req.body;
        console.log('changeClassStatus: Request received:', { classId, status, user: { id: req.user._id, role: req.user.role } });

        if (!['active', 'inactive'].includes(status)) {
            return res.status(400).json({ error: 'Status must be active or inactive' });
        }
        if (!isValidObjectId(classId)) {
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId);

        if (!classData) {
            console.log('changeClassStatus: Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }
        if (!(await canAccessClass(req.user, classData))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }

        classData.status = status;
        await classData.save();

        res.status(200).json({ message: `Class status changed to ${status}`, class: classData });
    } catch (err) {
        console.error('changeClassStatus: Error:', err);
        res.status(500).json({ error: 'Error changing class status' });
    }
};

exports.deleteClass = async (req, res) => {
    try {
        const { classId } = req.params;
        console.log('[deleteClass] Request received:', { classId, user: { id: req.user._id, role: req.user.role } });

        if (req.user.role !== 'admin') {
            console.error('[deleteClass] Authorization failed: User is not admin');
            return res.status(403).json({ error: 'Unauthorized: Admins only' });
        }

        if (!isValidObjectId(classId)) {
            console.error('[deleteClass] Validation failed: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[deleteClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        await Question.updateMany(
            { 'classes.classId': classId },
            { $pull: { classes: { classId } } }
        );
        const examIds = await Exam.find({ classId }).distinct('_id');
        await Promise.all([
            Submission.deleteMany({ classId }),
            Leaderboard.deleteMany({ classId }),
            ExamAttempt.deleteMany({ examId: { $in: examIds } }),
            Exam.deleteMany({ _id: { $in: examIds } }),
            User.updateMany({ [`isBlocked.${classId}`]: { $exists: true } }, { $unset: { [`isBlocked.${classId}`]: '' } }),
        ]);
        await Class.deleteOne({ _id: classId });
        console.log('[deleteClass] Class and related data deleted:', classId);

        res.status(200).json({ message: 'Class deleted successfully' });
    } catch (err) {
        console.error('[deleteClass] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error deleting class' });
    }
};

exports.getClassDetails = async (req, res) => {
    try {
        const { classId } = req.params;
        if (!isValidObjectId(classId)) {
            return res.status(400).json({ error: 'Invalid class ID' });
        }

        const classData = await Class.findById(classId)
            .populate('teachers', 'name email canCreateQuestion')
            .populate('createdBy', 'name email')
            .populate('students', 'name email')
            .populate('questions', 'title type description points classes')
            .lean();
        console.log('getClassDetails: Class lookup:', classData ? { id: classData._id, name: classData.name } : 'Not found');

        if (!classData) {
            console.log('getClassDetails: Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        console.log('getClassDetails: Class data fetched:', {
            id: classData._id,
            name: classData.name,
            teachers: classData.teachers.length,
            students: classData.students.length,
        });
        res.status(200).json({ class: classData });
    } catch (err) {
        console.error('getClassDetails: Error:', err);
        res.status(500).json({ error: 'Error fetching class details' });
    }
};

exports.getQuestionSummary = async (req, res) => {
    try {
        const { classId } = req.params;
        const user = req.user;
        if (!['admin', 'teacher'].includes(user.role)) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        const classData = await Class.findById(classId);
        if (!classData) return res.status(404).json({ error: 'Class not found' });
        if (user.role === 'teacher' && !classData.teachers.some(t => t.toString() === user._id.toString()) && classData.createdBy?.toString() !== user._id.toString()) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }
        const questions = await Question.find({ 'classes.classId': classId }).select('_id title type');
        const summaries = await Promise.all(questions.map(async (q) => {
            const subs = await Submission.aggregate([
                { $match: { questionId: q._id, classId: new mongoose.Types.ObjectId(classId), isRun: false } },
                { $sort: { submittedAt: -1 } },
                { $group: { _id: '$studentId', latestCorrect: { $first: '$isCorrect' } } },
                { $group: {
                    _id: null,
                    attempted: { $sum: 1 },
                    successful: { $sum: { $cond: ['$latestCorrect', 1, 0] } }
                } }
            ]);
            const s = subs[0] || { attempted: 0, successful: 0 };
            return {
                questionId: q._id,
                title: q.title,
                type: q.type,
                attempted: s.attempted,
                successful: s.successful,
                unsuccessful: (s.attempted || 0) - (s.successful || 0)
            };
        }));
        res.status(200).json({ summaries });
    } catch (err) {
        console.error('getQuestionSummary Error:', err);
        res.status(500).json({ error: 'Error fetching question summary' });
    }
};

exports.getParticipantStats = async (req, res) => {
    try {
        const { classId } = req.params;
        console.log('getParticipantStats: Request received:', { classId, user: { id: req.user._id, role: req.user.role } });

        const classData = await Class.findById(classId).populate('students', 'name email');
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const leaderboards = await Leaderboard.find({ classId })
            .populate('studentId', 'name email')
            .lean();

        const totalParticipants = classData.students.length;
        const activityStats = {
            inactive: 0,
            active: 0,
            focused: 0,
        };
        let totalCorrectAttempts = 0;
        let totalWrongAttempts = 0;

        leaderboards.forEach(entry => {
            activityStats[entry.activityStatus]++;
            totalCorrectAttempts += entry.correctAttempts;
            totalWrongAttempts += entry.wrongAttempts;
        });

        const totalAttempts = totalCorrectAttempts + totalWrongAttempts;
        const stats = {
            totalParticipants,
            activityStats,
            activityPercentage: {
                inactive: totalParticipants ? (activityStats.inactive / totalParticipants * 100).toFixed(1) : 0,
                active: totalParticipants ? (activityStats.active / totalParticipants * 100).toFixed(1) : 0,
                focused: totalParticipants ? (activityStats.focused / totalParticipants * 100).toFixed(1) : 0,
            },
            totalCorrectAttempts,
            totalWrongAttempts,
            correctPercentage: totalAttempts ? (totalCorrectAttempts / totalAttempts * 100).toFixed(1) : 0,
        };

        console.log('getParticipantStats: Stats retrieved:', stats);
        res.status(200).json({ stats });
    } catch (err) {
        console.error('getParticipantStats: Error:', err);
        res.status(500).json({ error: 'Error retrieving participant stats' });
    }
};

exports.getRunSubmitStats = async (req, res) => {
    try {
        const { classId } = req.params;
        console.log('getRunSubmitStats: Request received:', { classId, user: { id: req.user._id, role: req.user.role } });

        const classData = await Class.findById(classId).lean();
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const leaderboards = await Leaderboard.find({ classId })
            .populate('studentId', 'name email')
            .lean();

        const studentStats = leaderboards.map(entry => ({
            student: { id: entry.studentId._id, name: entry.studentId.name, email: entry.studentId.email },
            totalRuns: entry.totalRuns,
            totalSubmissions: entry.totalSubmits,
        }));

        const stats = {
            classTotalRuns: classData.totalRuns,
            classTotalSubmits: classData.totalSubmits,
            studentStats,
        };

        console.log('getRunSubmitStats: Stats retrieved:', stats);
        res.status(200).json({ stats });
    } catch (err) {
        console.error('getRunSubmitStats: Error:', err);
        res.status(500).json({ error: 'Error retrieving run/submit stats' });
    }
};

exports.createAssignment = async (req, res) => {
    try {
        const { classId } = req.params;
        const { questionId, dueDate, maxPoints } = req.body;
        console.log('[createAssignment] Request received:', { classId, questionId, dueDate, maxPoints, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId) || !isValidObjectId(questionId)) {
            console.error('[createAssignment] Validation failed: Invalid classId or questionId');
            return res.status(400).json({ error: 'Valid class ID and question ID are required' });
        }

        
        if (dueDate) {
            const parsedDueDate = new Date(dueDate);
            if (isNaN(parsedDueDate) || parsedDueDate <= new Date()) {
                console.error('[createAssignment] Validation failed: Invalid or past dueDate');
                return res.status(400).json({ error: 'dueDate must be a valid future date' });
            }
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[createAssignment] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        let question;
        try {
            question = await validateQuestion(questionId);
        } catch (err) {
            console.error('[createAssignment] Question validation failed:', err.message);
            return res.status(400).json({ error: err.message });
        }

        if (!classData.questions.some((id) => String(id) === String(questionId))) {
            console.error('[createAssignment] Validation failed: Question not associated with class');
            return res.status(400).json({ error: 'Question is not associated with this class' });
        }

        if (classData.assignments.some((a) => String(a.questionId) === String(questionId))) {
            return res.status(409).json({ error: 'This question already has a deadline. Clear it before setting a new one.' });
        }

        const assignment = {
            questionId,
            assignedAt: new Date(),
            dueDate: dueDate ? new Date(dueDate) : undefined,
            maxPoints: parseOptionalPoints(maxPoints),
        };

        classData.assignments.push(assignment);
        await classData.save();
        console.log('[createAssignment] Assignment created:', assignment);

        req.io.to(`class:${classId}`).emit('assignmentCreated', { classId, assignment });
        res.status(201).json({ message: 'Assignment created successfully', assignment });
    } catch (err) {
        console.error('[createAssignment] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error creating assignment' });
    }
};

exports.getAssignments = async (req, res) => {
    try {
        const { classId } = req.params;
        const classData = await Class.findById(classId)
            .populate('assignments.questionId', 'title type difficulty')
            .lean();
        if (!classData) return res.status(404).json({ error: 'Class not found' });

        if (req.user.role === 'student') {
            const enrolled = (classData.students || []).some((s) => String(s._id || s) === String(req.user._id));
            if (!enrolled) return res.status(403).json({ error: 'You are not enrolled in this class' });
        } else if (req.user.role === 'teacher' && !(await canAccessClass(req.user, classData))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }

        res.status(200).json({ assignments: classData.assignments || [] });
    } catch (err) {
        console.error('getAssignments: Error:', err);
        res.status(500).json({ error: 'Error retrieving assignments' });
    }
};

exports.deleteAssignment = async (req, res) => {
    try {
        const { classId, assignmentId } = req.params;
        console.log('[deleteAssignment] Request received:', { classId, assignmentId, user: { id: req.user._id, role: req.user.role } });

        if (!isValidObjectId(classId) || !isValidObjectId(assignmentId)) {
            console.error('[deleteAssignment] Validation failed: Invalid classId or assignmentId');
            return res.status(400).json({ error: 'Valid class ID and assignment ID are required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[deleteAssignment] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const assignmentIndex = classData.assignments.findIndex(a => a._id.toString() === assignmentId);
        if (assignmentIndex === -1) {
            console.error('[deleteAssignment] Validation failed: Assignment not found');
            return res.status(404).json({ error: 'Assignment not found' });
        }

        classData.assignments.splice(assignmentIndex, 1);
        await classData.save();
        console.log('[deleteAssignment] Assignment deleted:', assignmentId);

        req.io.to(`class:${classId}`).emit('assignmentDeleted', { classId, assignmentId });
        res.status(200).json({ message: 'Assignment deleted successfully' });
    } catch (err) {
        console.error('[deleteAssignment] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error deleting assignment' });
    }
};

exports.blockUser = async (req, res) => {
    try {
        const { classId } = req.params;
        const { studentId, isBlocked } = req.body;
        console.log('blockUser: Request received:', { classId, studentId, isBlocked, user: { id: req.user._id, role: req.user.role } });

        if (!studentId || typeof isBlocked !== 'boolean') {
            console.log('Error: Missing or invalid fields');
            return res.status(400).json({ error: 'Student ID and isBlocked (boolean) are required' });
        }

        if (!mongoose.Types.ObjectId.isValid(classId) || !mongoose.Types.ObjectId.isValid(studentId)) {
            return res.status(400).json({ error: 'Invalid classId or studentId' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const studentObjectId = new mongoose.Types.ObjectId(studentId);
        const isEnrolled = classData.students.some((id) => String(id) === String(studentId));
        if (!isEnrolled) {
            console.log('Error: Student not enrolled in class', { studentId, students: classData.students.map(String) });
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        const student = await User.findById(studentObjectId);
        if (!student || student.role !== 'student') {
            console.log('Error: Student not found or invalid role');
            return res.status(404).json({ error: 'Student not found' });
        }

        if (!student.isBlocked) {
            student.isBlocked = new Map();
        }
        student.isBlocked.set(String(classId), isBlocked);
        await student.save();

        req.io.to(`class:${classId}`).emit('userBlocked', { classId, studentId: String(studentId), isBlocked });
        req.io.to(`class:${classId}`).emit('studentBlockStatusUpdated', {
            classId,
            studentId: String(studentId),
            isBlocked,
            studentName: student.name,
            studentEmail: student.email,
        });
        console.log('blockUser:', isBlocked ? 'Blocked' : 'Unblocked', 'student:', studentId);

        res.status(200).json({ message: `Student ${isBlocked ? 'blocked' : 'unblocked'} successfully` });
    } catch (err) {
        console.error('blockUser: Error:', err);
        res.status(500).json({ error: 'Error updating block status' });
    }
};

exports.blockAllUsers = async (req, res) => {
    try {
        const { classId } = req.params;
        const { isBlocked, onlyInactive, studentIds } = req.body;
        if (!isValidObjectId(classId)) {
            return res.status(400).json({ error: 'Invalid class ID' });
        }

        if (typeof isBlocked !== 'boolean') {
            console.log('Error: Invalid isBlocked field');
            return res.status(400).json({ error: 'isBlocked (boolean) is required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        let targetStudentIds = classData.students.map((id) => String(id));

        // Optional: only block specific student IDs (e.g. not-attempted from question stats)
        if (Array.isArray(studentIds) && studentIds.length > 0) {
            const allowed = new Set(targetStudentIds);
            targetStudentIds = studentIds.map(String).filter((id) => allowed.has(id));
        } else if (onlyInactive) {
            // Block only inactive students (no submissions / activityStatus inactive)
            const Leaderboard = require('../models/Leaderboard');
            const entries = await Leaderboard.find({ classId }).select('studentId activityStatus totalSubmits').lean();
            const activeIds = new Set(
                entries
                    .filter((e) => (e.activityStatus && e.activityStatus !== 'inactive') || (e.totalSubmits || 0) > 0)
                    .map((e) => String(e.studentId))
            );
            targetStudentIds = targetStudentIds.filter((id) => !activeIds.has(id));
        }

        if (targetStudentIds.length === 0) {
            return res.status(200).json({ message: 'No matching students to update', updated: 0 });
        }

        await User.updateMany(
            { _id: { $in: targetStudentIds }, role: 'student' },
            { $set: { [`isBlocked.${classId}`]: isBlocked } }
        );

        req.io.to(`class:${classId}`).emit('allUsersBlocked', { classId, isBlocked, onlyInactive: !!onlyInactive });
        req.io.to(`class:${classId}`).emit('studentBlockStatusUpdated', { classId, isBlocked, onlyInactive: !!onlyInactive });
        console.log('blockAllUsers:', isBlocked ? 'Blocked' : 'Unblocked', 'students:', targetStudentIds.length);

        res.status(200).json({
            message: `${targetStudentIds.length} student(s) ${isBlocked ? 'blocked' : 'unblocked'} successfully`,
            updated: targetStudentIds.length,
        });
    } catch (err) {
        console.error('blockAllUsers: Error:', err);
        res.status(500).json({ error: 'Error updating block status' });
    }
};

exports.searchLeaderboard = async (req, res) => {
    try {
        const { classId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            console.log('searchLeaderboard: Error: Invalid classId format');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId).select('_id');
        if (!classData) {
            console.log('searchLeaderboard: Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        let query = { classId: new mongoose.Types.ObjectId(classId) };
        const { name, activityStatus, minCorrectAttempts, maxAttempts } = req.query;

        if (activityStatus) {
            if (!['inactive', 'active', 'focused'].includes(activityStatus)) {
                console.log('searchLeaderboard: Error: Invalid activity status');
                return res.status(400).json({ error: 'Invalid activity status' });
            }
            query.activityStatus = activityStatus;
        }

        if (minCorrectAttempts && !isNaN(parseInt(minCorrectAttempts, 10))) {
            query.correctAttempts = { $gte: parseInt(minCorrectAttempts, 10) };
        } else if (minCorrectAttempts) {
            console.log('searchLeaderboard: Error: Invalid minCorrectAttempts');
            return res.status(400).json({ error: 'minCorrectAttempts must be a number' });
        }

        if (maxAttempts && !isNaN(parseInt(maxAttempts, 10))) {
            query['$expr'] = {
                $lte: [
                    { $add: ['$correctAttempts', '$wrongAttempts'] },
                    parseInt(maxAttempts, 10),
                ],
            };
        } else if (maxAttempts) {
            console.log('searchLeaderboard: Error: Invalid maxAttempts');
            return res.status(400).json({ error: 'maxAttempts must be a number' });
        }

        let leaderboard = await Leaderboard.find(query)
            .populate('studentId', 'name email isBlocked')
            .lean();

        if (name) {
            const pattern = new RegExp(escapeRegex(String(name).trim()), 'i');
            leaderboard = leaderboard.filter((entry) => pattern.test(entry.studentId?.name || ''));
        }

        // Add isBlocked status from User model to each leaderboard entry
        leaderboard = leaderboard.map(entry => {
            const isBlockedForClass = entry.studentId?.isBlocked ? (entry.studentId.isBlocked[classId] || false) : false;
            return {
                ...entry,
                isBlocked: isBlockedForClass
            };
        });

        res.status(200).json({ leaderboard });
    } catch (err) {
        console.error('searchLeaderboard: Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error searching leaderboard', details: err.message });
    }
};

exports.blockUnblockStudent = async (req, res) => {
    try {
        const { classId } = req.params;
        const { studentId, isBlocked } = req.body;
        console.log('[blockUnblockStudent] Request received:', { classId, studentId, isBlocked, user: { id: req.user._id, role: req.user.role } });

        if (!['admin', 'teacher'].includes(req.user.role)) {
            console.error('[blockUnblockStudent] Authorization failed: User not authorized');
            return res.status(403).json({ error: 'Only admins or teachers can block/unblock students' });
        }

        if (!isValidObjectId(classId) || !isValidObjectId(studentId) || typeof isBlocked !== 'boolean') {
            console.error('[blockUnblockStudent] Validation failed: Invalid classId, studentId, or isBlocked');
            return res.status(400).json({ error: 'Valid class ID, student ID, and isBlocked (boolean) are required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[blockUnblockStudent] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const student = await User.findById(studentId);
        if (!student || student.role !== 'student') {
            console.error('[blockUnblockStudent] Validation failed: Student not found or invalid role');
            return res.status(404).json({ error: 'Student not found or not a student' });
        }

        if (!classData.students.some((id) => String(id) === String(studentId))) {
            console.error('[blockUnblockStudent] Validation failed: Student not enrolled');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        if (req.user.role === 'teacher' && !classData.teachers.some((id) => String(id) === String(req.user._id))) {
            console.error('[blockUnblockStudent] Authorization failed: Teacher not assigned to class');
            return res.status(403).json({ error: 'Teacher not assigned to this class' });
        }

        if (!student.isBlocked) {
            student.isBlocked = new Map();
        }
        console.log('[blockUnblockStudent] Current isBlocked status for this class:', student.isBlocked.get(String(classId)));
        console.log('[blockUnblockStudent] Setting isBlocked to:', isBlocked);
        
        student.isBlocked.set(String(classId), isBlocked);
        await student.save();
        
        console.log('[blockUnblockStudent] ✅ Student saved successfully!');
        console.log('[blockUnblockStudent] Final isBlocked status:', student.isBlocked.get(String(classId)));
        console.log('[blockUnblockStudent] Full isBlocked Map:', Object.fromEntries(student.isBlocked));

        if (req.io) req.io.to(`class:${classId}`).emit('analyticsUpdated', { classId });
        req.io.to(`class:${classId}`).emit('studentBlockStatusUpdated', {
            classId,
            studentId,
            isBlocked,
            studentName: student.name,
            studentEmail: student.email
        });

        res.status(200).json({
            message: `Student ${isBlocked ? 'blocked' : 'unblocked'} successfully`,
            student: { id: student._id, name: student.name, email: student.email, isBlocked: student.isBlocked.get(classId) }
        });
    } catch (err) {
        console.error('[blockUnblockStudent] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error updating student block status' });
    }
};

exports.focusUnfocusStudent = async (req, res) => {
    try {
        const { classId } = req.params;
        const { studentId, needsFocus } = req.body;
        console.log('[focusUnfocusStudent] Request received:', { classId, studentId, needsFocus, user: { id: req.user._id, role: req.user.role } });

        if (!['admin', 'teacher'].includes(req.user.role)) {
            console.error('[focusUnfocusStudent] Authorization failed: User not authorized');
            return res.status(403).json({ error: 'Only admins or teachers can focus/unfocus students' });
        }

        if (!isValidObjectId(classId) || !isValidObjectId(studentId) || typeof needsFocus !== 'boolean') {
            console.error('[focusUnfocusStudent] Validation failed: Invalid classId, studentId, or needsFocus');
            return res.status(400).json({ error: 'Valid class ID, student ID, and needsFocus (boolean) are required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[focusUnfocusStudent] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const student = await User.findById(studentId);
        if (!student || student.role !== 'student') {
            console.error('[focusUnfocusStudent] Validation failed: Student not found or invalid role');
            return res.status(404).json({ error: 'Student not found or not a student' });
        }

        if (!classData.students.some((id) => String(id) === String(studentId))) {
            console.error('[focusUnfocusStudent] Validation failed: Student not enrolled');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        if (req.user.role === 'teacher' && !classData.teachers.some((id) => String(id) === String(req.user._id))) {
            console.error('[focusUnfocusStudent] Authorization failed: Teacher not assigned to class');
            return res.status(403).json({ error: 'Teacher not assigned to this class' });
        }

        console.log('[focusUnfocusStudent] Looking up leaderboard for:', { classId, studentId });
        let leaderboard = await Leaderboard.findOne({ classId, studentId });
        
        if (!leaderboard) {
            console.log('[focusUnfocusStudent] No leaderboard found, creating new one');
            leaderboard = new Leaderboard({
                classId,
                studentId,
                attempts: [],
                highestScores: [],
                totalScore: 0,
                correctAttempts: 0,
                wrongAttempts: 0,
                totalRuns: 0,
                totalSubmits: 0,
                activityStatus: 'inactive',
                needsFocus
            });
            console.log('[focusUnfocusStudent] New leaderboard created with needsFocus:', needsFocus);
        } else {
            console.log('[focusUnfocusStudent] Existing leaderboard found:', {
                _id: leaderboard._id,
                currentNeedsFocus: leaderboard.needsFocus,
                currentActivityStatus: leaderboard.activityStatus,
                totalSubmits: leaderboard.totalSubmits,
                newNeedsFocus: needsFocus
            });
            
            leaderboard.needsFocus = needsFocus;
            console.log('[focusUnfocusStudent] Set needsFocus to:', needsFocus);
            
            if (needsFocus) {
                console.log('[focusUnfocusStudent] Setting activityStatus to "focused" because needsFocus=true');
                leaderboard.activityStatus = 'focused';
            } else if (leaderboard.activityStatus === 'focused') {
                const newStatus = leaderboard.totalSubmits > 0 ? 'active' : 'inactive';
                console.log('[focusUnfocusStudent] Setting activityStatus from "focused" to:', newStatus, '(totalSubmits:', leaderboard.totalSubmits + ')');
                leaderboard.activityStatus = newStatus;
            } else {
                console.log('[focusUnfocusStudent] Not changing activityStatus, currently:', leaderboard.activityStatus);
            }
        }
        
        console.log('[focusUnfocusStudent] Saving leaderboard with:', {
            needsFocus: leaderboard.needsFocus,
            activityStatus: leaderboard.activityStatus
        });
        
        await leaderboard.save();
        
        console.log('[focusUnfocusStudent] ✅ Leaderboard saved successfully!');
        console.log('[focusUnfocusStudent] Final values:', {
            studentId: leaderboard.studentId,
            needsFocus: leaderboard.needsFocus,
            activityStatus: leaderboard.activityStatus,
            _id: leaderboard._id
        });

        req.io.to(`class:${classId}`).emit('studentFocusStatusUpdated', {
            classId,
            studentId,
            needsFocus,
            studentName: student.name,
            studentEmail: student.email
        });

        res.status(200).json({
            message: `Student ${needsFocus ? 'marked for focus' : 'unmarked from focus'} successfully`,
            student: { id: student._id, name: student.name, email: student.email, needsFocus }
        });
    } catch (err) {
        console.error('[focusUnfocusStudent] Error:', err.message, err.stack);
        res.status(500).json({ error: 'Error updating student focus status' });
    }
};

exports.getCounts = async (req, res) => {
    try {
        console.log('getCounts: Request received:', { user: { id: req.user._id, role: req.user.role } });

        const Exam = require('../models/Exam');
        const ExamAttempt = require('../models/ExamAttempt');

        const [
            teacherCount, 
            studentCount, 
            questionCount, 
            classCount,
            activeClassCount,
            inactiveClassCount,
            examCount,
            examDraftCount,
            examScheduledCount,
            examActiveCount,
            examCompletedCount,
            examTemplateCount,
            examAttemptCount,
            totalSubmissions
        ] = await Promise.all([
            User.countDocuments({ role: 'teacher' }),
            User.countDocuments({ role: 'student' }),
            Question.countDocuments(),
            Class.countDocuments(),
            Class.countDocuments({ status: 'active' }),
            Class.countDocuments({ status: 'inactive' }),
            Exam.countDocuments({ 'template.isTemplate': { $ne: true } }),
            Exam.countDocuments({ status: 'draft', 'template.isTemplate': { $ne: true } }),
            Exam.countDocuments({ status: 'scheduled', 'template.isTemplate': { $ne: true } }),
            Exam.countDocuments({ status: 'active', 'template.isTemplate': { $ne: true } }),
            Exam.countDocuments({ status: 'completed', 'template.isTemplate': { $ne: true } }),
            Exam.countDocuments({ 'template.isTemplate': true }),
            ExamAttempt.countDocuments(),
            Submission.countDocuments()
        ]);

        // Get class analytics
        const classes = await Class.find().select('name status students teachers questions assignments').lean();
        const classAnalytics = classes.map(cls => ({
            id: cls._id.toString(),
            name: cls.name,
            status: cls.status,
            studentCount: cls.students?.length || 0,
            teacherCount: cls.teachers?.length || 0,
            questionCount: cls.questions?.length || 0,
            assignmentCount: cls.assignments?.length || 0
        }));

        // Get exam statistics per class
        const exams = await Exam.find({ 'template.isTemplate': { $ne: true } })
            .select('classId status title')
            .lean();
        
        const examStatsByClass = {};
        exams.forEach(exam => {
            const classId = exam.classId?.toString();
            if (!classId) return;
            
            if (!examStatsByClass[classId]) {
                examStatsByClass[classId] = {
                    total: 0,
                    draft: 0,
                    scheduled: 0,
                    active: 0,
                    completed: 0
                };
            }
            
            examStatsByClass[classId].total++;
            if (exam.status) {
                examStatsByClass[classId][exam.status] = (examStatsByClass[classId][exam.status] || 0) + 1;
            }
        });

        // Add exam counts to class analytics
        classAnalytics.forEach(cls => {
            const examStats = examStatsByClass[cls.id.toString()] || { total: 0, draft: 0, scheduled: 0, active: 0, completed: 0 };
            cls.examCount = examStats.total;
            cls.examStats = examStats;
        });

        console.log('getCounts: Counts fetched:', {
            teachers: teacherCount,
            students: studentCount,
            questions: questionCount,
            classes: classCount,
            activeClasses: activeClassCount,
            inactiveClasses: inactiveClassCount,
            exams: examCount,
            examAttempts: examAttemptCount
        });

        res.status(200).json({
            counts: {
                teachers: teacherCount,
                students: studentCount,
                questions: questionCount,
                classes: classCount,
                activeClasses: activeClassCount,
                inactiveClasses: inactiveClassCount,
                exams: examCount,
                examDrafts: examDraftCount,
                examScheduled: examScheduledCount,
                examActive: examActiveCount,
                examCompleted: examCompletedCount,
                examTemplates: examTemplateCount,
                examAttempts: examAttemptCount,
                totalSubmissions: totalSubmissions
            },
            classAnalytics: classAnalytics
        });
    } catch (err) {
        console.error('getCounts: Error:', err);
        res.status(500).json({ error: 'Error fetching counts' });
    }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_DAYS = 14;

function safeTimeZone(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64) return 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        return 'UTC';
    }
}

function dayKey(date, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Admin dashboard: KPIs, 14-day activity, exams in motion, items needing attention, recent submissions, busiest classes.
exports.getDashboard = async (req, res) => {
    try {
        const now = new Date();
        const timeZone = safeTimeZone(req.query.tz);
        const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
        const twoWeeksAgo = new Date(now.getTime() - 14 * DAY_MS);
        const activityStart = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
        const weekAgoId = mongoose.Types.ObjectId.createFromTime(Math.floor(weekAgo.getTime() / 1000));
        const realSubmission = { isRun: { $ne: true }, isCustomInput: { $ne: true } };
        const isTeacher = req.user.role === 'teacher';
        const ownClassIds = isTeacher ? await teacherClassIds(req.user) : null;
        const classQuery = ownClassIds ? { _id: { $in: ownClassIds } } : {};
        const examQuery = { 'template.isTemplate': { $ne: true }, ...(ownClassIds ? { classId: { $in: ownClassIds } } : {}) };
        const submissionQuery = { ...realSubmission, ...(ownClassIds ? { classId: { $in: ownClassIds } } : {}) };
        const questionQuery = ownClassIds
            ? {
                  status: { $ne: 'draft' },
                  isDraft: { $ne: true },
                  $or: [{ createdBy: req.user._id }, { 'classes.classId': { $in: ownClassIds } }],
              }
            : { status: { $ne: 'draft' }, isDraft: { $ne: true } };

        const [
            studentCount,
            newStudentCount,
            teacherCount,
            creatorCount,
            classes,
            bankQuestionCount,
            myDraftCount,
            templateCount,
            subsThisWeek,
            subsLastWeek,
            activeStudentIds,
            dailyRaw,
            exams,
            recentRaw,
            classActivity,
            blockedStudentCount,
        ] = await Promise.all([
            isTeacher
                ? Class.aggregate([
                      { $match: classQuery },
                      { $unwind: { path: '$students', preserveNullAndEmptyArrays: false } },
                      { $group: { _id: '$students' } },
                      { $count: 'n' },
                  ]).then((rows) => rows[0]?.n || 0)
                : User.countDocuments({ role: 'student' }),
            isTeacher
                ? Class.aggregate([
                      { $match: classQuery },
                      { $unwind: { path: '$students', preserveNullAndEmptyArrays: false } },
                      { $match: { students: { $gte: weekAgoId } } },
                      { $group: { _id: '$students' } },
                      { $count: 'n' },
                  ]).then((rows) => rows[0]?.n || 0)
                : User.countDocuments({ role: 'student', _id: { $gte: weekAgoId } }),
            isTeacher ? 0 : User.countDocuments({ role: 'teacher' }),
            isTeacher ? 0 : User.countDocuments({ role: 'teacher', canCreateQuestion: true }),
            Class.find(classQuery).select('name status students teachers').lean(),
            Question.countDocuments(questionQuery),
            Question.countDocuments({ status: 'draft', isDraft: true, createdBy: req.user._id }),
            Exam.countDocuments({ 'template.isTemplate': true }),
            Submission.countDocuments({ ...submissionQuery, submittedAt: { $gte: weekAgo } }),
            Submission.countDocuments({ ...submissionQuery, submittedAt: { $gte: twoWeeksAgo, $lt: weekAgo } }),
            Submission.distinct('studentId', { ...submissionQuery, submittedAt: { $gte: weekAgo } }),
            Submission.aggregate([
                { $match: { ...submissionQuery, submittedAt: { $gte: activityStart } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$submittedAt', timezone: timeZone } },
                        total: { $sum: 1 },
                        correct: { $sum: { $cond: ['$isCorrect', 1, 0] } },
                    },
                },
            ]),
            Exam.find(examQuery)
                .select('title classId status proctoring scoring createdAt')
                .lean(),
            Submission.find(submissionQuery)
                .sort({ submittedAt: -1 })
                .limit(8)
                .populate('studentId', 'name')
                .populate('questionId', 'title type')
                .populate('classId', 'name')
                .select('studentId questionId classId isCorrect status submittedAt examAttemptId')
                .lean(),
            Submission.aggregate([
                { $match: { ...submissionQuery, submittedAt: { $gte: weekAgo } } },
                { $group: { _id: '$classId', total: { $sum: 1 }, correct: { $sum: { $cond: ['$isCorrect', 1, 0] } } } },
            ]),
            isTeacher
                ? Promise.resolve(0)
                : User.countDocuments({
                      role: 'student',
                      $expr: {
                          $in: [true, { $map: { input: { $objectToArray: { $ifNull: ['$isBlocked', {}] } }, in: '$$this.v' } }],
                      },
                  }),
        ]);

        const classById = new Map(classes.map((c) => [String(c._id), c]));
        const enrolled = new Set(classes.flatMap((c) => (c.students || []).map(String)));
        const unenrolledStudentCount = isTeacher
            ? 0
            : await User.countDocuments({
                  role: 'student',
                  _id: { $nin: [...enrolled].map((id) => new mongoose.Types.ObjectId(id)) },
              });
        let teacherBlockedCount = blockedStudentCount;
        if (isTeacher && enrolled.size && ownClassIds?.length) {
            teacherBlockedCount = await User.countDocuments({
                role: 'student',
                _id: { $in: [...enrolled].map((id) => new mongoose.Types.ObjectId(id)) },
                $or: ownClassIds.map((id) => ({ [`isBlocked.${id}`]: true })),
            });
        }

        // Exams by effective phase
        const phaseCounts = { draft: 0, scheduled: 0, live: 0, completed: 0, archived: 0 };
        const examsByClass = new Map();
        const phased = exams.map((exam) => {
            const phase = examPhase(exam, now);
            phaseCounts[phase] += 1;
            const key = String(exam.classId);
            examsByClass.set(key, (examsByClass.get(key) || 0) + 1);
            return { ...exam, phase };
        });

        const inMotion = phased
            .filter((e) => e.phase === 'live' || e.phase === 'scheduled')
            .sort((a, b) => {
                if (a.phase !== b.phase) return a.phase === 'live' ? -1 : 1;
                const at = a.proctoring?.startTime ? new Date(a.proctoring.startTime).getTime() : Infinity;
                const bt = b.proctoring?.startTime ? new Date(b.proctoring.startTime).getTime() : Infinity;
                return at - bt;
            })
            .slice(0, 6);

        const completedUnreleased = phased.filter(
            (e) => e.phase === 'completed' && e.scoring?.releaseStatus !== 'released' && !e.scoring?.immediateScoreRelease,
        );

        const attemptIds = [...inMotion, ...completedUnreleased].map((e) => e._id);
        const attemptStats = attemptIds.length
            ? await ExamAttempt.aggregate([
                  { $match: { examId: { $in: attemptIds } } },
                  {
                      $group: {
                          _id: '$examId',
                          started: { $sum: { $cond: [{ $ne: ['$status', 'not_started'] }, 1, 0] } },
                          submitted: {
                              $sum: { $cond: [{ $in: ['$status', ['submitted', 'auto_submitted', 'terminated', 'expired']] }, 1, 0] },
                          },
                      },
                  },
              ])
            : [];
        const attemptsByExam = new Map(attemptStats.map((a) => [String(a._id), a]));
        const awaitingRelease = completedUnreleased.filter((e) => attemptsByExam.get(String(e._id))?.submitted > 0);

        const upcomingExams = inMotion.map((e) => {
            const cls = classById.get(String(e.classId));
            const stats = attemptsByExam.get(String(e._id));
            return {
                _id: e._id,
                title: e.title,
                phase: e.phase,
                classId: e.classId,
                className: cls?.name || null,
                startTime: e.proctoring?.startTime || null,
                endTime: e.proctoring?.endTime || null,
                durationMinutes: e.proctoring?.durationMinutes || null,
                enrolled: cls?.students?.length || 0,
                started: stats?.started || 0,
                submitted: stats?.submitted || 0,
            };
        });

        // Fill every day in the window so the chart has no gaps
        const dailyMap = new Map(dailyRaw.map((d) => [d._id, d]));
        const activity = [];
        for (let i = ACTIVITY_DAYS - 1; i >= 0; i -= 1) {
            const key = dayKey(new Date(now.getTime() - i * DAY_MS), timeZone);
            const row = dailyMap.get(key);
            activity.push({ date: key, total: row?.total || 0, correct: row?.correct || 0 });
        }

        const activityByClass = new Map(classActivity.map((a) => [String(a._id), a]));
        const topClasses = classes
            .map((c) => {
                const act = activityByClass.get(String(c._id));
                return {
                    _id: c._id,
                    name: c.name,
                    status: c.status,
                    students: c.students?.length || 0,
                    teachers: c.teachers?.length || 0,
                    exams: examsByClass.get(String(c._id)) || 0,
                    submissions7d: act?.total || 0,
                    accuracy7d: act?.total ? Math.round((act.correct / act.total) * 100) : null,
                };
            })
            .sort((a, b) => b.submissions7d - a.submissions7d || b.students - a.students)
            .slice(0, 6);

        const recentSubmissions = recentRaw.map((s) => ({
            _id: s._id,
            studentId: s.studentId?._id || null,
            studentName: s.studentId?.name || 'Deleted student',
            questionId: s.questionId?._id || null,
            questionTitle: s.questionId?.title || 'Deleted question',
            questionType: s.questionId?.type || null,
            className: s.classId?.name || null,
            isCorrect: Boolean(s.isCorrect),
            status: s.status,
            inExam: Boolean(s.examAttemptId),
            submittedAt: s.submittedAt,
        }));

        const activeClassCount = classes.filter((c) => c.status === 'active').length;

        res.json({
            generatedAt: now,
            scope: isTeacher ? 'teacher' : 'admin',
            kpis: {
                students: studentCount,
                newStudents7d: newStudentCount,
                activeStudents7d: activeStudentIds.length,
                teachers: teacherCount,
                teacherCreators: creatorCount,
                classes: classes.length,
                activeClasses: activeClassCount,
                questions: bankQuestionCount,
                templates: templateCount,
                submissions7d: subsThisWeek,
                submissionsPrev7d: subsLastWeek,
            },
            exams: { total: exams.length, ...phaseCounts },
            activity,
            upcomingExams,
            attention: {
                drafts: myDraftCount,
                classesWithoutTeacher: classes.filter((c) => c.status === 'active' && !c.teachers?.length).length,
                inactiveClasses: classes.length - activeClassCount,
                unenrolledStudents: unenrolledStudentCount,
                blockedStudents: teacherBlockedCount,
                scoresAwaitingRelease: awaitingRelease.length,
                firstAwaitingRelease: awaitingRelease[0] ? { _id: awaitingRelease[0]._id, classId: awaitingRelease[0].classId } : null,
            },
            recentSubmissions,
            topClasses,
        });
    } catch (err) {
        console.error('getDashboard error:', err);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
};

const stripPlain = (html) =>
    String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

exports.getStudentDashboard = async (req, res) => {
    try {
        const studentId = req.user._id;
        const now = new Date();
        const classes = await Class.find({ students: studentId })
            .select('name description status students questions assignments teachers createdBy')
            .populate('assignments.questionId', 'title type difficulty')
            .populate('teachers', 'name')
            .populate('createdBy', 'name')
            .lean();
        const classIds = classes.map((c) => c._id);
        const classById = new Map(classes.map((c) => [String(c._id), c]));
        const realSubmission = { studentId, classId: { $in: classIds }, isRun: { $ne: true }, isCustomInput: { $ne: true } };

        const [exams, recentRaw, statsAgg] = await Promise.all([
            classIds.length
                ? Exam.find({
                      classId: { $in: classIds },
                      'template.isTemplate': { $ne: true },
                      status: { $nin: ['draft', 'archived'] },
                  })
                      .select('title classId status proctoring scoring createdAt')
                      .lean()
                : [],
            classIds.length
                ? Submission.find(realSubmission)
                      .sort({ submittedAt: -1 })
                      .limit(8)
                      .populate('questionId', 'title')
                      .populate('classId', 'name')
                      .select('questionId classId isCorrect submittedAt')
                      .lean()
                : [],
            classIds.length
                ? Submission.aggregate([
                      { $match: realSubmission },
                      {
                          $group: {
                              _id: null,
                              total: { $sum: 1 },
                              correct: { $sum: { $cond: ['$isCorrect', 1, 0] } },
                              solved: { $addToSet: { $cond: ['$isCorrect', '$questionId', '$$REMOVE'] } },
                          },
                      },
                  ])
                : [],
        ]);

        const attempts = exams.length
            ? await ExamAttempt.find({ studentId, examId: { $in: exams.map((e) => e._id) } })
                  .select('examId status totalScore maxScore submittedAt')
                  .lean()
            : [];
        const attemptByExam = new Map(attempts.map((a) => [String(a.examId), a]));

        const upcomingExams = exams
            .map((exam) => {
                const phase = examPhase(exam, now);
                const attempt = attemptByExam.get(String(exam._id));
                return {
                    _id: exam._id,
                    title: exam.title,
                    classId: exam.classId,
                    className: classById.get(String(exam.classId))?.name || null,
                    phase,
                    startTime: exam.proctoring?.startTime || null,
                    endTime: exam.proctoring?.endTime || null,
                    durationMinutes: exam.proctoring?.durationMinutes || null,
                    attemptStatus: attempt?.status || null,
                };
            })
            .filter((exam) => exam.phase === 'live' || exam.phase === 'scheduled')
            .sort((a, b) => {
                if (a.phase !== b.phase) return a.phase === 'live' ? -1 : 1;
                const at = a.startTime ? new Date(a.startTime).getTime() : Infinity;
                const bt = b.startTime ? new Date(b.startTime).getTime() : Infinity;
                return at - bt;
            })
            .slice(0, 6);

        const assignments = classes
            .flatMap((cls) =>
                (cls.assignments || []).map((assignment) => ({
                    _id: assignment._id,
                    classId: cls._id,
                    className: cls.name,
                    questionId: assignment.questionId?._id || assignment.questionId,
                    questionTitle: stripPlain(assignment.questionId?.title) || 'Untitled question',
                    dueDate: assignment.dueDate || null,
                    maxPoints: assignment.maxPoints ?? null,
                }))
            )
            .filter((row) => row.questionId)
            .sort((a, b) => {
                const ad = a.dueDate ? new Date(a.dueDate).getTime() : 0;
                const bd = b.dueDate ? new Date(b.dueDate).getTime() : 0;
                return bd - ad;
            })
            .slice(0, 8);

        const statsRow = statsAgg[0] || {};
        const totalSubmissions = statsRow.total || 0;

        res.json({
            generatedAt: now,
            classes: classes.map((cls) => ({
                _id: cls._id,
                name: cls.name,
                description: cls.description || '',
                status: cls.status,
                studentCount: cls.students?.length || 0,
                questionCount: cls.questions?.length || 0,
                assignmentCount: cls.assignments?.length || 0,
                teacherName: cls.teachers?.[0]?.name || cls.createdBy?.name || null,
            })),
            upcomingExams,
            assignments,
            stats: {
                problemsSolved: (statsRow.solved || []).length,
                totalSubmissions,
                successRate: totalSubmissions ? Math.round(((statsRow.correct || 0) / totalSubmissions) * 100) : 0,
            },
            recentActivity: recentRaw.map((row) => ({
                id: String(row._id),
                questionId: row.questionId?._id || row.questionId,
                questionTitle: stripPlain(row.questionId?.title) || 'Question',
                classId: row.classId?._id || row.classId,
                className: row.classId?.name || null,
                isCorrect: Boolean(row.isCorrect),
                submittedAt: row.submittedAt,
            })),
        });
    } catch (err) {
        console.error('getStudentDashboard error:', err);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
};

// Everything the admin class workspace needs in one round trip.
exports.getClassOverview = async (req, res) => {
    try {
        const { classId } = req.params;
        if (!isValidObjectId(classId)) return res.status(400).json({ error: 'Invalid class ID' });

        const classObjectId = new mongoose.Types.ObjectId(classId);
        const classData = await Class.findById(classId)
            .populate('teachers', 'name email canCreateQuestion')
            .populate('createdBy', 'name email')
            .populate('students', 'name email number isBlocked')
            .lean();
        if (!classData) return res.status(404).json({ error: 'Class not found' });
        if (!(await canAccessClass(req.user, classData))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }

        const now = new Date();
        const timeZone = safeTimeZone(req.query.tz);
        const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
        const activityStart = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
        const practice = { classId: classObjectId, isRun: { $ne: true }, isCustomInput: { $ne: true }, examAttemptId: { $exists: false } };
        const linkedQuestionIds = (classData.questions || []).map((id) => new mongoose.Types.ObjectId(String(id)));

        const [leaderboards, questionDocs, pairs, dailyRaw, exams] = await Promise.all([
            Leaderboard.find({ classId }).select('studentId totalScore totalRuns totalSubmits activityStatus needsFocus updatedAt').lean(),
            Question.find({ $or: [{ 'classes.classId': classObjectId }, { _id: { $in: linkedQuestionIds } }] })
                .select('title type difficulty points tags classes isExamOnly createdBy updatedAt')
                .lean(),
            Submission.aggregate([
                { $match: practice },
                {
                    $group: {
                        _id: { studentId: '$studentId', questionId: '$questionId' },
                        submissions: { $sum: 1 },
                        correctSubmissions: { $sum: { $cond: ['$isCorrect', 1, 0] } },
                        lastAt: { $max: '$submittedAt' },
                    },
                },
            ]),
            Submission.aggregate([
                { $match: { ...practice, submittedAt: { $gte: activityStart } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$submittedAt', timezone: timeZone } },
                        total: { $sum: 1 },
                        correct: { $sum: { $cond: ['$isCorrect', 1, 0] } },
                        students: { $addToSet: '$studentId' },
                    },
                },
            ]),
            Exam.find({ classId, 'template.isTemplate': { $ne: true } })
                .select('title description status proctoring scoring questions createdAt')
                .lean(),
        ]);

        // Per-student and per-question practice stats from the (student, question) pairs
        const byStudent = new Map();
        const byQuestion = new Map();
        for (const p of pairs) {
            const sid = String(p._id.studentId);
            const qid = String(p._id.questionId);
            const solved = p.correctSubmissions > 0;
            const s = byStudent.get(sid) || { attempted: 0, solved: 0, submissions: 0, correctSubmissions: 0, lastSubmittedAt: null };
            s.attempted += 1;
            s.solved += solved ? 1 : 0;
            s.submissions += p.submissions;
            s.correctSubmissions += p.correctSubmissions;
            if (!s.lastSubmittedAt || p.lastAt > s.lastSubmittedAt) s.lastSubmittedAt = p.lastAt;
            byStudent.set(sid, s);

            const q = byQuestion.get(qid) || { attempted: 0, solved: 0, submissions: 0 };
            q.attempted += 1;
            q.solved += solved ? 1 : 0;
            q.submissions += p.submissions;
            byQuestion.set(qid, q);
        }
        const boardByStudent = new Map(leaderboards.map((l) => [String(l.studentId), l]));

        const assignmentsByQuestion = new Map(
            (classData.assignments || []).map((a) => [String(a.questionId), a]),
        );
        const questions = questionDocs
            .map((q) => {
                const setting = (q.classes || []).find((c) => String(c.classId) === classId) || {};
                const stats = byQuestion.get(String(q._id)) || { attempted: 0, solved: 0, submissions: 0 };
                const assignment = assignmentsByQuestion.get(String(q._id));
                return {
                    _id: q._id,
                    title: q.title,
                    type: q.type,
                    difficulty: q.difficulty || null,
                    points: q.points ?? null,
                    tags: q.tags || [],
                    isPublished: Boolean(setting.isPublished),
                    isDisabled: Boolean(setting.isDisabled),
                    publishedAt: setting.publishedAt || null,
                    assignment: assignment
                        ? { _id: assignment._id, dueDate: assignment.dueDate || null, maxPoints: assignment.maxPoints ?? null, assignedAt: assignment.assignedAt }
                        : null,
                    attempted: stats.attempted,
                    solved: stats.solved,
                    submissions: stats.submissions,
                    solveRate: stats.attempted ? Math.round((stats.solved / stats.attempted) * 100) : null,
                };
            })
            .sort((a, b) => a.title.localeCompare(b.title));
        const publishedCount = questions.filter((q) => q.isPublished && !q.isDisabled).length;

        const students = (classData.students || [])
            .map((st) => {
                const s = byStudent.get(String(st._id)) || { attempted: 0, solved: 0, submissions: 0, correctSubmissions: 0, lastSubmittedAt: null };
                const board = boardByStudent.get(String(st._id));
                return {
                    _id: st._id,
                    name: st.name,
                    email: st.email,
                    number: st.number || null,
                    isBlocked: Boolean(st.isBlocked?.[classId]),
                    needsFocus: Boolean(board?.needsFocus),
                    activityStatus: board?.activityStatus || 'inactive',
                    score: board?.totalScore || 0,
                    runs: board?.totalRuns || 0,
                    submissions: s.submissions,
                    attempted: s.attempted,
                    solved: s.solved,
                    accuracy: s.submissions ? Math.round((s.correctSubmissions / s.submissions) * 100) : null,
                    lastActiveAt: s.lastSubmittedAt || null,
                    activeThisWeek: Boolean(s.lastSubmittedAt && s.lastSubmittedAt >= weekAgo),
                };
            })
            .sort((a, b) => b.score - a.score || b.solved - a.solved || a.name.localeCompare(b.name));
        students.forEach((s, i) => {
            s.rank = s.submissions || s.score ? i + 1 : null;
        });

        // Exams with time-based phase and attempt progress
        const attemptStats = exams.length
            ? await ExamAttempt.aggregate([
                  { $match: { examId: { $in: exams.map((e) => e._id) } } },
                  {
                      $group: {
                          _id: '$examId',
                          started: { $sum: { $cond: [{ $ne: ['$status', 'not_started'] }, 1, 0] } },
                          submitted: { $sum: { $cond: [{ $in: ['$status', ['submitted', 'auto_submitted', 'terminated', 'expired']] }, 1, 0] } },
                          scored: { $sum: '$totalScore' },
                          maxScored: { $sum: '$maxScore' },
                      },
                  },
              ])
            : [];
        const attemptsByExam = new Map(attemptStats.map((a) => [String(a._id), a]));
        const phaseOrder = { live: 0, scheduled: 1, draft: 2, completed: 3, archived: 4 };
        const examList = exams
            .map((e) => {
                const a = attemptsByExam.get(String(e._id));
                return {
                    _id: e._id,
                    title: e.title,
                    phase: examPhase(e, now),
                    startTime: e.proctoring?.startTime || null,
                    endTime: e.proctoring?.endTime || null,
                    durationMinutes: e.proctoring?.durationMinutes || null,
                    questionCount: e.questions?.length || 0,
                    started: a?.started || 0,
                    submitted: a?.submitted || 0,
                    averagePercent: a?.maxScored ? Math.round((a.scored / a.maxScored) * 100) : null,
                    scoresReleased: e.scoring?.releaseStatus === 'released' || Boolean(e.scoring?.immediateScoreRelease),
                    createdAt: e.createdAt,
                };
            })
            .sort((a, b) => {
                if (phaseOrder[a.phase] !== phaseOrder[b.phase]) return phaseOrder[a.phase] - phaseOrder[b.phase];
                const at = new Date(a.startTime || a.createdAt).getTime();
                const bt = new Date(b.startTime || b.createdAt).getTime();
                return a.phase === 'completed' ? bt - at : at - bt;
            });

        const dailyMap = new Map(dailyRaw.map((d) => [d._id, d]));
        const activity = [];
        for (let i = ACTIVITY_DAYS - 1; i >= 0; i -= 1) {
            const key = dayKey(new Date(now.getTime() - i * DAY_MS), timeZone);
            const row = dailyMap.get(key);
            activity.push({ date: key, total: row?.total || 0, correct: row?.correct || 0, students: row?.students?.length || 0 });
        }

        const totalSubmissions = students.reduce((sum, s) => sum + s.submissions, 0);
        const totalCorrect = [...byStudent.values()].reduce((sum, s) => sum + s.correctSubmissions, 0);
        const solvedTotal = students.reduce((sum, s) => sum + s.solved, 0);

        res.json({
            generatedAt: now,
            class: {
                _id: classData._id,
                name: classData.name,
                description: classData.description || '',
                status: classData.status,
                createdAt: classData.createdAt,
                createdBy: classData.createdBy ? { _id: classData.createdBy._id, name: classData.createdBy.name, email: classData.createdBy.email } : null,
            },
            counts: {
                students: students.length,
                teachers: classData.teachers?.length || 0,
                questions: questions.length,
                publishedQuestions: publishedCount,
                assignments: classData.assignments?.length || 0,
                exams: examList.length,
            },
            aggregates: {
                activeStudents7d: students.filter((s) => s.activeThisWeek).length,
                neverActive: students.filter((s) => s.submissions === 0).length,
                needsFocus: students.filter((s) => s.needsFocus).length,
                blocked: students.filter((s) => s.isBlocked).length,
                submissions: totalSubmissions,
                accuracy: totalSubmissions ? Math.round((totalCorrect / totalSubmissions) * 100) : null,
                avgSolved: students.length ? Math.round((solvedTotal / students.length) * 10) / 10 : 0,
                totalRuns: students.reduce((sum, s) => sum + s.runs, 0),
            },
            teachers: (classData.teachers || []).map((t) => ({ _id: t._id, name: t.name, email: t.email, canCreateQuestion: Boolean(t.canCreateQuestion) })),
            students,
            questions,
            exams: examList,
            activity,
        });
    } catch (err) {
        console.error('getClassOverview error:', err);
        res.status(500).json({ error: 'Failed to load class overview' });
    }
};

// Detach a question from one class. Past submissions are kept for history.
exports.removeQuestionFromClass = async (req, res) => {
    try {
        const { classId, questionId } = req.params;
        if (!isValidObjectId(classId) || !isValidObjectId(questionId)) {
            return res.status(400).json({ error: 'Invalid class or question ID' });
        }
        const [classData, linkedOnQuestion] = await Promise.all([
            Class.findById(classId).select('questions'),
            Question.exists({ _id: questionId, 'classes.classId': classId }),
        ]);
        if (!classData) return res.status(404).json({ error: 'Class not found' });
        if (!(await canAccessClass(req.user, classId))) {
            return res.status(403).json({ error: 'Not authorized for this class' });
        }
        const linkedOnClass = classData.questions.some((id) => String(id) === questionId);
        if (!linkedOnClass && !linkedOnQuestion) return res.status(404).json({ error: 'Question is not in this class' });

        await Promise.all([
            Class.updateOne({ _id: classId }, { $pull: { questions: questionId, assignments: { questionId } } }),
            Question.updateOne({ _id: questionId }, { $pull: { classes: { classId } } }),
        ]);
        res.json({ message: 'Question removed from class' });
    } catch (err) {
        console.error('removeQuestionFromClass error:', err);
        res.status(500).json({ error: 'Failed to remove question from class' });
    }
};

// Everything the admin question page needs: the full question, where it is used and how students do on it.
exports.getQuestionOverview = async (req, res) => {
    try {
        const { questionId } = req.params;
        if (!isValidObjectId(questionId)) return res.status(400).json({ error: 'Invalid question ID' });

        const question = await Question.findById(questionId)
            .populate('createdBy', 'name email role')
            .populate('publishedBy', 'name email')
            .lean();
        if (!question) return res.status(404).json({ error: 'Question not found' });

        const now = new Date();
        const qid = question._id;
        const settingIds = (question.classes || []).map((c) => String(c.classId));
        const practice = { questionId: qid, isRun: { $ne: true }, isCustomInput: { $ne: true }, examAttemptId: { $exists: false } };
        const examFilter = { 'questions.questionId': qid };

        // Teachers only see their own questions or ones used in their classes, and only their classes' data.
        let classScope = { $or: [{ _id: { $in: settingIds } }, { questions: qid }] };
        if (req.user.role !== 'admin') {
            const ownClassIds = (
                await Class.find({ $or: [{ teachers: req.user._id }, { createdBy: req.user._id }] }).select('_id').lean()
            ).map((c) => c._id);
            const ownSet = new Set(ownClassIds.map(String));
            const isAuthor = String(question.createdBy?._id || question.createdBy) === String(req.user._id);
            const inOwnClass = settingIds.some((id) => ownSet.has(id)) || (await Class.exists({ _id: { $in: ownClassIds }, questions: qid }));
            if (!isAuthor && !inOwnClass) return res.status(403).json({ error: 'You do not have access to this question' });
            classScope = { $and: [classScope, { _id: { $in: ownClassIds } }] };
            practice.classId = { $in: ownClassIds };
            examFilter.classId = { $in: ownClassIds };
        }

        const [classDocs, pairs, statusRaw, languageRaw, recentRaw, exams, templateCount, examSubmissions] = await Promise.all([
            Class.find(classScope)
                .select('name status students assignments')
                .lean(),
            Submission.aggregate([
                { $match: practice },
                {
                    $group: {
                        _id: { classId: '$classId', studentId: '$studentId' },
                        submissions: { $sum: 1 },
                        correct: { $sum: { $cond: ['$isCorrect', 1, 0] } },
                        lastAt: { $max: '$submittedAt' },
                    },
                },
            ]),
            Submission.aggregate([{ $match: practice }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
            Submission.aggregate([
                { $match: { ...practice, language: { $exists: true, $ne: null } } },
                { $group: { _id: '$language', count: { $sum: 1 }, correct: { $sum: { $cond: ['$isCorrect', 1, 0] } } } },
                { $sort: { count: -1 } },
            ]),
            Submission.find(practice)
                .sort({ submittedAt: -1 })
                .limit(12)
                .select('studentId classId isCorrect status language score passedTestCases totalTestCases submittedAt')
                .populate('studentId', 'name email')
                .populate('classId', 'name')
                .lean(),
            Exam.find({ ...examFilter, 'template.isTemplate': { $ne: true } })
                .select('title classId status proctoring questions createdAt')
                .populate('classId', 'name')
                .lean(),
            Exam.countDocuments({ ...examFilter, 'template.isTemplate': true }),
            Submission.countDocuments({
                questionId: qid,
                examAttemptId: { $exists: true },
                isRun: { $ne: true },
                ...(practice.classId ? { classId: practice.classId } : {}),
            }),
        ]);

        const statsByClass = new Map();
        const students = new Map();
        let submissions = 0;
        let correct = 0;
        let lastSubmittedAt = null;
        for (const p of pairs) {
            const cid = String(p._id.classId);
            const sid = String(p._id.studentId);
            const solved = p.correct > 0;
            const c = statsByClass.get(cid) || { attempted: 0, solved: 0, submissions: 0 };
            c.attempted += 1;
            c.solved += solved ? 1 : 0;
            c.submissions += p.submissions;
            statsByClass.set(cid, c);
            students.set(sid, (students.get(sid) || false) || solved);
            submissions += p.submissions;
            correct += p.correct;
            if (!lastSubmittedAt || p.lastAt > lastSubmittedAt) lastSubmittedAt = p.lastAt;
        }
        const solvedStudents = [...students.values()].filter(Boolean).length;

        const settingByClass = new Map((question.classes || []).map((c) => [String(c.classId), c]));
        const classes = classDocs
            .map((cls) => {
                const cid = String(cls._id);
                const setting = settingByClass.get(cid) || {};
                const assignment = (cls.assignments || []).find((a) => String(a.questionId) === String(qid));
                const stats = statsByClass.get(cid) || { attempted: 0, solved: 0, submissions: 0 };
                return {
                    _id: cls._id,
                    name: cls.name,
                    status: cls.status,
                    studentCount: cls.students?.length || 0,
                    isPublished: Boolean(setting.isPublished),
                    isDisabled: Boolean(setting.isDisabled),
                    publishedAt: setting.publishedAt || null,
                    assignment: assignment
                        ? { _id: assignment._id, dueDate: assignment.dueDate || null, maxPoints: assignment.maxPoints ?? null, assignedAt: assignment.assignedAt }
                        : null,
                    ...stats,
                    solveRate: stats.attempted ? Math.round((stats.solved / stats.attempted) * 100) : null,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        const examList = exams
            .map((e) => {
                const entry = (e.questions || []).find((x) => String(x.questionId) === String(qid));
                return {
                    _id: e._id,
                    title: e.title,
                    classId: e.classId?._id || e.classId || null,
                    className: e.classId?.name || null,
                    phase: examPhase(e, now),
                    startTime: e.proctoring?.startTime || null,
                    endTime: e.proctoring?.endTime || null,
                    points: entry?.points ?? null,
                    questionCount: e.questions?.length || 0,
                };
            })
            .sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));

        delete question.classes;
        res.json({
            question,
            classes,
            exams: examList,
            templateCount,
            stats: {
                students: students.size,
                solvedStudents,
                submissions,
                correct,
                accuracy: submissions ? Math.round((correct / submissions) * 100) : null,
                solveRate: students.size ? Math.round((solvedStudents / students.size) * 100) : null,
                examSubmissions,
                lastSubmittedAt,
                byStatus: Object.fromEntries(statusRaw.filter((s) => s._id).map((s) => [s._id, s.count])),
                byLanguage: languageRaw.map((l) => ({ language: l._id, count: l.count, correct: l.correct })),
            },
            recentSubmissions: recentRaw.map((s) => ({
                _id: s._id,
                student: s.studentId ? { _id: s.studentId._id, name: s.studentId.name, email: s.studentId.email } : null,
                className: s.classId?.name || null,
                isCorrect: Boolean(s.isCorrect),
                status: s.status || null,
                language: s.language || null,
                score: s.score ?? null,
                passedTestCases: s.passedTestCases || 0,
                totalTestCases: s.totalTestCases || 0,
                submittedAt: s.submittedAt,
            })),
        });
    } catch (err) {
        console.error('getQuestionOverview error:', err);
        res.status(500).json({ error: 'Failed to load question' });
    }
};

// Updated Question Management Functions
exports.adminCreateQuestion = async (req, res) => {
    console.log('[Admin Create Question] Started');
    try {
        const questionData = req.body;
        const user = req.user;

        console.log('[Admin Create Question] User:', user._id, '| Role:', user.role);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Admin Create Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can create questions' });
        }

        // Basic validation
        if (!questionData || !questionData.type || !questionData.title) {
            console.error('[Admin Create Question] Error: Type or title missing');
            return res.status(400).json({ error: 'Question type and title are required' });
        }

        // Validate question type
        const validTypes = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'];
        if (!validTypes.includes(questionData.type)) {
            console.error('[Admin Create Question] Error: Invalid type:', questionData.type);
            return res.status(400).json({ error: 'Invalid question type' });
        }

        // Common fields validation
        if (!questionData.description) {
            console.error('[Admin Create Question] Error: Description missing');
            return res.status(400).json({ error: 'Description is required' });
        }
        if (!questionData.difficulty || !['easy', 'medium', 'hard'].includes(questionData.difficulty)) {
            console.error('[Admin Create Question] Error: Invalid difficulty');
            return res.status(400).json({ error: 'Difficulty must be easy, medium, or hard' });
        }
        questionData.points = parseOptionalPoints(questionData.points);
        if (questionData.points === undefined) {
            console.error('[Admin Create Question] Error: Invalid points');
            return res.status(400).json({ error: 'Points must be a non-negative number when provided' });
        }
        if (questionData.maxAttempts && (typeof questionData.maxAttempts !== 'number' || questionData.maxAttempts <= 0)) {
            console.error('[Admin Create Question] Error: Invalid maxAttempts');
            return res.status(400).json({ error: 'maxAttempts must be a positive number' });
        }

        // Type-specific validation
        if (questionData.type === 'singleCorrectMcq') {
            if (!Array.isArray(questionData.options) || questionData.options.length < 2) {
                console.error('[Admin Create Question] Error: Insufficient options');
                return res.status(400).json({ error: 'At least two options are required for singleCorrectMcq' });
            }
            if (!questionData.options.every(opt => typeof opt === 'string' && opt.trim())) {
                console.error('[Admin Create Question] Error: Invalid options');
                return res.status(400).json({ error: 'Options must be non-empty strings' });
            }
            if (typeof questionData.correctOption !== 'number' || questionData.correctOption < 0 || questionData.correctOption >= questionData.options.length) {
                console.error('[Admin Create Question] Error: Invalid correctOption');
                return res.status(400).json({ error: 'correctOption must be a valid index' });
            }
        } else if (questionData.type === 'multipleCorrectMcq') {
            if (!Array.isArray(questionData.options) || questionData.options.length < 2) {
                console.error('[Admin Create Question] Error: Insufficient options');
                return res.status(400).json({ error: 'At least two options are required for multipleCorrectMcq' });
            }
            if (!questionData.options.every(opt => typeof opt === 'string' && opt.trim())) {
                console.error('[Admin Create Question] Error: Invalid options');
                return res.status(400).json({ error: 'Options must be non-empty strings' });
            }
            if (!Array.isArray(questionData.correctOptions) || questionData.correctOptions.length === 0) {
                console.error('[Admin Create Question] Error: No correctOptions');
                return res.status(400).json({ error: 'At least one correct option is required for multipleCorrectMcq' });
            }
            if (!questionData.correctOptions.every(idx => typeof idx === 'number' && idx >= 0 && idx < questionData.options.length)) {
                console.error('[Admin Create Question] Error: Invalid correctOptions');
                return res.status(400).json({ error: 'correctOptions must be valid indices' });
            }
        } else if (questionData.type === 'fillInTheBlanks') {
            if (!questionData.correctAnswer || typeof questionData.correctAnswer !== 'string' || !questionData.correctAnswer.trim()) {
                console.error('[Admin Create Question] Error: Invalid correctAnswer');
                return res.status(400).json({ error: 'correctAnswer must be a non-empty string' });
            }
        } else if (questionData.type === 'fillInTheBlanksCoding' || questionData.type === 'coding') {
            if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) {
                console.error('[Admin Create Question] Error: No languages');
                return res.status(400).json({ error: 'At least one language is required' });
            }
            if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) {
                console.error('[Admin Create Question] Error: Invalid languages');
                return res.status(400).json({ error: 'Invalid language specified' });
            }
            if (!Array.isArray(questionData.starterCode) || questionData.starterCode.length === 0) {
                console.error('[Admin Create Question] Error: No starterCode');
                return res.status(400).json({ error: 'Starter code is required' });
            }
            if (!questionData.starterCode.every(sc => sc.language && sc.code && questionData.languages.includes(sc.language))) {
                console.error('[Admin Create Question] Error: Invalid starterCode');
                return res.status(400).json({ error: 'Invalid starter code structure' });
            }
            if (!Array.isArray(questionData.testCases) || questionData.testCases.length === 0) {
                console.error('[Admin Create Question] Error: No test cases');
                return res.status(400).json({ error: 'At least one test case is required' });
            }
            if (!questionData.testCases.every(tc => tc.input && tc.expectedOutput && typeof tc.isPublic === 'boolean')) {
                console.error('[Admin Create Question] Error: Invalid test cases');
                return res.status(400).json({ error: 'Test cases must have input, expectedOutput, and isPublic' });
            }
            if (typeof questionData.timeLimit !== 'number' || questionData.timeLimit <= 0) {
                console.error('[Admin Create Question] Error: Invalid time limit');
                return res.status(400).json({ error: 'Time limit must be positive' });
            }
            if (typeof questionData.memoryLimit !== 'number' || questionData.memoryLimit <= 0) {
                console.error('[Admin Create Question] Error: Invalid memory limit');
                return res.status(400).json({ error: 'Memory limit must be positive' });
            }
        } else if (questionData.type === 'codingWithDriver') {
            if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) {
                console.error('[Admin Create Question] Error: No languages');
                return res.status(400).json({ error: 'At least one language is required' });
            }
            if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) {
                console.error('[Admin Create Question] Error: Invalid languages');
                return res.status(400).json({ error: 'Invalid language specified' });
            }
            if (!Array.isArray(questionData.templateCode) || questionData.templateCode.length === 0) {
                console.error('[Admin Create Question] Error: No templateCode');
                return res.status(400).json({ error: 'Template code is required for codingWithDriver' });
            }
            if (!questionData.templateCode.every(tc => tc.language && tc.code && questionData.languages.includes(tc.language))) {
                console.error('[Admin Create Question] Error: Invalid templateCode');
                return res.status(400).json({ error: 'Invalid template code structure' });
            }
            if (!Array.isArray(questionData.driverCode) || questionData.driverCode.length === 0) {
                console.error('[Admin Create Question] Error: No driverCode');
                return res.status(400).json({ error: 'Driver code is required for codingWithDriver' });
            }
            if (!questionData.driverCode.every(dc => dc.language && dc.code && questionData.languages.includes(dc.language))) {
                console.error('[Admin Create Question] Error: Invalid driverCode');
                return res.status(400).json({ error: 'Invalid driver code structure' });
            }
            if (!Array.isArray(questionData.testCases) || questionData.testCases.length === 0) {
                console.error('[Admin Create Question] Error: No test cases');
                return res.status(400).json({ error: 'At least one test case is required' });
            }
            if (!questionData.testCases.every(tc => tc.input && tc.expectedOutput && typeof tc.isPublic === 'boolean')) {
                console.error('[Admin Create Question] Error: Invalid test cases');
                return res.status(400).json({ error: 'Test cases must have input, expectedOutput, and isPublic' });
            }
            if (typeof questionData.timeLimit !== 'number' || questionData.timeLimit <= 0) {
                console.error('[Admin Create Question] Error: Invalid time limit');
                return res.status(400).json({ error: 'Time limit must be positive' });
            }
            if (typeof questionData.memoryLimit !== 'number' || questionData.memoryLimit <= 0) {
                console.error('[Admin Create Question] Error: Invalid memory limit');
                return res.status(400).json({ error: 'Memory limit must be positive' });
            }
        }

        // Check if this is a draft
        const isDraft = questionData.status === 'draft' || questionData.isDraft === true;

        normalizeQuestionRichTextFields(questionData);

        // Create question
        const question = new Question({
            ...questionData,
            createdBy: user._id,
            points: parseOptionalPoints(questionData.points),
            classes: [], // Admins don't assign to classes
            status: isDraft ? 'draft' : 'published',
            isDraft: isDraft,
            publishedAt: isDraft ? null : new Date(),
            publishedBy: isDraft ? null : user._id,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        applyDefaultSolutions(question);
        await question.save();
        console.log('[Admin Create Question] Saved:', question._id, '| Status:', question.status);

        const message = isDraft ? 'Draft saved successfully' : 'Question created successfully';
        res.status(201).json({ message, question });
    } catch (err) {
        console.error('[Admin Create Question] Error:', err.message);
        res.status(500).json({ error: 'Error creating question' });
    }
};

exports.getAllQuestionsPaginated = async (req, res) => {
    try {
        const user = req.user;
        const { page = 1, limit = 10, includeDrafts = false, q, type, difficulty, usage, sort } = req.query;

        if (!['admin', 'teacher'].includes(user.role)) {
            return res.status(403).json({ error: 'Only admin or teacher can view questions' });
        }

        const pageNum = parseInt(page, 10);
        const limitNum = Math.min(parseInt(limit, 10), 100);

        if (isNaN(pageNum) || pageNum < 1) {
            return res.status(400).json({ error: 'Invalid page number' });
        }
        if (isNaN(limitNum) || limitNum < 1) {
            return res.status(400).json({ error: 'Invalid limit' });
        }

        const filters = [];
        if (includeDrafts !== 'true') filters.push({ status: { $ne: 'draft' }, isDraft: { $ne: true } });

        const search = typeof q === 'string' ? q.trim() : '';
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            const or = [{ title: regex }, { tags: regex }];
            if (isValidObjectId(search) && /^[0-9a-f]{24}$/i.test(search)) or.push({ _id: new mongoose.Types.ObjectId(search) });
            filters.push({ $or: or });
        }
        if (type) filters.push({ type });
        if (difficulty) filters.push({ difficulty });
        if (usage === 'bank') filters.push({ isExamOnly: { $ne: true }, 'classes.0': { $exists: false } });
        if (usage === 'classes') filters.push({ 'classes.0': { $exists: true } });
        if (usage === 'exam') filters.push({ isExamOnly: true });
        if (user.role !== 'admin') {
            const classIds = await teacherClassIds(user);
            filters.push({
                $or: [
                    { createdBy: user._id },
                    { 'classes.classId': { $in: classIds } },
                    { _id: { $in: await Class.distinct('questions', { _id: { $in: classIds } }) } },
                ],
            });
        }

        const query = filters.length ? { $and: filters } : {};
        const sortBy = {
            title: { title: 1 },
            points: { points: -1, updatedAt: -1 },
            oldest: { updatedAt: 1 },
        }[sort] || { updatedAt: -1 };

        const [totalQuestions, questions] = await Promise.all([
            Question.countDocuments(query),
            Question.find(query)
                .select('title type difficulty points tags createdBy classes status isExamOnly updatedAt createdAt')
                .populate('createdBy', 'name email _id')
                .sort(sortBy)
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean(),
        ]);

        const examUsage = await Exam.aggregate([
            { $match: { 'questions.questionId': { $in: questions.map((x) => x._id) }, 'template.isTemplate': { $ne: true } } },
            { $unwind: '$questions' },
            { $group: { _id: '$questions.questionId', count: { $sum: 1 } } },
        ]);
        const examCountBy = new Map(examUsage.map((e) => [e._id.toString(), e.count]));
        for (const question of questions) {
            question.classCount = question.classes?.length || 0;
            question.examCount = examCountBy.get(question._id.toString()) || 0;
            delete question.classes;
        }

        res.status(200).json({
            questions,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalQuestions / limitNum),
                totalQuestions,
                limit: limitNum
            },
            totalPages: Math.ceil(totalQuestions / limitNum) // Also include at root level for compatibility
        });
    } catch (err) {
        console.error('[Get All Questions Paginated] Error:', err.message);
        res.status(500).json({ error: 'Error fetching questions' });
    }
};

exports.editQuestion = async (req, res) => {
    console.log('[Admin Edit Question] Editing Question:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Admin Edit Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can edit questions' });
        }
        if (!isValidObjectId(questionId)) return res.status(400).json({ error: 'Invalid question ID' });
        if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Question data is required' });

        // Ownership, publish state and class links are managed by their own endpoints.
        const questionData = Object.fromEntries(
            Object.entries(req.body).filter(([key]) => !DRAFT_PROTECTED_FIELDS.has(key) && key !== 'classIds' && key !== 'updatedAt'),
        );

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Admin Edit Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }
        if (!(await canAccessQuestion(user, question))) {
            return res.status(403).json({ error: 'You do not have access to this question' });
        }

        // Basic validation
        if (!questionData.type || !questionData.title) {
            console.error('[Admin Edit Question] Error: Missing required fields');
            return res.status(400).json({ error: 'Question type and title are required' });
        }

        const validTypes = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'];
        if (!validTypes.includes(questionData.type)) {
            console.error('[Admin Edit Question] Error: Invalid type:', questionData.type);
            return res.status(400).json({ error: 'Invalid question type' });
        }

        // Common fields validation
        if (!questionData.description) {
            console.error('[Admin Edit Question] Error: Description missing');
            return res.status(400).json({ error: 'Description is required' });
        }
        if (!questionData.difficulty || !['easy', 'medium', 'hard'].includes(questionData.difficulty)) {
            console.error('[Admin Edit Question] Error: Invalid difficulty');
            return res.status(400).json({ error: 'Difficulty must be easy, medium, or hard' });
        }
        questionData.points = parseOptionalPoints(questionData.points);
        if (questionData.points === undefined) {
            console.error('[Admin Edit Question] Error: Invalid points');
            return res.status(400).json({ error: 'Points must be a non-negative number when provided' });
        }
        if (questionData.maxAttempts && (typeof questionData.maxAttempts !== 'number' || questionData.maxAttempts <= 0)) {
            console.error('[Admin Edit Question] Error: Invalid maxAttempts');
            return res.status(400).json({ error: 'maxAttempts must be a positive number' });
        }

        // Type-specific validation
        if (questionData.type === 'singleCorrectMcq') {
            if (!Array.isArray(questionData.options) || questionData.options.length < 2) {
                console.error('[Admin Edit Question] Error: Insufficient options');
                return res.status(400).json({ error: 'At least two options are required for singleCorrectMcq' });
            }
            if (!questionData.options.every(opt => typeof opt === 'string' && opt.trim())) {
                console.error('[Admin Edit Question] Error: Invalid options');
                return res.status(400).json({ error: 'Options must be non-empty strings' });
            }
            if (typeof questionData.correctOption !== 'number' || questionData.correctOption < 0 || questionData.correctOption >= questionData.options.length) {
                console.error('[Admin Edit Question] Error: Invalid correctOption');
                return res.status(400).json({ error: 'correctOption must be a valid index' });
            }
            questionData.correctOptions = undefined; // Clear for non-multipleCorrectMcq
            questionData.correctAnswer = undefined;
            questionData.starterCode = undefined;
            questionData.templateCode = undefined;
            questionData.driverCode = undefined;
            questionData.testCases = undefined;
            questionData.languages = undefined;
            questionData.timeLimit = undefined;
            questionData.memoryLimit = undefined;
        } else if (questionData.type === 'multipleCorrectMcq') {
            if (!Array.isArray(questionData.options) || questionData.options.length < 2) {
                console.error('[Admin Edit Question] Error: Insufficient options');
                return res.status(400).json({ error: 'At least two options are required for multipleCorrectMcq' });
            }
            if (!questionData.options.every(opt => typeof opt === 'string' && opt.trim())) {
                console.error('[Admin Edit Question] Error: Invalid options');
                return res.status(400).json({ error: 'Options must be non-empty strings' });
            }
            if (!Array.isArray(questionData.correctOptions) || questionData.correctOptions.length === 0) {
                console.error('[Admin Edit Question] Error: No correctOptions');
                return res.status(400).json({ error: 'At least one correct option is required for multipleCorrectMcq' });
            }
            if (!questionData.correctOptions.every(idx => typeof idx === 'number' && idx >= 0 && idx < questionData.options.length)) {
                console.error('[Admin Edit Question] Error: Invalid correctOptions');
                return res.status(400).json({ error: 'correctOptions must be valid indices' });
            }
            questionData.correctOption = undefined; // Clear for non-singleCorrectMcq
            questionData.correctAnswer = undefined;
            questionData.starterCode = undefined;
            questionData.templateCode = undefined;
            questionData.driverCode = undefined;
            questionData.testCases = undefined;
            questionData.languages = undefined;
            questionData.timeLimit = undefined;
            questionData.memoryLimit = undefined;
        } else if (questionData.type === 'fillInTheBlanks') {
            if (!questionData.correctAnswer || typeof questionData.correctAnswer !== 'string' || !questionData.correctAnswer.trim()) {
                console.error('[Admin Edit Question] Error: Invalid correctAnswer');
                return res.status(400).json({ error: 'correctAnswer must be a non-empty string' });
            }
            questionData.options = undefined;
            questionData.correctOption = undefined;
            questionData.correctOptions = undefined;
            questionData.starterCode = undefined;
            questionData.templateCode = undefined;
            questionData.driverCode = undefined;
            questionData.testCases = undefined;
            questionData.languages = undefined;
            questionData.timeLimit = undefined;
            questionData.memoryLimit = undefined;
        } else if (questionData.type === 'fillInTheBlanksCoding' || questionData.type === 'coding') {
            if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) {
                console.error('[Admin Edit Question] Error: No languages provided');
                return res.status(400).json({ error: 'At least one language required for coding questions' });
            }
            if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) {
                console.error('[Admin Edit Question] Error: Invalid language');
                return res.status(400).json({ error: 'Invalid language specified' });
            }
            if (!Array.isArray(questionData.starterCode) || questionData.starterCode.length === 0) {
                console.error('[Admin Edit Question] Error: No starterCode');
                return res.status(400).json({ error: 'Starter code required for coding questions' });
            }
            if (!questionData.starterCode.every(sc => sc.language && sc.code && questionData.languages.includes(sc.language))) {
                console.error('[Admin Edit Question] Error: Invalid starterCode structure');
                return res.status(400).json({ error: 'Invalid starter code structure' });
            }
            if (!Array.isArray(questionData.testCases) || questionData.testCases.length === 0) {
                console.error('[Admin Edit Question] Error: No test cases');
                return res.status(400).json({ error: 'At least one test case required for coding questions' });
            }
            if (!questionData.testCases.every(tc => tc.input && tc.expectedOutput && typeof tc.isPublic === 'boolean')) {
                console.error('[Admin Edit Question] Error: Invalid test cases');
                return res.status(400).json({ error: 'Test cases must have input, expectedOutput, and isPublic' });
            }
            if (typeof questionData.timeLimit !== 'number' || questionData.timeLimit <= 0) {
                console.error('[Admin Edit Question] Error: Invalid time limit');
                return res.status(400).json({ error: 'Time limit must be positive' });
            }
            if (typeof questionData.memoryLimit !== 'number' || questionData.memoryLimit <= 0) {
                console.error('[Admin Edit Question] Error: Invalid memory limit');
                return res.status(400).json({ error: 'Memory limit must be positive' });
            }
            questionData.options = undefined;
            questionData.correctOption = undefined;
            questionData.correctOptions = undefined;
            questionData.correctAnswer = undefined;
            questionData.templateCode = undefined;
            questionData.driverCode = undefined;
        } else if (questionData.type === 'codingWithDriver') {
            if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) {
                console.error('[Admin Edit Question] Error: No languages provided');
                return res.status(400).json({ error: 'At least one language required for coding questions' });
            }
            if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) {
                console.error('[Admin Edit Question] Error: Invalid language');
                return res.status(400).json({ error: 'Invalid language specified' });
            }
            if (!Array.isArray(questionData.templateCode) || questionData.templateCode.length === 0) {
                console.error('[Admin Edit Question] Error: No templateCode');
                return res.status(400).json({ error: 'Template code required for codingWithDriver' });
            }
            if (!questionData.templateCode.every(tc => tc.language && tc.code && questionData.languages.includes(tc.language))) {
                console.error('[Admin Edit Question] Error: Invalid templateCode structure');
                return res.status(400).json({ error: 'Invalid template code structure' });
            }
            if (!Array.isArray(questionData.driverCode) || questionData.driverCode.length === 0) {
                console.error('[Admin Edit Question] Error: No driverCode');
                return res.status(400).json({ error: 'Driver code required for codingWithDriver' });
            }
            if (!questionData.driverCode.every(dc => dc.language && dc.code && questionData.languages.includes(dc.language))) {
                console.error('[Admin Edit Question] Error: Invalid driverCode structure');
                return res.status(400).json({ error: 'Invalid driver code structure' });
            }
            if (!Array.isArray(questionData.testCases) || questionData.testCases.length === 0) {
                console.error('[Admin Edit Question] Error: No test cases');
                return res.status(400).json({ error: 'At least one test case required for coding questions' });
            }
            if (!questionData.testCases.every(tc => tc.input && tc.expectedOutput && typeof tc.isPublic === 'boolean')) {
                console.error('[Admin Edit Question] Error: Invalid test cases');
                return res.status(400).json({ error: 'Test cases must have input, expectedOutput, and isPublic' });
            }
            if (typeof questionData.timeLimit !== 'number' || questionData.timeLimit <= 0) {
                console.error('[Admin Edit Question] Error: Invalid time limit');
                return res.status(400).json({ error: 'Time limit must be positive' });
            }
            if (typeof questionData.memoryLimit !== 'number' || questionData.memoryLimit <= 0) {
                console.error('[Admin Edit Question] Error: Invalid memory limit');
                return res.status(400).json({ error: 'Memory limit must be positive' });
            }
            questionData.options = undefined;
            questionData.correctOption = undefined;
            questionData.correctOptions = undefined;
            questionData.correctAnswer = undefined;
            questionData.starterCode = undefined;
        }

        normalizeQuestionRichTextFields(questionData);

        // Update question
        Object.assign(question, {
            ...questionData,
            updatedAt: new Date(),
        });
        applyDefaultSolutions(question);
        await question.save();

        // Emit updates to associated classes
        for (const classEntry of question.classes) {
            req.io.to(`class:${classEntry.classId}`).emit('questionUpdated', {
                questionId: question._id,
                updatedFields: questionData,
            });
        }

        console.log('[Admin Edit Question] Question updated:', question._id);
        res.status(200).json({ message: 'Question updated successfully', question });
    } catch (err) {
        console.error('[Admin Edit Question] Error:', err.message);
        res.status(500).json({ error: 'Error editing question' });
    }
};

exports.deleteQuestion = async (req, res) => {
    try {
        const { questionId } = req.params;
        const user = req.user;

        if (!['admin'].includes(user.role)) {
            return res.status(403).json({ error: 'Only admin can delete questions' });
        }
        if (!isValidObjectId(questionId)) {
            return res.status(400).json({ error: 'Invalid questionId format' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }

        const exams = await Exam.find({ 'questions.questionId': question._id, 'template.isTemplate': { $ne: true } })
            .select('title')
            .lean();
        if (exams.length) {
            const names = exams.slice(0, 3).map((e) => `"${e.title}"`).join(', ');
            return res.status(409).json({
                error: `This question is used in ${exams.length} exam${exams.length === 1 ? '' : 's'} (${names}${exams.length > 3 ? ', …' : ''}). Remove it from those exams first.`,
            });
        }

        // Update related documents
        await Class.updateMany(
            { _id: { $in: question.classes.map(c => c.classId) } },
            { $pull: { questions: question._id } }
        );

        await Submission.deleteMany({ questionId });
        await Leaderboard.updateMany(
            { classId: { $in: question.classes.map(c => c.classId) } },
            { $pull: { attempts: { questionId } } }
        );

        await question.deleteOne();
        console.log('[Admin Delete Question] Deleted:', questionId);

        // Emit deletion to associated classes
        for (const classEntry of question.classes) {
            req.io.to(`class:${classEntry.classId}`).emit('questionDeleted', { questionId });
        }

        res.status(200).json({ message: 'Question deleted successfully' });
    } catch (err) {
        console.error('[Admin Delete Question] Error:', err.message);
        res.status(500).json({ error: 'Error deleting question' });
    }
};

exports.searchQuestionsById = async (req, res) => {
    console.log('[Search Questions By ID] Searching question:', req.query.questionId);
    try {
        const { questionId } = req.query;
        const user = req.user;

        console.log('[Search Questions By ID] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Search Questions By ID] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can search questions' });
        }

        if (!questionId || !mongoose.Types.ObjectId.isValid(questionId)) {
            console.error('[Search Questions By ID] Error: Invalid questionId');
            return res.status(400).json({ error: 'Valid questionId is required' });
        }

        const question = await Question.findById(questionId).lean();
        if (!question) {
            console.error('[Search Questions By ID] Error: Question not found');
            return res.status(404).json({ error: 'Question not found' });
        }
        if (!(await canAccessQuestion(user, question))) {
            return res.status(403).json({ error: 'You do not have access to this question' });
        }

        console.log('[Search Questions By ID] Question found:', questionId);
        res.status(200).json({ question });
    } catch (err) {
        console.error('[Search Questions By ID] Error:', err.message);
        res.status(500).json({ error: 'Error searching question by ID' });
    }
};

// Create draft question
exports.createDraftQuestion = async (req, res) => {
    console.log('[Create Draft Question] Started');
    try {
        const questionData = req.body;
        const user = req.user;

        console.log('[Create Draft Question] User:', user._id, '| Role:', user.role);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Create Draft Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can create drafts' });
        }

        // Basic validation - drafts can have minimal data
        if (!questionData || !questionData.type) {
            console.error('[Create Draft Question] Error: Type missing');
            return res.status(400).json({ error: 'Question type is required' });
        }

        // Validate question type
        const validTypes = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'];
        if (!validTypes.includes(questionData.type)) {
            console.error('[Create Draft Question] Error: Invalid type:', questionData.type);
            return res.status(400).json({ error: 'Invalid question type' });
        }

        // Create draft question with minimal validation
        const draftQuestion = new Question({
            ...questionData,
            title: questionData.title || 'Untitled Question',
            description: questionData.description || '',
            difficulty: questionData.difficulty || 'easy',
            createdBy: user._id,
            status: 'draft',
            isDraft: true,
            points: parseOptionalPoints(questionData.points),
            classes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        applyDefaultSolutions(draftQuestion);
        await draftQuestion.save();
        console.log('[Create Draft Question] Draft saved:', draftQuestion._id);

        res.status(201).json({ message: 'Draft created successfully', question: draftQuestion });
    } catch (err) {
        console.error('[Create Draft Question] Error:', err.message);
        res.status(500).json({ error: 'Error creating draft' });
    }
};

// Get all drafts
exports.getDrafts = async (req, res) => {
    console.log('[Get Drafts] Fetching drafts');
    try {
        const user = req.user;
        const { page = 1, limit = 20, search = '' } = req.query;

        if (!['admin', 'teacher'].includes(user.role)) {
            return res.status(403).json({ error: 'Only admin or teacher can view drafts' });
        }

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

        const query = {
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        };

        if (typeof search === 'string' && search.trim()) {
            const regex = new RegExp(escapeRegex(search.trim()), 'i');
            query.$or = [{ title: regex }, { tags: regex }];
        }

        const [docs, totalDrafts] = await Promise.all([
            Question.find(query)
                .sort({ updatedAt: -1 })
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .select('title type description difficulty tags points createdAt updatedAt status languages testCases options correctOption correctOptions correctAnswer')
                .lean(),
            Question.countDocuments(query),
        ]);

        const drafts = docs.map(({ languages, testCases, options, correctOption, correctOptions, correctAnswer, ...draft }) => ({
            ...draft,
            issues: getDraftIssues({ ...draft, languages, testCases, options, correctOption, correctOptions, correctAnswer }),
        }));

        res.status(200).json({
            drafts,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalDrafts / limitNum),
                totalDrafts,
                limit: limitNum
            }
        });
    } catch (err) {
        console.error('[Get Drafts] Error:', err.message);
        res.status(500).json({ error: 'Error fetching drafts' });
    }
};

// Get draft count
exports.getDraftCount = async (req, res) => {
    console.log('[Get Draft Count] Fetching draft count');
    try {
        const user = req.user;

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Get Draft Count] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view draft count' });
        }

        const count = await Question.countDocuments({
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        });

        console.log('[Get Draft Count] Count:', count);
        res.status(200).json({ count });
    } catch (err) {
        console.error('[Get Draft Count] Error:', err.message);
        res.status(500).json({ error: 'Error fetching draft count' });
    }
};

// Get single draft
exports.getDraftQuestion = async (req, res) => {
    console.log('[Get Draft Question] Fetching draft:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Get Draft Question] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Get Draft Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view drafts' });
        }

        if (!questionId || !mongoose.Types.ObjectId.isValid(questionId)) {
            console.error('[Get Draft Question] Error: Invalid questionId');
            return res.status(400).json({ error: 'Valid questionId is required' });
        }

        const question = await Question.findOne({
            _id: questionId,
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        }).lean();

        if (!question) {
            console.error('[Get Draft Question] Error: Draft not found');
            return res.status(404).json({ error: 'Draft not found' });
        }

        console.log('[Get Draft Question] Draft found:', questionId);
        res.status(200).json({ question });
    } catch (err) {
        console.error('[Get Draft Question] Error:', err.message);
        res.status(500).json({ error: 'Error fetching draft' });
    }
};

// Update draft
exports.updateDraftQuestion = async (req, res) => {
    console.log('[Update Draft Question] Updating draft:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const questionData = req.body;
        const user = req.user;

        console.log('[Update Draft Question] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Update Draft Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can update drafts' });
        }

        if (!questionId || !mongoose.Types.ObjectId.isValid(questionId)) {
            console.error('[Update Draft Question] Error: Invalid questionId');
            return res.status(400).json({ error: 'Valid questionId is required' });
        }

        const question = await Question.findOne({
            _id: questionId,
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        });

        if (!question) {
            console.error('[Update Draft Question] Error: Draft not found');
            return res.status(404).json({ error: 'Draft not found' });
        }

        normalizeQuestionRichTextFields(questionData);

        // Update question data
        Object.keys(questionData).forEach(key => {
            if (questionData[key] !== undefined) {
                question[key] = questionData[key];
            }
        });

        question.updatedAt = new Date();
        await question.save();

        console.log('[Update Draft Question] Draft updated:', questionId);
        res.status(200).json({ message: 'Draft updated successfully', question });
    } catch (err) {
        console.error('[Update Draft Question] Error:', err.message);
        res.status(500).json({ error: 'Error updating draft' });
    }
};

// Publish draft (convert to published)
exports.publishDraftQuestion = async (req, res) => {
    console.log('[Publish Draft Question] Publishing draft:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const questionData = req.body; // Optional: final question data
        const user = req.user;

        console.log('[Publish Draft Question] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Publish Draft Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can publish drafts' });
        }

        if (!questionId || !mongoose.Types.ObjectId.isValid(questionId)) {
            console.error('[Publish Draft Question] Error: Invalid questionId');
            return res.status(400).json({ error: 'Valid questionId is required' });
        }

        if (user.role === 'teacher' && !user.canCreateQuestion) {
            return res.status(403).json({ error: 'You do not have permission to publish questions' });
        }

        const question = await Question.findOne({
            _id: questionId,
            status: 'draft',
            isDraft: true,
            ...(user.role === 'admin' ? {} : { createdBy: user._id }),
        });

        if (!question) {
            return res.status(404).json({ error: 'Draft not found' });
        }

        if (questionData && typeof questionData === 'object') {
            normalizeQuestionRichTextFields(questionData);
            Object.keys(questionData).forEach((key) => {
                if (!DRAFT_PROTECTED_FIELDS.has(key) && questionData[key] !== undefined) {
                    question[key] = questionData[key];
                }
            });
        }

        const issues = getDraftIssues(question);
        if (issues.length) {
            return res.status(400).json({ error: `Can't publish yet: ${issues.join(', ')}`, issues });
        }

        // Publish the question
        question.status = 'published';
        question.isDraft = false;
        question.publishedAt = new Date();
        question.publishedBy = user._id;
        question.updatedAt = new Date();

        await question.save();

        console.log('[Publish Draft Question] Draft published:', questionId);
        res.status(200).json({ message: 'Question published successfully', question });
    } catch (err) {
        console.error('[Publish Draft Question] Error:', err.message);
        res.status(500).json({ error: 'Error publishing draft' });
    }
};

// Delete draft
exports.deleteDraftQuestion = async (req, res) => {
    console.log('[Delete Draft Question] Deleting draft:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Delete Draft Question] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Delete Draft Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can delete drafts' });
        }

        if (!questionId || !mongoose.Types.ObjectId.isValid(questionId)) {
            console.error('[Delete Draft Question] Error: Invalid questionId');
            return res.status(400).json({ error: 'Valid questionId is required' });
        }

        const question = await Question.findOne({
            _id: questionId,
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        });

        if (!question) {
            console.error('[Delete Draft Question] Error: Draft not found');
            return res.status(404).json({ error: 'Draft not found' });
        }

        await question.deleteOne();

        console.log('[Delete Draft Question] Draft deleted:', questionId);
        res.status(200).json({ message: 'Draft deleted successfully' });
    } catch (err) {
        console.error('[Delete Draft Question] Error:', err.message);
        res.status(500).json({ error: 'Error deleting draft' });
    }
};

// Student Management Functions
exports.editStudent = async (req, res) => {
    console.log('[Edit Student] Editing student:', req.params.studentId);
    try {
        const { studentId } = req.params;
        const { name, email, number } = req.body;
        const user = req.user;

        console.log('[Edit Student] User:', user._id, 'Role:', user.role);

        if (!['admin'].includes(user.role)) {
            console.warn('[Edit Student] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can edit students' });
        }

        if (!isValidObjectId(studentId)) {
            console.error('[Edit Student] Error: Invalid studentId');
            return res.status(400).json({ error: 'Valid studentId is required' });
        }

        const student = await User.findById(studentId);
        if (!student) {
            console.error('[Edit Student] Error: Student not found');
            return res.status(404).json({ error: 'Student not found' });
        }

        if (student.role !== 'student') {
            console.error('[Edit Student] Error: User is not a student');
            return res.status(400).json({ error: 'User is not a student' });
        }

        const cleanName = typeof name === 'string' ? name.trim() : undefined;
        const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : undefined;
        if (cleanName === '') return res.status(400).json({ error: 'Name cannot be empty' });
        if (cleanEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return res.status(400).json({ error: 'Enter a valid email address' });
        }

        if (cleanEmail && cleanEmail !== student.email) {
            const existingUser = await User.findOne({ email: cleanEmail, _id: { $ne: studentId } });
            if (existingUser) {
                return res.status(409).json({ error: 'Another account already uses this email' });
            }
        }

        const updateData = {};
        if (cleanName) updateData.name = cleanName;
        if (cleanEmail) updateData.email = cleanEmail;
        if (number !== undefined) updateData.number = String(number).trim();

        Object.assign(student, updateData);
        await student.save();

        console.log('[Edit Student] Student updated:', studentId);
        res.status(200).json({ 
            message: 'Student updated successfully', 
            student: {
                _id: student._id,
                name: student.name,
                email: student.email,
                number: student.number
            }
        });
    } catch (err) {
        console.error('[Edit Student] Error:', err.message);
        res.status(500).json({ error: 'Error editing student' });
    }
};

exports.deleteStudent = async (req, res) => {
    console.log('[Delete Student] Deleting student:', req.params.studentId);
    try {
        const { studentId } = req.params;
        const user = req.user;

        console.log('[Delete Student] User:', user._id, 'Role:', user.role);

        if (!['admin'].includes(user.role)) {
            console.warn('[Delete Student] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can delete students' });
        }

        if (!isValidObjectId(studentId)) {
            console.error('[Delete Student] Error: Invalid studentId');
            return res.status(400).json({ error: 'Valid studentId is required' });
        }

        const student = await User.findById(studentId);
        if (!student) {
            console.error('[Delete Student] Error: Student not found');
            return res.status(404).json({ error: 'Student not found' });
        }

        if (student.role !== 'student') {
            console.error('[Delete Student] Error: User is not a student');
            return res.status(400).json({ error: 'User is not a student' });
        }

        // Remove student from all classes
        await Class.updateMany(
            { students: studentId },
            { $pull: { students: studentId } }
        );

        await Promise.all([
            Submission.deleteMany({ studentId }),
            Leaderboard.deleteMany({ studentId }),
            ExamAttempt.deleteMany({ studentId }),
        ]);

        // Delete the student
        await student.deleteOne();

        console.log('[Delete Student] Student deleted:', studentId);
        res.status(200).json({ message: 'Student deleted successfully' });
    } catch (err) {
        console.error('[Delete Student] Error:', err.message);
        res.status(500).json({ error: 'Error deleting student' });
    }
};