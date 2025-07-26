const jwt = require('jsonwebtoken');
const User = require('../models/User');

const secret = process.env.JWT_SECRET || 'abcdefghijkl111';

exports.authMiddleware = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        if (!token) throw new Error('No token provided');

        const decoded = jwt.verify(token, secret);
        const user = await User.findById(decoded.id);
        if (!user) throw new Error('User not found');

        req.user = user;
        console.log("req.user",req.user)
        next();
    } catch (err) {
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
