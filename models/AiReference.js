const mongoose = require('mongoose');

const LANGUAGES = ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'];
const SOURCES = ['openai', 'gemini', 'anthropic', 'manual'];

/**
 * An AI-generated (or teacher-pasted) reference solution for one question + language. Exam coding
 * answers are compared against these to estimate "similarity to AI-generated code".
 * Staff-only data: never returned to students.
 */
const aiReferenceSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    language: { type: String, enum: LANGUAGES, required: true },
    source: { type: String, enum: SOURCES, required: true },
    /** Provider model id (e.g. gpt-6.1-sol) or, for manual references, the teacher's label ("ChatGPT"). */
    model: { type: String, maxlength: 120 },
    /** Prompt variant number for generated references; null for manual ones. */
    variant: { type: Number },
    code: { type: String, required: true, maxlength: 100000 },
    /** Exam whose generation / teacher created it (informational; references are shared per question). */
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
});

aiReferenceSchema.index({ questionId: 1, language: 1, createdAt: 1 });

module.exports = mongoose.model('AiReference', aiReferenceSchema);
module.exports.LANGUAGES = LANGUAGES;
module.exports.SOURCES = SOURCES;
