const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { sendEmail } = require('../utils/sendEmail');
const { authMiddleware, signToken } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const config = require('../config/env');
const { isS3Enabled, uploadImageToS3 } = require('../utils/s3');

const MIN_PASSWORD_LENGTH = 8;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const isString = (v) => typeof v === 'string';

const validateNewPassword = (password) => {
    if (!isString(password) || password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
    }
    if (password.length > 128) return 'Password is too long';
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain letters and numbers';
    return null;
};

const publicUser = (user) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    profilePicture: user.profilePicture || null,
    canCreateQuestion: Boolean(user.canCreateQuestion),
    mustChangePassword: Boolean(user.mustChangePassword),
});

// Extension is derived from the sniffed/declared mimetype, never from the client file name.
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAGIC = [
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], at: 0, also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
];
const sniffImageMime = (buffer) => {
    for (const m of MAGIC) {
        if (m.bytes.every((b, i) => buffer[i] === b)) {
            if (m.also && !m.also.bytes.every((b, i) => buffer[m.also.offset + i] === b)) continue;
            return m.mime;
        }
    }
    return null;
};

const uploadAvatar = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
        if (!IMAGE_EXT[file.mimetype]) return cb(new Error('Only PNG, JPG, WebP or GIF images are allowed'));
        cb(null, true);
    },
});

const avatarDir = path.join(__dirname, '..', 'uploads', 'avatars');

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
router.post('/login', authLimiter, async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const password = req.body?.password;
        if (!email || !isString(password) || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await User.findOne({ email }).select('+password');
        // Constant-time-ish: always run a compare so timing does not reveal whether the email exists.
        const hash = user?.password || '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid12';
        const ok = await bcrypt.compare(password, hash);
        if (!user || !ok) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = signToken(user);
        res.status(200).json({ token, ...publicUser(user), role: user.role });
    } catch (err) {
        console.error('[auth/login] error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------------------------------------------------------------------------
// Forgot password (token by email) and reset
// ---------------------------------------------------------------------------
router.post('/forgot-password', authLimiter, async (req, res) => {
    const generic = { message: 'If an account exists for that email, a reset link has been sent.' };
    try {
        const email = normalizeEmail(req.body?.email);
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const user = await User.findOne({ email });
        if (!user) return res.json(generic);

        const rawToken = crypto.randomBytes(32).toString('base64url');
        user.resetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
        user.resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);
        await user.save();

        if (sendEmail.isSmtpConfigured()) {
            const base = config.publicAppUrl || '';
            const link = `${base}/reset-password?token=${rawToken}`;
            await sendEmail(
                user.email,
                'Reset your AlgoSutra password',
                `Hi ${user.name},\n\nUse this link to set a new password (valid for 1 hour):\n${link}\n\nIf you did not request this, you can ignore this email.`
            );
        } else {
            console.warn('[auth/forgot-password] SMTP not configured; reset link not sent for', user._id.toString());
        }
        return res.json(generic);
    } catch (err) {
        console.error('[auth/forgot-password] error:', err.message);
        return res.json(generic);
    }
});

router.post('/reset-password', authLimiter, async (req, res) => {
    try {
        const { token, newPassword } = req.body || {};
        if (!isString(token) || !token) return res.status(400).json({ error: 'Reset token is required' });
        const problem = validateNewPassword(newPassword);
        if (problem) return res.status(400).json({ error: problem });

        const hashed = crypto.createHash('sha256').update(token).digest('hex');
        const user = await User.findOne({ resetToken: hashed, resetTokenExpiry: { $gt: new Date() } }).select('+password');
        if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

        user.password = await bcrypt.hash(newPassword, config.bcryptRounds);
        user.resetToken = undefined;
        user.resetTokenExpiry = undefined;
        user.mustChangePassword = false;
        user.passwordChangedAt = new Date();
        user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
        await user.save();
        res.json({ message: 'Password updated. You can now log in.' });
    } catch (err) {
        console.error('[auth/reset-password] error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------------------------------------------------------------------------
// Change password (logged in)
// ---------------------------------------------------------------------------
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body || {};
        if (!isString(oldPassword) || !oldPassword) return res.status(400).json({ error: 'Current password is required' });
        const problem = validateNewPassword(newPassword);
        if (problem) return res.status(400).json({ error: problem });
        if (oldPassword === newPassword) return res.status(400).json({ error: 'New password must be different from the current one' });

        const user = await User.findById(req.user._id).select('+password');
        if (!user) return res.status(404).json({ error: 'User not found' });
        const ok = await bcrypt.compare(oldPassword, user.password || '');
        if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

        user.password = await bcrypt.hash(newPassword, config.bcryptRounds);
        user.mustChangePassword = false;
        user.passwordChangedAt = new Date();
        user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
        user.resetToken = undefined;
        user.resetTokenExpiry = undefined;
        await user.save();

        // tokenVersion was bumped, so every existing token is now rejected; hand back a fresh one.
        const token = signToken(user);
        res.json({ message: 'Password updated', token, ...publicUser(user) });
    } catch (err) {
        console.error('[auth/change-password] error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------
router.get('/me', authMiddleware, async (req, res) => {
    try {
        res.status(200).json(publicUser(req.user));
    } catch (err) {
        console.error('[auth/me] error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------------------------------------------------------------------------
// Profile picture
// ---------------------------------------------------------------------------
router.post(
    '/profile-picture',
    authMiddleware,
    (req, res, next) => {
        uploadAvatar.single('profilePicture')(req, res, (err) => {
            if (err) return res.status(400).json({ error: err.message || 'Failed to upload image' });
            next();
        });
    },
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No image file provided' });
            const sniffed = sniffImageMime(req.file.buffer);
            if (!sniffed || !IMAGE_EXT[sniffed]) return res.status(400).json({ error: 'File is not a valid image' });
            const ext = IMAGE_EXT[sniffed];

            const user = await User.findById(req.user._id);
            if (!user) return res.status(404).json({ error: 'User not found' });

            let url;
            if (isS3Enabled()) {
                ({ url } = await uploadImageToS3({
                    buffer: req.file.buffer,
                    contentType: sniffed,
                    ext,
                    keyPrefix: 'avatars',
                    userId: user._id,
                }));
            } else {
                await fs.mkdir(avatarDir, { recursive: true });
                const filename = `${user._id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
                await fs.writeFile(path.join(avatarDir, filename), req.file.buffer);
                url = `/uploads/avatars/${filename}`;
                if (user.profilePicture && user.profilePicture.startsWith('/uploads/avatars/')) {
                    const oldName = path.basename(user.profilePicture);
                    await fs.unlink(path.join(avatarDir, oldName)).catch(() => {});
                }
            }

            user.profilePicture = url;
            await user.save();
            res.status(200).json({ message: 'Profile picture updated', profilePicture: user.profilePicture });
        } catch (err) {
            console.error('[auth/profile-picture] error:', err.message);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

router.get('/panel', authMiddleware, (req, res) => {
    res.json({ message: `Welcome to ${req.user.role} panel` });
});

module.exports = router;
