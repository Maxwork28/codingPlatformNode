const mongoose = require('mongoose');

const classSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    teachers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Question' }],
    assignments: [{
        questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
        assignedAt: { type: Date, default: Date.now },
        dueDate: { type: Date },
        maxPoints: { type: Number, default: 10 }
    }],
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
    totalRuns: { type: Number, default: 0 }, // Total runs across all students
    totalSubmits: { type: Number, default: 0 } // Total submits across all students
}, {
    indexes: [
        { key: { questions: 1 } },
        { key: { 'assignments.questionId': 1 } } // Index for assignment lookups
    ]
});

module.exports = mongoose.model('Class', classSchema);