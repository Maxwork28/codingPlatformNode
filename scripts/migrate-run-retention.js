#!/usr/bin/env node
'use strict';

/**
 * Give practice Runs saved before RUN_RETENTION_DAYS existed an expiry, so MongoDB's TTL index
 * removes them like new runs (submits and exam answers are never touched).
 *
 *   node scripts/migrate-run-retention.js          # dry run: counts only
 *   node scripts/migrate-run-retention.js --yes    # set expiresAt = submittedAt + RUN_RETENTION_DAYS
 *
 * Uses MONGO_URI from .env. Leaderboard / class run counters are unaffected.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const days = Number(process.env.RUN_RETENTION_DAYS ?? 30);

(async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
    if (!(days > 0)) {
        console.log('RUN_RETENTION_DAYS is 0 (keep forever): nothing to do.');
        return;
    }
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const Submission = require('../models/Submission');
    await Submission.syncIndexes();
    const filter = { isRun: true, examAttemptId: { $exists: false }, expiresAt: { $exists: false } };
    const count = await Submission.countDocuments(filter);
    console.log(`${count} practice run(s) without an expiry (retention ${days} days).`);
    if (!process.argv.includes('--yes')) {
        console.log('Dry run. Re-run with --yes to set their expiry (runs older than that are then deleted by MongoDB within a minute).');
        return;
    }
    const res = await Submission.updateMany(filter, [
        { $set: { expiresAt: { $add: [{ $ifNull: ['$submittedAt', '$$NOW'] }, days * 86_400_000] } } },
    ]);
    console.log(`Updated ${res.modifiedCount} run(s).`);
})()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
