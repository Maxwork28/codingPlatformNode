const xlsx = require('xlsx');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Class = require('../models/Class');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Leaderboard = require('../models/Leaderboard');
const generatePassword = require('../utils/generatePassword');
const sendEmail = require('../utils/sendEmail');
const mongoose = require('mongoose');
const supportedLanguages = ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'];

// Helper function to validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Helper function to validate question data
const validateQuestion = async (questionId) => {
    const question = await Question.findById(questionId);
   
    return question;
};


 exports.uploadExcel = async (req, res) => {
    try {
        console.log('uploadExcel: Starting, file:', req.file?.path, 'role:', req.body.role);
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        console.log('uploadExcel: Excel data parsed:', data);

        for (const entry of data) {
            console.log('uploadExcel: Processing entry:', entry);
            const password = generatePassword();
            console.log('uploadExcel: Generated password:', password);
            const hashedPassword = await bcrypt.hash(password, 10);
            console.log('uploadExcel: Password hashed');

            const user = new User({
                name: entry.name,
                email: entry.email,
                number: entry.number,
                role: req.body.role,
                password: hashedPassword
            });
            console.log('uploadExcel: User object created:', { name: user.name, email: user.email, role: user.role });

            await user.save();
            console.log('uploadExcel: User saved:', user._id);

            await sendEmail(
                entry.email,
                'Your Login Credentials',
                `Email: ${entry.email}\nPassword: ${password}\nRole: ${req.body.role}`
            );
            console.log('uploadExcel: Email sent to:', entry.email);
        }

        console.log('uploadExcel: All users processed successfully');
        res.status(200).json({ message: 'Users created and emails sent' });
    } catch (err) {
        console.error('uploadExcel: Error:', err);
        res.status(500).json({ error: 'Error processing file' });
    }
};

