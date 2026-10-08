#!/usr/bin/env node
'use strict';

/**
 * One-off migration: convert legacy Leaderboard documents that store the full per-submit history
 * (`attempts[]` + `highestScores[]`) into the bounded shape (`questions[]`, one aggregate row per question)
 * and recompute their totals (totalScore = sum of bestScore, correct/wrong/submit counts from submits,
 * activityStatus from needsFocus / totalSubmits). `updatedAt` is preserved.
 *
 * The app already tolerates un-migrated documents (readers fall back to `highestScores`, and the first
 * new submit upgrades a document in place with the same pipeline), so this can run before or after deploy.
 * It is idempotent: converted documents no longer match.
 *
 *   node scripts/migrate-leaderboard.js            # dry run: prints what would change
 *   node scripts/migrate-leaderboard.js --apply    # writes the changes
 *
 * Uses MONGO_URI from the environment / .env. Against a non-local database you must also pass --yes-i-know.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Leaderboard = require('../models/Leaderboard');

const APPLY = process.argv.includes('--apply');
const uri = process.env.MONGO_URI;
if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
}
const isLocal = /mongodb(\+srv)?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);
if (APPLY && !isLocal && !process.argv.includes('--yes-i-know')) {
    console.error('Refusing to write to a non-local database without --yes-i-know');
    process.exit(1);
}

const upgradePipeline = () => [
    ...Leaderboard.legacyUpgradeStages(),
    { $set: { totalScore: { $sum: '$questions.bestScore' } } },
    // activityStatus stage from the model (the updatedAt bump in finalizeStages is deliberately skipped)
    Leaderboard.finalizeStages(new Date())[1],
];

(async () => {
    await mongoose.connect(uri);
    const col = mongoose.connection.db.collection(Leaderboard.collection.collectionName);
    const filter = Leaderboard.LEGACY_FILTER;
    const candidates = await col.countDocuments(filter);
    console.log(`${candidates} legacy leaderboard document(s) in ${mongoose.connection.name}`);

    // Preview: run the exact upgrade pipeline as an aggregation and print before / after per document.
    const preview = col.aggregate([
        { $match: filter },
        {
            $set: {
                _before: {
                    attempts: { $size: { $ifNull: ['$attempts', []] } },
                    highestScores: { $size: { $ifNull: ['$highestScores', []] } },
                    totalScore: '$totalScore',
                    totalSubmits: '$totalSubmits',
                    correctAttempts: '$correctAttempts',
                    wrongAttempts: '$wrongAttempts',
                },
            },
        },
        ...upgradePipeline(),
        {
            $project: {
                classId: 1,
                studentId: 1,
                _before: 1,
                rows: { $size: '$questions' },
                totalScore: 1,
                totalSubmits: 1,
                correctAttempts: 1,
                wrongAttempts: 1,
                activityStatus: 1,
            },
        },
    ], { allowDiskUse: true });

    let shown = 0;
    let scoreChanged = 0;
    for await (const d of preview) {
        if (d._before.totalScore !== d.totalScore) scoreChanged += 1;
        if (shown < 50) {
            const b = d._before;
            console.log(
                `${APPLY ? 'convert' : 'would convert'} ${d._id} class=${d.classId} student=${d.studentId}: ` +
                `attempts ${b.attempts} / highestScores ${b.highestScores} -> questions ${d.rows}; ` +
                `totalScore ${b.totalScore} -> ${d.totalScore}, submits ${b.totalSubmits} -> ${d.totalSubmits}, ` +
                `correct/wrong ${b.correctAttempts}/${b.wrongAttempts} -> ${d.correctAttempts}/${d.wrongAttempts}, ${d.activityStatus}`
            );
        }
        shown += 1;
    }
    if (shown > 50) console.log(`... and ${shown - 50} more`);

    if (APPLY && candidates) {
        const res = await col.updateMany(filter, upgradePipeline());
        console.log(`\nconverted ${res.modifiedCount} document(s)`);
        const left = await col.countDocuments(filter);
        if (left) console.warn(`${left} legacy document(s) remain (written concurrently?) - re-run to convert them`);
    } else {
        console.log(`\n${shown} document(s) would be converted (${scoreChanged} with a different totalScore)${APPLY ? '' : ' (dry run; pass --apply to write)'}`);
    }
    await mongoose.disconnect();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
