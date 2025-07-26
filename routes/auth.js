const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../utils/sendEmail');
const generatePassword = require('../utils/generatePassword'); // Default import
const { authMiddleware, requireRole } = require('../middleware/auth');

const secret = process.env.JWT_SECRET || 'abcdefghijkl111';

// Login
router.post('/login', async (req, res) => {
    console.log('POST /login called');
    console.log('Request body:', req.body);

    try {
        const { email, password } = req.body;
        console.log('Extracted email:', email);
        console.log('Extracted password:', password);

        // Find user by email
        const user = await User.findOne({ email });
        console.log('User found:', user ? user.email : 'No user found');

        if (!user) {
            console.log('Invalid credentials: user not found');
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Compare password
        const isMatch = await bcrypt.compare(password, user.password);
        console.log('Password match:', isMatch);

        if (!isMatch) {
            console.log('Invalid credentials: password mismatch');
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Generate token
        const token = jwt.sign(
            { id: user._id, role: user.role },
            secret,
            { expiresIn: '1d' }
        );
        console.log('JWT token generated:', token);

        // Send response
        res.status(200).json({ token, role: user.role });
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
        const user = await User.findById(req.user._id).select('id role'); // Select only id and role
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.status(200).json({
            id: user._id,
            role: user.role,
        });
        console.log('GET /auth/me successful:', { id: user._id, role: user.role });
    } catch (err) {
        console.error('Error fetching user details:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Panel Access Routes
router.get('/panel', authMiddleware, (req, res) => {
    res.json({ message: `Welcome to ${req.user.role} panel` });
});

module.exports = router;