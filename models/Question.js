const mongoose = require('mongoose');

const classSettingsSchema = new mongoose.Schema({
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    isPublished: { type: Boolean, default: false },
    isDisabled: { type: Boolean, default: false }
});

const testCaseSchema = new mongoose.Schema({
    input: { type: String, required: true },
    expectedOutput: { type: String, required: true },
    isPublic: { type: Boolean, default: false }
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
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
    type: {
        type: String,
        enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'],
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
    languages: [{
        type: String,
        enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go']
    }],
    timeLimit: { type: Number, default: 2 },
    memoryLimit: { type: Number, default: 256 },
    maxAttempts: { type: Number },
    explanation: { type: String }
}, {
    indexes: [
        { key: { 'classes.classId': 1 } },
        { key: { title: 'text', tags: 'text' } }
    ]
});

questionSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Question', questionSchema);