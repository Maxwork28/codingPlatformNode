const mongoose = require('mongoose');

/**
 * Wrong Safe Exam Browser entry passwords per student per exam (POST /exams/:examId/start).
 * Lives in Mongo so the limit holds across API processes; documents expire on their own.
 */
const sebEntryThrottleSchema = new mongoose.Schema({
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    failures: { type: Number, default: 0 },
    windowStart: { type: Date },
    lockedUntil: { type: Date },
    expiresAt: { type: Date, required: true },
});

sebEntryThrottleSchema.index({ examId: 1, studentId: 1 }, { unique: true });
sebEntryThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SebEntryThrottle', sebEntryThrottleSchema);
