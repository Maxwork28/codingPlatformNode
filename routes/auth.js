const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { sendEmail } = require('../utils/sendEmail');
const generatePassword = require('../utils/generatePassword'); // Default import
const { authMiddleware, requireRole } = require('../middleware/auth');

const secret = process.env.JWT_SECRET || 'abcdefghijkl111';

const avatarDir = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(avatarDir)) {
    fs.mkdirSync(avatarDir, { recursive: true });
}

const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
        cb(null, `${req.user._id}-${Date.now()}${ext}`);
    },
});

const uploadAvatar = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    },
});

// Login
router.post('/login', async (req, res) => {
    console.log('POST /login called');
    console.log('Request body:', req.body);

    try {
        const { email, password } = req.body;
        console.log('Extracted email:', email);
        console.log('Extracted password:', password ? '[provided]' : '[missing]');

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find user by email (case-insensitive)
        const normalizedEmail = String(email).trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });
        console.log('User found:', user ? user.email : 'No user found');

        if (!user) {
            // Fallback: case-insensitive regex for legacy mixed-case emails
            const userCi = await User.findOne({
                email: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
            });
            if (!userCi) {
                console.log('Invalid credentials: user not found');
                return res.status(400).json({ error: 'Invalid credentials' });
            }
            // Continue with userCi below by assigning
            req._loginUser = userCi;
        } else {
            req._loginUser = user;
        }

        const matchedUser = req._loginUser;

        // Compare password
        const isMatch = await bcrypt.compare(password, matchedUser.password);
        console.log('Password match:', isMatch);

        if (!isMatch) {
            console.log('Invalid credentials: password mismatch');
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Generate token
        const token = jwt.sign(
            { id: matchedUser._id, role: matchedUser.role },
            secret,
            { expiresIn: '1d' }
        );
        console.log('JWT token generated');

        // Send response with user details
        res.status(200).json({
            token,
            role: matchedUser.role,
            id: matchedUser._id,
            name: matchedUser.name,
            email: matchedUser.email,
            profilePicture: matchedUser.profilePicture || null,
        });
        console.log('Login successful, response sent');

    } catch (err) {
        console.error('Server error during login:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Forgot Password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email, oldPassword, newPassword } = req.body;

        // Validate input
        if (!email || !oldPassword || !newPassword) {
            return res.status(400).json({ error: 'Email, old password, and new password are required' });
        }

        // Validate new password strength
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify old password
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Incorrect old password' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update user password
        user.password = hashedPassword;
        await user.save();

        // Send confirmation email
        await sendEmail(
            email,
            'Password Reset Successful',
            'Your password has been successfully updated. Please log in with your new password.'
        );

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get User Details (auth/me endpoint)
router.get('/me', authMiddleware, async (req, res) => {
    try {
        // req.user is set by authMiddleware
        const user = await User.findById(req.user._id).select('name email role profilePicture');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.status(200).json({
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            profilePicture: user.profilePicture || null,
        });
        console.log('GET /auth/me successful:', { id: user._id, name: user.name, email: user.email, role: user.role });
    } catch (err) {
        console.error('Error fetching user details:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload / update profile picture (students)
router.post(
    '/profile-picture',
    authMiddleware,
    (req, res, next) => {
        uploadAvatar.single('profilePicture')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: err.message || 'Failed to upload image' });
            }
            next();
        });
    },
    async (req, res) => {
        try {
            if (req.user.role !== 'student') {
                return res.status(403).json({ error: 'Only students can update profile picture here' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No image file provided' });
            }

            const user = await User.findById(req.user._id);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Remove previous avatar file if it was local
            if (user.profilePicture && user.profilePicture.startsWith('/uploads/avatars/')) {
                const oldPath = path.join(__dirname, '..', user.profilePicture.replace(/^\//, ''));
                if (fs.existsSync(oldPath)) {
                    try { fs.unlinkSync(oldPath); } catch (_) { /* ignore */ }
                }
            }

            user.profilePicture = `/uploads/avatars/${req.file.filename}`;
            await user.save();

            res.status(200).json({
                message: 'Profile picture updated',
                profilePicture: user.profilePicture,
            });
        } catch (err) {
            console.error('Error uploading profile picture:', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

// Panel Access Routes
router.get('/panel', authMiddleware, (req, res) => {
    res.json({ message: `Welcome to ${req.user.role} panel` });
});

module.exports = router;
