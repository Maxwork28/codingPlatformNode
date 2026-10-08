const mongoose = require('mongoose');

const violationSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['tab_switch', 'fullscreen_exit', 'copy_paste', 'network_loss', 'heartbeat'],
        required: true
    },
    timestamp: { type: Date, default: Date.now },
    /** Short, bounded string only; the client used to be able to push arbitrary 2 MB objects. */
    details: { type: String, maxlength: 512 }
}, { _id: false });

const answerSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
    answer: mongoose.Schema.Types.Mixed, // Store answer directly for MCQ/FIB
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    isCorrect: { type: Boolean, default: false },
    language: { type: String }, // For coding questions
    passedTestCases: { type: Number, default: 0 },
    totalTestCases: { type: Number, default: 0 },
    savedAt: { type: Date }
}, { _id: false });

/**
 * Section / question timers are anchored to the server clock (see "Timers" in examController):
 *  - remainingSeconds: budget left as of the last stop (null = untimed). While running, the live value
 *    is remainingSeconds - (now - startedAt).
 *  - startedAt: when the timer last started counting; null while paused. Only the current section and
 *    the current question run. Attempts created before this field existed have it unset (= paused).
 *  - stoppedAt: when it last paused (requests in flight at that moment get a short grace period).
 *  - endedAt: when it became unusable: the instant its budget ran out, or when the student left a
 *    section that does not allow revisits.
 */
const timerFields = {
    remainingSeconds: { type: Number, default: null },
    startedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    completed: { type: Boolean, default: false }
};

const sectionTimerSchema = new mongoose.Schema({
    sectionId: { type: String, required: true },
    ...timerFields
}, { _id: false });

const questionTimerSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    ...timerFields
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
    endsAt: { type: Date }, // Total timer end
    submittedAt: { type: Date },
    autoSubmitted: { type: Boolean, default: false },
    manualSubmitted: { type: Boolean, default: false },
    currentSectionId: { type: String },
    currentQuestionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
    sectionTimers: [sectionTimerSchema], // Sectional timers
    questionTimers: [questionTimerSchema], // Question-wise timers
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
}, { optimisticConcurrency: true });

examAttemptSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

examAttemptSchema.index({ examId: 1, studentId: 1 }, { unique: true });
examAttemptSchema.index({ examId: 1, status: 1 });
examAttemptSchema.index({ studentId: 1, status: 1 });

module.exports = mongoose.model('ExamAttempt', examAttemptSchema);