exports.createClass = async (req, res) => {
    try {
        const { name, description } = req.body;
        const user = req.user;

        console.log('createClass: Request received:', { name, description, file: req.file?.path });
        console.log('createClass: User:', { id: user._id, role: user.role, canCreateClass: user.canCreateClass });

        if (!name) {
            console.log('createClass: Validation failed: Class name is missing');
            return res.status(400).json({ error: 'Class name is required' });
        }

        if (user.role !== 'admin' && !(user.role === 'teacher' && user.canCreateClass)) {
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
        const { teacherId, canCreateClass } = req.body;
        console.log('manageTeacherPermission: Request received:', { teacherId, canCreateClass, userRole: req.user.role });

        if (req.user.role !== 'admin') {
            console.log('manageTeacherPermission: Authorization failed: User is not admin');
            return res.status(403).json({ error: 'Only admins can manage teacher permissions' });
        }

        if (!teacherId || typeof canCreateClass !== 'boolean') {
            console.log('manageTeacherPermission: Validation failed: Invalid teacherId or canCreateClass');
            return res.status(400).json({ error: 'Teacher ID and canCreateClass (boolean) are required' });
        }

        const teacher = await User.findById(teacherId);
        console.log('manageTeacherPermission: Teacher lookup:', teacher ? { id: teacher._id, role: teacher.role } : 'Not found');

        if (!teacher || teacher.role !== 'teacher') {
            console.log('manageTeacherPermission: Validation failed: Teacher not found or invalid role');
            return res.status(404).json({ error: 'Teacher not found' });
        }

        teacher.canCreateClass = canCreateClass;
        await teacher.save();
        console.log('manageTeacherPermission: Teacher updated:', { id: teacher._id, canCreateClass });

        const action = canCreateClass ? 'granted' : 'revoked';
        console.log(`manageTeacherPermission: Permission ${action} for teacher`);
        res.status(200).json({ message: `Class creation permission ${action} for teacher` });
    } catch (err) {
        console.error('manageTeacherPermission: Error:', err);
        res.status(500).json({ error: 'Error managing teacher permission' });
    }
};


exports.getAllClasses = async (req, res) => {
        try {
        console.log('getAllClasses: Request received, user:', { id: req.user._id, role: req.user.role });
        const classes = await Class.find()
            .populate('createdBy', 'name email')
            .populate('students', 'name email')
            .populate('teachers', 'name email')
            .populate('questions', 'title type description points classes');
        console.log('getAllClasses: Classes fetched:', classes.length);
        res.status(200).json({ classes });
    } catch (err) {
        console.error('getAllClasses: Error:', err);
        res.status(500).json({ error: 'Error fetching classes' });
    }
};

exports.getAllTeachers = async (req, res) => {
    try {
        console.log('getAllTeachers: Request received, user:', { id: req.user._id, role: req.user.role });
        const teachers = await User.find({ role: 'teacher' }).select('name email canCreateClass');
        console.log('getAllTeachers: Teachers fetched:', teachers.length);
        res.status(200).json({ teachers });
    } catch (err) {
        console.error('getAllTeachers: Error:', err);
        res.status(500).json({ error: 'Error fetching teachers' });
    }
};

exports.getAllStudents = async (req, res) => {
    try {
        console.log('getAllStudents: Request received, user:', { id: req.user._id, role: req.user.role });
        const students = await User.find({ role: 'student' }).select('name email number');
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
        console.log('[getStudentsByClass] Request received:', { classId, user: { id: req.user._id, role: req.user.role } });

        if (req.user.role !== 'admin') {
            console.error('[getStudentsByClass] Authorization failed: User is not admin');
            return res.status(403).json({ error: 'Unauthorized: Admins only' });
        }

        if (!isValidObjectId(classId)) {
            console.error('[getStudentsByClass] Validation failed: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classData = await Class.findById(classId)
            .populate('students', 'name email number isBlocked');
        if (!classData) {
            console.error('[getStudentsByClass] Validation failed: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        const students = classData.students.map((student) => ({
            _id: student._id,
            name: student.name,
            email: student.email,
            number: student.number,
            isBlocked: student.isBlocked.get(classId.toString()) || false,
        }));

        console.log('[getStudentsByClass] Students fetched:', students.length);
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
            .populate('teachers', 'name email canCreateClass');
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
            .populate('teachers', 'name email canCreateClass')
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
            .populate('studentId', 'name email')
            .lean();
        console.log('searchLeaderboard: Raw leaderboard:', leaderboard);

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

        console.log('searchLeaderboard: Final leaderboard:', leaderboard);
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

        student.isBlocked.set(classId, isBlocked);
        await student.save();
        console.log('[blockUnblockStudent] Student block status updated:', { studentId, isBlocked });

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

        let leaderboard = await Leaderboard.findOne({ classId, studentId });
        if (!leaderboard) {
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
        } else {
            leaderboard.needsFocus = needsFocus;
            if (needsFocus) {
                leaderboard.activityStatus = 'focused';
            } else if (leaderboard.activityStatus === 'focused') {
                leaderboard.activityStatus = leaderboard.totalSubmits > 0 ? 'active' : 'inactive';
            }
        }
        await leaderboard.save();
        console.log('[focusUnfocusStudent] Leaderboard focus status updated:', { studentId, needsFocus });

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

        const [teacherCount, studentCount, questionCount, classCount] = await Promise.all([
            User.countDocuments({ role: 'teacher' }),
            User.countDocuments({ role: 'student' }),
            Question.countDocuments(),
            Class.countDocuments()
        ]);

        console.log('getCounts: Counts fetched:', {
            teachers: teacherCount,
            students: studentCount,
            questions: questionCount,
            classes: classCount
        });

        res.status(200).json({
            counts: {
                teachers: teacherCount,
                students: studentCount,
                questions: questionCount,
                classes: classCount
            }
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
        const validTypes = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'];
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
        }

        // Create question
        const question = new Question({
            ...questionData,
            createdBy: user._id,
            points: questionData.points || (questionData.type === 'singleCorrectMcq' ? 10 : questionData.type === 'multipleCorrectMcq' ? 10 : questionData.type === 'fillInTheBlanks' ? 15 : 20),
            classes: [], // Admins don't assign to classes
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await question.save();
        console.log('[Admin Create Question] Saved:', question._id);

        res.status(201).json({ message: 'Question created successfully', question });
    } catch (err) {
        console.error('[Admin Create Question] Error:', err.message);
        res.status(500).json({ error: 'Error creating question' });
    }
};

exports.getAllQuestionsPaginated = async (req, res) => {
    console.log('[Get All Questions Paginated] Fetching questions with pagination');
    try {
        const user = req.user;
        const { page = 1, limit = 10 } = req.query;

        console.log('[Get All Questions Paginated] User:', user._id, '| Page:', page, '| Limit:', limit);

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

        const questions = await Question.find()
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean();

        const totalQuestions = await Question.countDocuments();

        console.log('[Get All Questions Paginated] Questions fetched:', questions.length, 'Total:', totalQuestions);
        res.status(200).json({
            questions,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalQuestions / limitNum),
                totalQuestions,
                limit: limitNum
            }
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

        const validTypes = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'];
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
        }

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