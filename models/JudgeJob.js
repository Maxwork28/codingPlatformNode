const mongoose = require('mongoose');

/**
 * One code-judging request (Run, Submit, custom-input Run, exam Run / grading, teacher test).
 *
 * The collection is the judge queue: API processes insert jobs, judge workers (inline in the API
 * process or workers/judgeWorker.js) claim them atomically by priority, run them in Docker and
 * write the client-facing result back here. Job state lives in MongoDB, so queued exam grading
 * survives restarts and crashed workers are detected by their heartbeat.
 *
 * Jobs hold student code, so finished jobs expire (expireAt TTL) once the client had time to
 * read the result; Submissions keep the permanent record.
 */
const judgeJobSchema = new mongoose.Schema({
    kind: {
        type: String,
        required: true,
        enum: ['practice-run', 'practice-custom', 'practice-submit', 'exam-run', 'exam-grade', 'teacher-test', 'teacher-custom', 'staff-rejudge'],
    },
    priority: { type: Number, required: true },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued', required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Client-generated key: retries of the same click return this job instead of judging twice. */
    clientRequestId: { type: String, maxlength: 64 },
    /** What to run: language, code, questionId, testSet, customTests, limits, options. */
    spec: { type: mongoose.Schema.Types.Mixed, required: true },
    /** Kind-specific data the finalizer needs (classId, answer, exam ids, points, ...). */
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Response payload for the client (same shape the synchronous endpoints used to return). */
    result: { type: mongoose.Schema.Types.Mixed },
    error: {
        status: { type: Number },
        message: { type: String, maxlength: 2000 },
    },
    /** Socket.IO emits the API performs when it reports the job: [{ room, event, payload }]. */
    events: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    attempts: { type: Number, default: 0 },
    workerId: { type: String },
    createdAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    heartbeatAt: { type: Date },
    finishedAt: { type: Date },
    notifiedAt: { type: Date, default: null },
    expireAt: { type: Date },
}, { minimize: false });

judgeJobSchema.index({ status: 1, priority: -1, createdAt: 1 });
judgeJobSchema.index({ status: 1, heartbeatAt: 1 });
judgeJobSchema.index({ notifiedAt: 1, status: 1, finishedAt: 1 });
judgeJobSchema.index({ ownerId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
judgeJobSchema.index({ kind: 1, status: 1, 'context.studentId': 1, 'context.questionId': 1 });
judgeJobSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('JudgeJob', judgeJobSchema);
