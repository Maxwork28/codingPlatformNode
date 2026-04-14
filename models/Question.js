const mongoose = require('mongoose');

const classSettingsSchema = new mongoose.Schema({
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    isPublished: { type: Boolean, default: false },
    isDisabled: { type: Boolean, default: false }
});

const testCaseSchema = new mongoose.Schema({
    input: { type: String, required: true },
    expectedOutput: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    isLargeTestCase: { type: Boolean, default: false },
    timeLimit: { type: Number },
    memoryLimit: { type: Number }
});

const questionSchema = new mongoose.Schema({
    classes: [classSettingsSchema],
    title: { type: String, required: true },
    description: { type: String, required: true },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
    tags: [{ type: String }],
    points: { type: Number, default: 10 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    hints: [{ type: String }],
    solution: { type: String },
    solutionCode: { type: String }, // Solution code for coding questions
    solutionLanguage: { type: String }, // Language for solution code
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
    type: {
        type: String,
        enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'],
        required: true
    },
    options: [{ type: String }], // For singleCorrectMcq and multipleCorrectMcq
    correctOption: { type: Number }, // For singleCorrectMcq
    correctOptions: [{ type: Number }], // For multipleCorrectMcq
    correctAnswer: { type: String }, // For fillInTheBlanks and fillInTheBlanksCoding
    codeSnippet: { type: String }, // For fillInTheBlanksCoding
    starterCode: [{
        language: {
            type: String,
            enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go']
        },
        code: { type: String }
    }],
    testCases: [testCaseSchema], // For coding and fillInTheBlanksCoding
    constraints: { type: String },
    examples: [{ type: String }],
    functionSignature: { type: String },
    templateCode: [{
        language: {
            type: String,
            enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go']
        },
        code: { type: String }
    }],
    driverCode: [{
        language: {
            type: String,
            enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go']
        },
        code: { type: String }
    }], // For codingWithDriver - fixed driver code that handles input/output
    isExamOnly: { type: Boolean, default: false }, // Question created only for exam/test
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam' }, // Link to exam if exam-only question
    languages: [{
        type: String,
        enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go']
    }],
    timeLimit: { type: Number, default: 2 },
    memoryLimit: { type: Number, default: 256 },
    maxAttempts: { type: Number },
    explanation: { type: String },
    // Draft-related fields
    status: {
        type: String,
        enum: ['draft', 'published', 'archived'],
        default: 'published'
    },
    isDraft: {
        type: Boolean,
        default: false
    },
    publishedAt: { type: Date },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
    indexes: [
        { key: { 'classes.classId': 1 } },
        { key: { title: 'text', tags: 'text' } },
        { key: { status: 1 } },
        { key: { isDraft: 1 } },
        { key: { createdBy: 1, status: 1 } }
    ]
});

questionSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Question', questionSchema);