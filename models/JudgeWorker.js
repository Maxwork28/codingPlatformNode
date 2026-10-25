const mongoose = require('mongoose');

/** Heartbeat of a judge worker (inline in an API process or workers/judgeWorker.js). */
const judgeWorkerSchema = new mongoose.Schema({
    _id: { type: String }, // host:pid
    host: { type: String },
    pid: { type: Number },
    mode: { type: String, enum: ['inline', 'external'] },
    concurrency: { type: Number },
    active: { type: Number, default: 0 },
    startedAt: { type: Date },
    lastSeenAt: { type: Date, required: true },
});

judgeWorkerSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('JudgeWorker', judgeWorkerSchema);
