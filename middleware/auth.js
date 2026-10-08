const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config/env');

const extractToken = (req) => {
    const header = req.header('Authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
};

/** Verify a JWT and return its payload, or null. Shared with the Socket.IO handshake. */
const verifyToken = (token) => {
    if (!token) return null;
    try {
        return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
        return null;
    }
};

/** Load the user for a verified payload; rejects tokens issued before the last password change. */
const resolveUser = async (decoded) => {
    const userId = decoded?.id || decoded?._id;
    if (!userId) return null;
    const user = await User.findById(userId).select('-password -resetToken -resetTokenExpiry');
    if (!user) return null;
    // Token version: bumped on every password change/reset, so older tokens stop working immediately
    // (no clock-granularity window, unlike comparing passwordChangedAt with the second-resolution iat).
    if ((Number(decoded.tv) || 0) !== (Number(user.tokenVersion) || 0)) return null;
    return user;
};

const signToken = (user) =>
    jwt.sign({ id: user._id, role: user.role, tv: Number(user.tokenVersion) || 0 }, config.jwtSecret, {
        expiresIn: config.jwtExpiresIn,
        algorithm: 'HS256',
    });

exports.authMiddleware = async (req, res, next) => {
    try {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'Please authenticate' });
        const decoded = verifyToken(token);
        if (!decoded) return res.status(401).json({ error: 'Please authenticate' });
        const user = await resolveUser(decoded);
        if (!user) return res.status(401).json({ error: 'Please authenticate' });
        req.user = user;
        req.auth = decoded;
        next();
    } catch (err) {
        console.error('[authMiddleware] Unexpected error:', err.message);
        res.status(401).json({ error: 'Please authenticate' });
    }
};

exports.requireRole = (...roles) => (req, res, next) => {
    const role = req.user?.role;
    // superAdmin is a superset of admin everywhere.
    const effective = role === 'superAdmin' ? 'admin' : role;
    if (!roles.includes(role) && !roles.includes(effective)) {
        return res.status(403).json({ error: `Requires one of the following roles: ${roles.join(', ')}` });
    }
    next();
};

exports.verifyToken = verifyToken;
exports.resolveUser = resolveUser;
exports.signToken = signToken;
exports.extractToken = extractToken;
