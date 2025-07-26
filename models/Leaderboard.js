const mongoose = require('mongoose');

const attemptSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    questionType: { 
        type: String, 
        enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'], 
        required: true 
    },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
    isCorrect: { type: Boolean, required: true },
    score: { type: Number, required: true },
    output: String,
    submittedAt: { type: Date, required: true },
    isRun: { type: Boolean, default: false }
});

const leaderboardSchema = new mongoose.Schema({
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    attempts: [attemptSchema],
    highestScores: [{
        questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
        submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
        score: { type: Number, required: true },
        isCorrect: { type: Boolean, required: true },
        submittedAt: { type: Date, required: true }
    }],
    totalScore: { type: Number, default: 0 },
    correctAttempts: { type: Number, default: 0 },
    wrongAttempts: { type: Number, default: 0 },
    totalRuns: { type: Number, default: 0 },
    totalSubmits: { type: Number, default: 0 },
    activityStatus: { type: String, enum: ['active', 'inactive', 'focused'], default: 'inactive' },
    needsFocus: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now }
});

leaderboardSchema.index({ classId: 1, studentId: 1 }, { unique: true });
leaderboardSchema.index({ activityStatus: 1 });
leaderboardSchema.index({ needsFocus: 1 });

leaderboardSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    const highestByQuestion = {};
    let correctCount = 0;
    let wrongCount = 0;
    let runCount = 0;
    let submitCount = 0;

    for (const attempt of this.attempts) {
        const qId = attempt.questionId.toString();
        if (!['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'].includes(attempt.questionType)) {
            console.error(`[Leaderboard] Invalid questionType: ${attempt.questionType} for questionId: ${qId}`);
            attempt.questionType = 'coding'; // Fallback to a valid type or handle appropriately
        }
        if (attempt.isCorrect) correctCount++;
        else wrongCount++;
        if (attempt.isRun) runCount++;
        else submitCount++;

        if (!highestByQuestion[qId] || attempt.score > highestByQuestion[qId].score || 
            (attempt.score === highestByQuestion[qId].score && attempt.submittedAt > highestByQuestion[qId].submittedAt)) {
            highestByQuestion[qId] = {
                questionId: attempt.questionId,
                submissionId: attempt.submissionId,
                score: attempt.score,
                isCorrect: attempt.isCorrect,
                submittedAt: attempt.submittedAt
            };
        }
    }

    this.highestScores = Object.values(highestByQuestion);
    this.totalScore = this.highestScores.reduce((sum, entry) => sum + entry.score, 0);
    this.correctAttempts = correctCount;
    this.wrongAttempts = wrongCount;
    this.totalRuns = runCount;
    this.totalSubmits = submitCount;

    this.activityStatus = this.totalSubmits > 0 ? (this.totalSubmits >= 5 ? 'focused' : 'active') : 'inactive';
    next();
});

module.exports = mongoose.model('Leaderboard', leaderboardSchema);