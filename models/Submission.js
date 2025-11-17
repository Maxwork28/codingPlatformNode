const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam' },
  examAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt' },
  answer: mongoose.Schema.Types.Mixed,
  language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'], required: false },
  isCorrect: Boolean,
  isCustomInput: { type: Boolean, default: false },
  score: Number,
  output: String,
  passedTestCases: { type: Number, default: 0 },
  totalTestCases: { type: Number, default: 0 },
  submittedAt: { type: Date, default: Date.now },
  isRun: { type: Boolean, default: false }
});

module.exports = mongoose.model('Submission', submissionSchema);