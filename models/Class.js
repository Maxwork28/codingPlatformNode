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
        maxPoints: { type: Number }
    }],
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
    totalRuns: { type: Number, default: 0 }, // Total runs across all vhbhbhbstudents
    totalSubmits: { type: Number, default: 0 } // Total submits across all students
});

classSchema.index({ students: 1 });
classSchema.index({ teachers: 1 });
classSchema.index({ createdBy: 1 });
classSchema.index({ questions: 1 });
classSchema.index({ 'assignments.questionId': 1 });

module.exports = mongoose.model('Class', classSchema);