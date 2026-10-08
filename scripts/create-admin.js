#!/usr/bin/env node
'use strict';

/**
 * Create the first admin account on a fresh database (or reset an existing admin's password).
 * Non-destructive: it never deletes or modifies other users.
 *
 *   node scripts/create-admin.js --email you@school.com --name "Your Name"
 *   node scripts/create-admin.js --email you@school.com --reset-password
 *
 * Uses MONGO_URI from .env. A random password is printed ONCE; the admin must change it at
 * first login (mustChangePassword=true).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../models/User');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

const email = String(arg('email') || '').trim().toLowerCase();
const name = String(arg('name') || '').trim() || 'Administrator';
const reset = flag('reset-password');

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: node scripts/create-admin.js --email you@school.com [--name "Your Name"] [--reset-password]');
    process.exit(1);
}
if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set (check codingPlatformNode/.env)');
    process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const randomPassword = (len = 14) => {
    let out = '';
    const bytes = crypto.randomBytes(len * 2);
    for (let i = 0; out.length < len && i < bytes.length; i += 1) {
        if (bytes[i] < 256 - (256 % ALPHABET.length)) out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    // guarantee letters + digits (the password policy requires both)
    return `${out.slice(0, len - 2)}7k`;
};

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const password = randomPassword();
    const hash = await bcrypt.hash(password, rounds);
    const existing = await User.findOne({ email });

    if (existing && !reset) {
        console.error(`A user with ${email} already exists (role: ${existing.role}). Use --reset-password to set a new one-time password.`);
        process.exit(1);
    }
    if (existing && existing.role !== 'admin' && existing.role !== 'superAdmin') {
        console.error(`${email} exists with role "${existing.role}"; refusing to change a non-admin account.`);
        process.exit(1);
    }

    if (existing) {
        existing.password = hash;
        existing.mustChangePassword = true;
        existing.passwordChangedAt = new Date();
        existing.tokenVersion = (Number(existing.tokenVersion) || 0) + 1;
        await existing.save();
        console.log(`Password reset for admin ${email}.`);
    } else {
        await User.create({ name, email, role: 'admin', password: hash, mustChangePassword: true });
        console.log(`Admin created: ${name} <${email}>`);
    }
    console.log(`One-time password (shown once, change it at first login): ${password}`);
    await mongoose.disconnect();
})().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
