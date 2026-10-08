#!/usr/bin/env node
'use strict';

/**
 * One-off migration: convert `correctAnswer` and `codeSnippet` that older versions of the
 * question form saved as rich-text HTML ("<p>New Delhi</p>") into plain text.
 *
 * Grading already tolerates both forms, so this is a clean-up, not a hot fix. It is idempotent.
 *
 *   node scripts/migrate-plain-answers.js            # dry run: prints what would change
 *   node scripts/migrate-plain-answers.js --apply    # writes the changes
 *
 * Uses MONGO_URI from .env. Against a non-local database you must also pass --yes-i-know.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { htmlToPlainText } = require('../utils/answerText');

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

const HTML_RE = /<\/?(p|br|div|pre|code|strong|em|span)\b[^>]*>/i;

(async () => {
    await mongoose.connect(uri);
    const col = mongoose.connection.db.collection('questions');
    const cursor = col.find(
        { $or: [{ correctAnswer: { $regex: '<' } }, { codeSnippet: { $regex: '<' } }] },
        { projection: { title: 1, type: 1, correctAnswer: 1, codeSnippet: 1 } }
    );
    let scanned = 0;
    let changed = 0;
    for await (const q of cursor) {
        scanned += 1;
        const set = {};
        if (typeof q.correctAnswer === 'string' && HTML_RE.test(q.correctAnswer)) {
            set.correctAnswer = htmlToPlainText(q.correctAnswer).trim();
        }
        if (typeof q.codeSnippet === 'string' && HTML_RE.test(q.codeSnippet)) {
            set.codeSnippet = htmlToPlainText(q.codeSnippet);
        }
        if (!Object.keys(set).length) continue;
        changed += 1;
        console.log(`${APPLY ? 'update' : 'would update'} ${q._id} [${q.type}] "${q.title}"`);
        for (const [k, v] of Object.entries(set)) console.log(`   ${k}: ${JSON.stringify(q[k]).slice(0, 80)} -> ${JSON.stringify(v).slice(0, 80)}`);
        if (APPLY) await col.updateOne({ _id: q._id }, { $set: set });
    }
    console.log(`\n${scanned} candidate question(s), ${changed} ${APPLY ? 'updated' : 'would be updated'}${APPLY ? '' : ' (dry run; pass --apply to write)'}`);
    await mongoose.disconnect();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
