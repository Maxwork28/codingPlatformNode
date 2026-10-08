const mongoose = require('mongoose');

/**
 * AI-generated-code check for exam coding answers (similarity to AI reference solutions).
 * Staff-only: the whole sub-document is `select: false`, so no existing query (several return
 * submissions to students) ever includes it; read it explicitly with `.select('+aiCheck')`.
 */
const aiCheckSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'done', 'no_references', 'too_short', 'error'], required: true },
  percent: { type: Number, min: 0, max: 100 },
  matchedReferenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiReference' },
  matchedSource: { type: String },
  matchedModel: { type: String },
  /** Highest percent per reference source, e.g. { openai: 82, gemini: 61, manual: 40 }. */
  perSource: { type: mongoose.Schema.Types.Mixed },
  /** Matched regions vs the closest reference: [{ tokens, a: {start,end,lineStart,lineEnd}, b: {...} }]. */
  matches: { type: mongoose.Schema.Types.Mixed },
  /** Student tokens left after removing starter/template code. */
  tokens: { type: Number },
  referenceCount: { type: Number },
  message: { type: String, maxlength: 500 },
  checkedAt: { type: Date },
  version: { type: Number },
}, { _id: false });

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
  },
  /** Full (un-sanitized) per-test results so staff views never need to re-judge. */
  testResults: { type: mongoose.Schema.Types.Mixed, select: false },
  aiCheck: { type: aiCheckSchema, select: false }
});

submissionSchema.index({ classId: 1, questionId: 1, studentId: 1, isRun: 1, submittedAt: -1 });
submissionSchema.index({ studentId: 1, submittedAt: -1 });
submissionSchema.index({ questionId: 1, isRun: 1, submittedAt: -1 });
submissionSchema.index({ examAttemptId: 1 });

module.exports = mongoose.model('Submission', submissionSchema);