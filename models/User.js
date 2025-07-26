const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true, index: true },
    email: { type: String, unique: true, required: true, index: true },
    number: String,
    role: { type: String, enum: ['admin', 'teacher', 'student', 'superAdmin'], required: true },
    password: String,
    resetToken: String,
    resetTokenExpiry: Date,
    canCreateClass: { type: Boolean, default: false },
    isBlocked: { type: Map, of: Boolean, default: {} }
}, {
    indexes: [
        { key: { name: 'text', email: 'text' } }
    ]
});

module.exports = mongoose.model('User', userSchema);