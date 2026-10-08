'use strict';

/**
 * Strips MongoDB operator keys ($gt, $regex, ...) and dotted keys from request bodies and params,
 * so `User.findOne({ email })` can never receive `{ "$regex": "^a" }` from a client.
 * express-mongo-sanitize is not used because Express 5 exposes req.query as a getter.
 */

const MAX_DEPTH = 20;

const clean = (value, depth = 0) => {
    if (depth > MAX_DEPTH) return undefined;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            out[k] = clean(v, depth + 1);
        }
        return out;
    }
    return value;
};

const sanitizeRequest = (req, _res, next) => {
    if (req.body && typeof req.body === 'object') req.body = clean(req.body);
    if (req.params && typeof req.params === 'object') {
        for (const k of Object.keys(req.params)) {
            if (typeof req.params[k] === 'string' && req.params[k].startsWith('$')) req.params[k] = '';
        }
    }
    next();
};

module.exports = { sanitizeRequest, cleanObject: clean };
