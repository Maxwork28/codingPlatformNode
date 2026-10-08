const mongoose = require('mongoose');

/**
 * Progress + cross-process lock for AI reference generation.
 *   key 'exam:<examId>'          teacher-triggered generation for a whole exam (progress for the UI)
 *   key 'auto:<questionId>:<lang>' automatic generation after the first answer with no references
 * A job is "running" until finishedAt is set or lockedUntil passes (crashed process).
 */
const aiGenerationJobSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam' },
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
    language: { type: String },
    status: { type: String, enum: ['running', 'done', 'error'], default: 'running' },
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    errorMessages: [{ type: String, maxlength: 500 }],
    providers: [{ type: String }],
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    lockedUntil: { type: Date },
});

module.exports = mongoose.model('AiGenerationJob', aiGenerationJobSchema);
