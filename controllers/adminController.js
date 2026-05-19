const fs = require('fs').promises;
const xlsx = require('xlsx');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Class = require('../models/Class');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Leaderboard = require('../models/Leaderboard');
const generatePassword = require('../utils/generatePassword');
const sendEmail = require('../utils/sendEmail');
const { normalizeQuestionRichTextFields } = require('../utils/normalizeRichTextField');
const mongoose = require('mongoose');
const supportedLanguages = ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'];

// Helper function to validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Case-insensitive email lookup (unique index is exact string; DB may have mixed case). */
async function findUserByEmailInsensitive(email) {
    const trimmed = String(email).trim();
    if (!trimmed) return null;
    const safe = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return User.findOne({ email: { $regex: new RegExp(`^${safe}$`, 'i') } });
}

// Helper function to validate question data
const validateQuestion = async (questionId) => {
    const question = await Question.findById(questionId);
   
    return question;
};


 exports.uploadExcel = async (req, res) => {
    try {
        console.log('uploadExcel: Starting, file:', req.file?.path, 'role:', req.body.role);
        
        // Check if file exists
        if (!req.file) {
            console.error('uploadExcel: No file uploaded');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Check if file path exists
        if (!req.file.path) {
            console.error('uploadExcel: No file path');
            return res.status(400).json({ error: 'File upload failed' });
        }

        console.log('uploadExcel: File details:', {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path
        });

        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        console.log('uploadExcel: Excel data parsed:', data);
        
        // Log the first entry to see available columns
        if (data.length > 0) {
            console.log('uploadExcel: Available columns in first entry:', Object.keys(data[0]));
        }

        if (!data || data.length === 0) {
            console.error('uploadExcel: No data found in Excel file');
            return res.status(400).json({ error: 'No data found in Excel file' });
        }

        const created = [];
        const skipped = [];
        const invalid = [];
        const seenInFile = new Set();

        for (const entry of data) {
            console.log('uploadExcel: Processing entry:', entry);
            
            // Handle different column name formats (case-insensitive)
            const name = entry.name || entry.Name || entry.NAME;
            const email = entry.email || entry.Email || entry.EMAIL;
            const number = entry.number || entry.Number || entry.NUMBER || entry.phone || entry.Phone || entry.PHONE;
            
            // Validate required fields
            if (!name || !email || number === undefined || number === null || String(number).trim() === '') {
                console.error('uploadExcel: Missing required fields in entry:', entry);
                console.error('uploadExcel: Extracted fields:', { name, email, number });
                invalid.push({ email: email || '(missing)', reason: 'missing_name_email_or_number' });
                continue;
            }

            const emailNorm = String(email).trim().toLowerCase();
            if (seenInFile.has(emailNorm)) {
                skipped.push({ email: emailNorm, reason: 'duplicate_in_file' });
                continue;
            }
            seenInFile.add(emailNorm);

            const existing = await findUserByEmailInsensitive(email);
            if (existing) {
                console.log('uploadExcel: Skipping existing user:', emailNorm);
                skipped.push({ email: emailNorm, reason: 'already_registered' });
                continue;
            }

            const password = generatePassword();
            console.log('uploadExcel: Generated password:', password);
            const hashedPassword = await bcrypt.hash(password, 10);
            console.log('uploadExcel: Password hashed');

            const user = new User({
                name: String(name).trim(),
                email: emailNorm,
                number: String(number),
                role: req.body.role,
                password: hashedPassword
            });
            console.log('uploadExcel: User object created:', { name: user.name, email: user.email, role: user.role });

            await user.save();
            console.log('uploadExcel: User saved:', user._id);
            created.push({ email: emailNorm, id: user._id });

            try {
                await sendEmail(
                    emailNorm,
                    'Your Login Credentials',
                    `Email: ${emailNorm}\nPassword: ${password}\nRole: ${req.body.role}`
                );
                console.log('uploadExcel: Email sent to:', emailNorm);
            } catch (emailError) {
                console.error('uploadExcel: Failed to send email to:', emailNorm, emailError);
            }
        }

        const parts = [];
        if (created.length) parts.push(`${created.length} user(s) created`);
        if (skipped.length) parts.push(`${skipped.length} skipped (duplicate or already registered)`);
        if (invalid.length) parts.push(`${invalid.length} row(s) invalid (missing fields)`);
        const message = parts.length ? parts.join('. ') + '.' : 'No changes made.';

        console.log('uploadExcel: Done.', { created: created.length, skipped: skipped.length, invalid: invalid.length });
        res.status(200).json({
            message,
            created: created.length,
            skipped,
            invalid
        });
    } catch (err) {
        console.error('uploadExcel: Error:', err);
        res.status(500).json({ error: 'Error processing file: ' + err.message });
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
            console.log('createClass: Excel data parsed:', data);

            const emailKey = Object.keys(data[0] || {}).find(key => 
                key.trim().toLowerCase() === 'email'
            );
            console.log('createClass: Email column key:', emailKey);

            if (!emailKey) {
                console.log('createClass: Validation failed: No email column found');
                return res.status(400).json({ error: 'Excel must contain an email column' });
            }

            const emails = data
                .map(entry => entry[emailKey]?.trim())
                .filter(email => email && typeof email === 'string');
            console.log('createClass: Extracted emails:', emails);

            if (emails.length === 0) {
                console.log('createClass: Validation failed: No valid emails found');
                return res.status(400).json({ error: 'No valid emails found in Excel' });
            }

            const students = await User.find({ email: { $in: emails }, role: 'student' }).select('_id');
            console.log('createClass: Students found in database:', students);

            if (students.length === 0) {
                console.log('createClass: Validation failed: No valid students found for emails:', emails);
                return res.status(400).json({ error: 'No valid students found in Excel' });
            }

            newClass.students = students.map(student => student._id);
            console.log('createClass: Students assigned to class:', newClass.students);
        }

        await newClass.save();
        console.log('createClass: Class saved successfully:', newClass);

        res.status(201).json({ message: 'Class created successfully', class: newClass });
    } catch (err) {
        console.error('createClass: Error:', err);
        res.status(500).json({ error: 'Error creating class' });
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

        const teacher = await User.findById(teacherId);
        console.log('manageTeacherPermission: Teacher lookup:', teacher ? { id: teacher._id, role: teacher.role } : 'Not found');

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
        console.log('getAllClasses: Request received, user:', { id: userId, role: userRole, userIdType: typeof userId }, 'search:', search);
        
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
            console.log('getAllClasses: Filtering classes for teacher:', userId.toString(), 'Query:', JSON.stringify(query));
        } else if (userRole === 'student') {
            query = {
                students: mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId
            };
            console.log('getAllClasses: Filtering classes for student:', userId.toString());
        }
        // Admin sees all classes (no additional filter)
        
        // If search parameter is provided, add search filter
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i'); // Case-insensitive search
            
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
            console.log('getAllClasses: Applying search filter:', { search, matchingUsersCount: matchingUserIds.length });
        }
        
        console.log('getAllClasses: Final query:', JSON.stringify(query, null, 2));
        const classes = await Class.find(query)
            .populate('createdBy', 'name email')
            .populate('students', 'name email')
            .populate('teachers', 'name email')
            .populate('questions', 'title type description points classes');
        
        console.log('getAllClasses: Classes fetched:', classes.length, 'for role:', userRole);
        if (userRole === 'teacher' && classes.length > 0) {
            console.log('getAllClasses: Sample class teachers:', classes[0].teachers?.map(t => t._id?.toString()));
            console.log('getAllClasses: Sample class createdBy:', classes[0].createdBy?._id?.toString());
        }
        res.status(200).json({ classes });
    } catch (err) {
        console.error('getAllClasses: Error:', err);
        res.status(500).json({ error: 'Error fetching classes' });
    }
};

