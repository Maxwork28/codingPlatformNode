const mongoose = require('mongoose');

const violationSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['tab_switch', 'fullscreen_exit', 'copy_paste', 'network_loss', 'heartbeat'],
        required: true
    },
    timestamp: { type: Date, default: Date.now },
    details: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const answerSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    isCorrect: { type: Boolean, default: false }
}, { _id: false });

const sectionTimerSchema = new mongoose.Schema({
    sectionId: { type: String, required: true },
    remainingSeconds: { type: Number, default: 0 },
    completed: { type: Boolean, default: false }
}, { _id: false });

const questionTimerSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    remainingSeconds: { type: Number },
    completed: { type: Boolean, default: false }
}, { _id: false });

const examAttemptSchema = new mongoose.Schema({
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    status: {
        type: String,
        enum: ['not_started', 'in_progress', 'submitted', 'auto_submitted', 'terminated', 'expired'],
        default: 'not_started'
    },
    startedAt: { type: Date },
    endsAt: { type: Date },
    submittedAt: { type: Date },
    autoSubmitted: { type: Boolean, default: false },
    manualSubmitted: { type: Boolean, default: false },
    currentSectionId: { type: String },
    currentQuestionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
    sectionTimers: [sectionTimerSchema],
    questionTimers: [questionTimerSchema],
    violations: [violationSchema],
    violationCount: { type: Number, default: 0 },
    tabSwitchCount: { type: Number, default: 0 },
    fullscreenExitCount: { type: Number, default: 0 },
    copyPasteCount: { type: Number, default: 0 },
    networkDropCount: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date },
    answers: [answerSchema],
    totalScore: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    remark: { type: String },
    feedback: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

examAttemptSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

examAttemptSchema.index({ examId: 1, studentId: 1 }, { unique: true });

module.exports = mongoose.model('ExamAttempt', examAttemptSchema);
