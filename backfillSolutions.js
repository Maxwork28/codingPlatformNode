/**
 * Adds saved solutionCodes to every coding question without wiping users/classes.
 *
 * Usage: node backfillSolutions.js
 *        npm run seed:solutions
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Question = require('./models/Question');
const Class = require('./models/Class');
const { applyDefaultSolutions, CODING_TYPES } = require('./utils/buildDefaultSolutions');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/education_platform';

function usableCount(question) {
  return (question.solutionCodes || []).filter((row) => String(row.code || '').trim()).length;
}

async function assignOrphansToDemoClass() {
  const demo = await Class.findOne({ name: 'Demo Class' });
  if (!demo) {
    console.log('[seed:solutions] No Demo Class found; skipped orphan assignment');
    return 0;
  }

  const orphans = await Question.find({
    $or: [{ classes: { $size: 0 } }, { classes: { $exists: false } }],
  });

  let assigned = 0;
  for (const question of orphans) {
    question.classes = [{ classId: demo._id, isPublished: true, isDisabled: false }];
    await question.save();

    const already = (demo.questions || []).some((id) => String(id) === String(question._id));
    if (!already) {
      demo.questions.push(question._id);
      demo.assignments.push({
        questionId: question._id,
        assignedAt: new Date(),
        maxPoints: question.points || 10,
      });
    }
    assigned += 1;
  }

  if (assigned) {
    await demo.save();
  }
  console.log(`[seed:solutions] Assigned ${assigned} unassigned question(s) to Demo Class`);
  return assigned;
}

async function backfillSolutions() {
  try {
    console.log('[seed:solutions] Connecting...');
    await mongoose.connect(MONGO_URI);
    console.log('[seed:solutions] Connected:', mongoose.connection.name);

    const questions = await Question.find({ type: { $in: CODING_TYPES } });
    console.log(`[seed:solutions] Coding questions: ${questions.length}`);

    let updated = 0;
    for (const question of questions) {
      const before = usableCount(question);
      applyDefaultSolutions(question);
      const after = usableCount(question);
      const missingPrimary = !String(question.solutionCode || '').trim() && after > 0;
      if (after > before || missingPrimary || question.isModified('solutionCodes') || question.isModified('codeSnippet')) {
        question.markModified('solutionCodes');
        await question.save();
        updated += 1;
        console.log(
          `[seed:solutions] ${question._id} ${stripTitle(question.title)} langs=${after}`
        );
      }
    }

    await assignOrphansToDemoClass();

    const remaining = await Question.countDocuments({
      type: { $in: CODING_TYPES },
      $or: [
        { solutionCodes: { $exists: false } },
        { solutionCodes: { $size: 0 } },
        { solutionCodes: { $not: { $elemMatch: { code: { $exists: true, $nin: ['', null] } } } } },
      ],
    });

    console.log(`[seed:solutions] Updated ${updated} question(s). Remaining without usable solutions: ${remaining}`);
    console.log('[seed:solutions] Done.');
  } catch (err) {
    console.error('[seed:solutions] Failed:', err.message, err.stack);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

function stripTitle(title) {
  return String(title || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

backfillSolutions();
