const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answer: mongoose.Schema.Types.Mixed, // Supports arrays for multipleCorrectMcq
  language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'], required: false }, // Optional
  isCorrect: Boolean,
  isCustomInput: { type: Boolean, default: false },
  score: Number,
  output: String,
  submittedAt: { type: Date, default: Date.now },
  isRun: { type: Boolean, default: false },
  examAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt' }, // Link to exam attempt if submitted during exam
  passedTestCases: { type: Number, default: 0 },
  totalTestCases: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['accepted', 'wrong_answer', 'tle', 'mle', 'runtime_error', 'compile_error'],
    default: 'accepted'
  }
});

module.exports = mongoose.model('Submission', submissionSchema);