exports.getAllTeachers = async (req, res) => {
    try {
        const { search } = req.query;
        console.log('getAllTeachers: Request received, user:', { id: req.user._id, role: req.user.role }, 'search:', search);
        
        // Build query
        let query = { role: 'teacher' };
        
        // If search parameter is provided, search by teacher name or email
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i'); // Case-insensitive search
            query = {
                role: 'teacher',
                $or: [
                    { name: searchRegex },
                    { email: searchRegex }
                ]
            };
            console.log('getAllTeachers: Applying search filter:', { search });
        }
        
        const teachers = await User.find(query).select('name email canCreateQuestion');
        console.log('getAllTeachers: Teachers fetched:', teachers.length);
        res.status(200).json({ teachers });
    } catch (err) {
        console.error('getAllTeachers: Error:', err);
        res.status(500).json({ error: 'Error fetching teachers' });
    }
};

exports.getAllStudents = async (req, res) => {
    try {
        const { search } = req.query;
        console.log('getAllStudents: Request received, user:', { id: req.user._id, role: req.user.role }, 'search:', search);
        
        // Build query
        let query = { role: 'student' };
        
        // If search parameter is provided, search by student name, email, or number
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i'); // Case-insensitive search
            query = {
                role: 'student',
                $or: [
                    { name: searchRegex },
                    { email: searchRegex },
                    { number: searchRegex }
                ]
            };
            console.log('getAllStudents: Applying search filter:', { search });
        }
        
        const students = await User.find(query).select('name email number');
        console.log('getAllStudents: Students fetched:', students.length);
        
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

        if (classData.teachers.includes(teacherId)) {
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

        if (!classData.teachers.includes(teacherId)) {
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

        if (!classData.students.includes(studentId)) {
            console.error('[removeStudentFromClass] Validation failed: Student not enrolled');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        classData.students = classData.students.filter(id => id.toString() !== studentId.toString());
        await classData.save();
        console.log('[removeStudentFromClass] Student removed:', studentId);

        // Remove student-related data
        await Submission.deleteMany({ classId, studentId });
        await Leaderboard.deleteMany({ classId, studentId });
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

        if (req.user.role !== 'admin') {
            console.error('[editClass] Authorization failed: User is not admin');
            return res.status(403).json({ error: 'Unauthorized: Admins only' });
        }

        if (!isValidObjectId(classId)) {
            console.error('[editClass] Validation failed: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[editClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (name) classData.name = name;
        if (description) classData.description = description;

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

exports.changeClassStatus = async (req, res) => {
    try {
        const { classId } = req.params;
        const { status } = req.body;
        console.log('changeClassStatus: Request received:', { classId, status, user: { id: req.user._id, role: req.user.role } });

        if (req.user.role !== 'admin') {
            console.log('changeClassStatus: Authorization failed: User is not admin');
            return res.status(403).json({ error: 'Unauthorized: Admins only' });
        }

        if (!['active', 'inactive'].includes(status)) {
            console.log('changeClassStatus: Validation failed: Invalid status');
            return res.status(400).json({ error: 'Status must be active or inactive' });
        }

        const classData = await Class.findById(classId);
        console.log('changeClassStatus: Class lookup:', classData ? { id: classData._id, name: classData.name } : 'Not found');

        if (!classData) {
            console.log('changeClassStatus: Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        classData.status = status;
        await classData.save();
        console.log('changeClassStatus: Class status updated:', classData);

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
        await Submission.deleteMany({ classId });
        await Leaderboard.deleteMany({ classId });
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
        const userId = req.user._id;
        console.log('getClassDetails: Request received:', { classId, user: { id: userId, role: req.user.role } });

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

        if (!classData.questions.includes(questionId)) {
            console.error('[createAssignment] Validation failed: Question not associated with class');
            return res.status(400).json({ error: 'Question is not associated with this class' });
        }

        const assignment = {
            questionId,
            assignedAt: new Date(),
            dueDate: dueDate ? new Date(dueDate) : undefined,
            maxPoints,
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
        console.log('getAssignments: Request received:', { classId, user: { id: req.user._id, role: req.user.role } });

        const classData = await Class.findById(classId)
            .populate('assignments.questionId', 'title')
            .lean();
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        console.log('getAssignments: Assignments retrieved:', classData.assignments.length);
        res.status(200).json({ assignments: classData.assignments });
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

        const classData = await Class.findById(classId);
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (!classData.students.includes(studentId)) {
            console.log('Error: Student not enrolled in class');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        const student = await User.findById(studentId);
        if (!student || student.role !== 'student') {
            console.log('Error: Student not found or invalid role');
            return res.status(404).json({ error: 'Student not found' });
        }

        student.isBlocked.set(classId, isBlocked);
        await student.save();

        req.io.to(`class:${classId}`).emit('userBlocked', { classId, studentId, isBlocked });
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
        const { isBlocked } = req.body;
        console.log('blockAllUsers: Request received:', { classId, isBlocked, user: { id: req.user._id, role: req.user.role } });

        if (typeof isBlocked !== 'boolean') {
            console.log('Error: Invalid isBlocked field');
            return res.status(400).json({ error: 'isBlocked (boolean) is required' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.log('Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        await User.updateMany(
            { _id: { $in: classData.students }, role: 'student' },
            { $set: { [`isBlocked.${classId}`]: isBlocked } }
        );

        req.io.to(`class:${classId}`).emit('allUsersBlocked', { classId, isBlocked });
        console.log('blockAllUsers:', isBlocked ? 'Blocked' : 'Unblocked', 'all students');

        res.status(200).json({ message: `All students ${isBlocked ? 'blocked' : 'unblocked'} successfully` });
    } catch (err) {
        console.error('blockAllUsers: Error:', err);
        res.status(500).json({ error: 'Error updating block status' });
    }
};

exports.searchLeaderboard = async (req, res) => {
    try {
        console.log('searchLeaderboard: Controller invoked');
        const { classId } = req.params;
        console.log('searchLeaderboard: Request params:', { classId, query: req.query });

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            console.log('searchLeaderboard: Error: Invalid classId format');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId);
        console.log('searchLeaderboard: Class data:', classData);
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

        console.log('searchLeaderboard: Query:', query);
        let leaderboard = await Leaderboard.find(query)
            .populate('studentId', 'name email isBlocked')
            .lean();
        console.log('searchLeaderboard: Raw leaderboard count:', leaderboard.length);
        console.log('searchLeaderboard: Detailed leaderboard entries:');
        leaderboard.forEach((entry, idx) => {
            const isBlockedForClass = entry.studentId?.isBlocked ? entry.studentId.isBlocked[classId] || false : false;
            console.log(`  [${idx}] Student: ${entry.studentId?.name}, needsFocus: ${entry.needsFocus}, activityStatus: ${entry.activityStatus}, totalSubmits: ${entry.totalSubmits}, isBlocked: ${isBlockedForClass}`);
        });

        if (name) {
            const studentIds = await User.find(
                { name: { $regex: name, $options: 'i' }, role: 'student' },
                { _id: 1 }
            ).lean();
            console.log('searchLeaderboard: Matching student IDs:', studentIds);
            leaderboard = leaderboard.filter(entry =>
                studentIds.some(sid => sid._id.toString() === entry.studentId._id.toString())
            );
            if (studentIds.length === 0) {
                console.log('searchLeaderboard: No students found for name:', name);
            }
        }

        // Add isBlocked status from User model to each leaderboard entry
        leaderboard = leaderboard.map(entry => {
            const isBlockedForClass = entry.studentId?.isBlocked ? (entry.studentId.isBlocked[classId] || false) : false;
            return {
                ...entry,
                isBlocked: isBlockedForClass
            };
        });
        
        console.log('searchLeaderboard: Final leaderboard count:', leaderboard.length);
        console.log('searchLeaderboard: Returning to frontend:');
        leaderboard.forEach((entry, idx) => {
            console.log(`  [${idx}] Returning - Student: ${entry.studentId?.name}, needsFocus: ${entry.needsFocus}, activityStatus: ${entry.activityStatus}, isBlocked: ${entry.isBlocked}`);
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

        if (!classData.students.includes(studentId)) {
            console.error('[blockUnblockStudent] Validation failed: Student not enrolled');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        if (req.user.role === 'teacher' && !classData.teachers.includes(req.user._id)) {
            console.error('[blockUnblockStudent] Authorization failed: Teacher not assigned to class');
            return res.status(403).json({ error: 'Teacher not assigned to this class' });
        }

        console.log('[blockUnblockStudent] Current isBlocked status for this class:', student.isBlocked.get(classId));
        console.log('[blockUnblockStudent] Setting isBlocked to:', isBlocked);
        
        student.isBlocked.set(classId, isBlocked);
        await student.save();
        
        console.log('[blockUnblockStudent] ✅ Student saved successfully!');
        console.log('[blockUnblockStudent] Final isBlocked status:', student.isBlocked.get(classId));
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

        if (!classData.students.includes(studentId)) {
            console.error('[focusUnfocusStudent] Validation failed: Student not enrolled');
            return res.status(400).json({ error: 'Student not enrolled in class' });
        }

        if (req.user.role === 'teacher' && !classData.teachers.includes(req.user._id)) {
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

// Updated Question Management Functions
exports.adminCreateQuestion = async (req, res) => {
    console.log('[Admin Create Question] Started');
    try {
        const questionData = req.body;
        const user = req.user;

        console.log('[Admin Create Question] User:', user._id, '| Role:', user.role);

        // Authorization check
        if (!['admin'].includes(user.role)) {
            console.warn('[Admin Create Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can create questions' });
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
        if (questionData.points && (typeof questionData.points !== 'number' || questionData.points <= 0)) {
            console.error('[Admin Create Question] Error: Invalid points');
            return res.status(400).json({ error: 'Points must be a positive number' });
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
            points: questionData.points || (questionData.type === 'singleCorrectMcq' ? 10 : questionData.type === 'multipleCorrectMcq' ? 10 : questionData.type === 'fillInTheBlanks' ? 15 : 20),
            classes: [], // Admins don't assign to classes
            status: isDraft ? 'draft' : 'published',
            isDraft: isDraft,
            publishedAt: isDraft ? null : new Date(),
            publishedBy: isDraft ? null : user._id,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

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
    console.log('[Get All Questions Paginated] Fetching questions with pagination');
    try {
        const user = req.user;
        const { page = 1, limit = 10, includeDrafts = false } = req.query;

        console.log('[Get All Questions Paginated] User:', user._id, '| Page:', page, '| Limit:', limit, '| IncludeDrafts:', includeDrafts);

        if (!['admin'].includes(user.role)) {
            console.warn('[Get All Questions Paginated] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can view all questions' });
        }

        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        if (isNaN(pageNum) || pageNum < 1) {
            console.error('[Get All Questions Paginated] Error: Invalid page number');
            return res.status(400).json({ error: 'Invalid page number' });
        }

        if (isNaN(limitNum) || limitNum < 1) {
            console.error('[Get All Questions Paginated] Error: Invalid limit');
            return res.status(400).json({ error: 'Invalid limit' });
        }

        // Build query - exclude drafts by default
        const query = includeDrafts === 'true' ? {} : { status: { $ne: 'draft' }, isDraft: { $ne: true } };

        console.log('[Get All Questions Paginated] ===== ADMIN MODE =====');
        console.log('[Get All Questions Paginated] Query filter:', JSON.stringify(query));
        
        // Count total questions matching query
        const totalQuestions = await Question.countDocuments(query);
        console.log('[Get All Questions Paginated] Total questions matching query:', totalQuestions);
        
        // Count all questions in database (no filter)
        const totalAllQuestions = await Question.countDocuments({});
        console.log('[Get All Questions Paginated] Total questions in database (all):', totalAllQuestions);

        const questions = await Question.find(query)
            .populate('createdBy', 'name email _id')
            .sort({ updatedAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean();

        console.log('[Get All Questions Paginated] ✅ Questions fetched for page:', questions.length, 'out of', totalQuestions, 'total');
        
        // Log sample questions with creator info
        if (questions.length > 0) {
            console.log('[Get All Questions Paginated] 📋 Questions on this page:');
            questions.forEach((q, idx) => {
                const creatorId = q.createdBy?._id?.toString() || q.createdBy?.toString() || 'N/A';
                const creatorName = q.createdBy?.name || 'N/A';
                console.log(`  [${idx + 1}] ID: ${q._id}, Title: ${q.title?.substring(0, 40)}..., CreatedBy: ${creatorId} (${creatorName}), Type: ${q.type}`);
            });
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
        const questionData = req.body;
        const user = req.user;

        console.log('[Admin Edit Question] User:', user._id);

        if (!['admin'].includes(user.role)) {
            console.warn('[Admin Edit Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can edit questions' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Admin Edit Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
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
        if (questionData.points && (typeof questionData.points !== 'number' || questionData.points <= 0)) {
            console.error('[Admin Edit Question] Error: Invalid points');
            return res.status(400).json({ error: 'Points must be a positive number' });
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
    console.log('[Admin Delete Question] Deleting:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Admin Delete Question] User:', user._id);

        if (!['admin'].includes(user.role)) {
            console.warn('[Admin Delete Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can delete questions' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Admin Delete Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
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

        if (!['admin'].includes(user.role)) {
            console.warn('[Search Questions By ID] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin can search questions' });
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
            points: questionData.points || 10,
            classes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });

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

        console.log('[Get Drafts] User:', user._id, '| Page:', page, '| Limit:', limit, '| Search:', search);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Get Drafts] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view drafts' });
        }

        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        // Build query
        const query = {
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        };

        // Add search if provided
        if (search && search.trim()) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { tags: { $regex: search, $options: 'i' } }
            ];
        }

        const drafts = await Question.find(query)
            .sort({ updatedAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .select('title type description difficulty tags points createdAt updatedAt status')
            .lean();

        const totalDrafts = await Question.countDocuments(query);

        console.log('[Get Drafts] Drafts fetched:', drafts.length, 'Total:', totalDrafts);
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

        const question = await Question.findOne({
            _id: questionId,
            status: 'draft',
            isDraft: true,
            createdBy: user._id
        });

        if (!question) {
            console.error('[Publish Draft Question] Error: Draft not found');
            return res.status(404).json({ error: 'Draft not found' });
        }

        // Validate question before publishing (full validation)
        if (!question.title || question.title.trim() === '') {
            return res.status(400).json({ error: 'Title is required to publish' });
        }
        if (!question.description || question.description.trim() === '') {
            return res.status(400).json({ error: 'Description is required to publish' });
        }

        // Type-specific validation
        if (question.type === 'coding' || question.type === 'fillInTheBlanksCoding') {
            if (!question.languages || question.languages.length === 0) {
                return res.status(400).json({ error: 'At least one language is required' });
            }
            if (!question.testCases || question.testCases.length === 0) {
                return res.status(400).json({ error: 'At least one test case is required' });
            }
        }

        // Update with final data if provided
        if (questionData) {
            normalizeQuestionRichTextFields(questionData);
            Object.keys(questionData).forEach(key => {
                if (questionData[key] !== undefined) {
                    question[key] = questionData[key];
                }
            });
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

        // Check if email is already taken by another user
        if (email && email !== student.email) {
            const existingUser = await User.findOne({ email, _id: { $ne: studentId } });
            if (existingUser) {
                console.error('[Edit Student] Error: Email already exists');
                return res.status(400).json({ error: 'Email already exists' });
            }
        }

        // Update student fields
        const updateData = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (number !== undefined) updateData.number = number;

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

        // Delete student's submissions
        await Submission.deleteMany({ userId: studentId });

        // Remove student from leaderboards
        await Leaderboard.updateMany(
            { 'attempts.userId': studentId },
            { $pull: { attempts: { userId: studentId } } }
        );

        // Delete the student
        await student.deleteOne();

        console.log('[Delete Student] Student deleted:', studentId);
        res.status(200).json({ message: 'Student deleted successfully' });
    } catch (err) {
        console.error('[Delete Student] Error:', err.message);
        res.status(500).json({ error: 'Error deleting student' });
    }
};