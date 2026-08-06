const jwt = require('jsonwebtoken');
const User = require('../models/User');

const secret = process.env.JWT_SECRET || 'abcdefghijkl111';

exports.authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.header('Authorization');
        const token = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7).trim()
            : authHeader?.replace(/^Bearer\s+/i, '').trim();

        if (!token) {
            return res.status(401).json({ error: 'Please authenticate' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, secret);
        } catch (jwtErr) {
            console.error('[authMiddleware] JWT verify failed:', jwtErr.message);
            return res.status(401).json({ error: 'Please authenticate' });
        }

        const userId = decoded.id || decoded._id;
        if (!userId) {
            return res.status(401).json({ error: 'Please authenticate' });
        }

        const user = await User.findById(userId);
        if (!user) {
            console.error('[authMiddleware] User not found for id:', userId);
            return res.status(401).json({ error: 'Please authenticate' });
        }

        req.user = user;
        next();
    } catch (err) {
        console.error('[authMiddleware] Unexpected error:', err.message);
        res.status(401).json({ error: 'Please authenticate' });
    }
};

exports.requireRole = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: `Requires one of the following roles: ${roles.join(', ')}` });
        }
        next();
    };
};
