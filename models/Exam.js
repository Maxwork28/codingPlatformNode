const mongoose = require('mongoose');

const examQuestionSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    points: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
    sectionId: { type: String },
    timeLimitSeconds: { type: Number }
}, { _id: false });

const examSectionSchema = new mongoose.Schema({
    sectionId: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String },
    durationSeconds: { type: Number, default: 0 },
    allowRevisit: { type: Boolean, default: true },
    order: { type: Number, default: 0 }
}, { _id: false });

const examSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    questions: [examQuestionSchema],
    sections: [examSectionSchema],
    proctoring: {
        durationMinutes: { type: Number, required: true },
        startTime: { type: Date },
        endTime: { type: Date },
        autoSubmitOnEnd: { type: Boolean, default: true },
        tabSwitchLimit: { type: Number, default: 5 },
        copyPasteDisabled: { type: Boolean, default: true },
        fullscreenRequired: { type: Boolean, default: true },
        internetRequired: { type: Boolean, default: true },
        allowRunCode: { type: Boolean, default: true }
    },
    scoring: {
        immediateScoreRelease: { type: Boolean, default: false },
        releaseStatus: { type: String, enum: ['not_released', 'released'], default: 'not_released' },
        gradingMode: { type: String, enum: ['auto', 'manual', 'mixed'], default: 'auto' }
    },
    template: {
        isTemplate: { type: Boolean, default: false },
        templateName: { type: String },
        templateDescription: { type: String },
        baseTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam' }
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['draft', 'scheduled', 'active', 'completed', 'archived'], default: 'draft' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

examSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Exam', examSchema);
