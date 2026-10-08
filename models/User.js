const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    number: String,
    role: { type: String, enum: ['admin', 'teacher', 'student', 'superAdmin'], required: true },
    password: String,
    resetToken: String,
    resetTokenExpiry: Date,
    canCreateQuestion: { type: Boolean, default: false },
    isBlocked: { type: Map, of: Boolean, default: {} },
    profilePicture: { type: String, default: null },
    /** Set for bulk-imported accounts until the user picks their own password. */
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: { type: Date },
    /** Incremented on every password change/reset; tokens carrying an older value are rejected. */
    tokenVersion: { type: Number, default: 0 },
});

userSchema.index({ role: 1 });
userSchema.index({ name: 'text', email: 'text' });

module.exports = mongoose.model('User', userSchema);