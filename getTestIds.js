/**
 * Prints stable test account and demo data IDs (matches seed.js credentials).
 * Usage: node getTestIds.js
 * Uses MONGO_URI from .env when present.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('./models/User');
const Class = require('./models/Class');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/education_platform';

function oidToString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value.toString) return value.toString();
  return null;
}

async function getTestIds() {
  try {
    await mongoose.connect(MONGO_URI);
    const userCount = await User.countDocuments();
    console.log('Connected to MongoDB');
    console.log(`  URI (host/db): ${mongoose.connection.host} / ${mongoose.connection.name}`);
    console.log(`  Users in collection: ${userCount}`);
    if (userCount > 0 && userCount <= 20) {
      const sample = await User.find().select('email role').limit(10).lean();
      console.log('  Sample emails:', sample.map((u) => `${u.email} (${u.role})`).join(', '));
    }
    console.log('');

    const [admin, teacher, demoStudent, student1, demoClass] = await Promise.all([
      User.findOne({ email: 'admin1@example.com' }).lean(),
      User.findOne({ email: 'teacher1@example.com' }).lean(),
      User.findOne({ email: 'demo@example.com' }).lean(),
      User.findOne({ email: 'student1@example.com' }).lean(),
      Class.findOne({ name: 'Demo Class' }).lean(),
    ]);

    const firstAssignmentQuestionId = demoClass?.assignments?.length
      ? oidToString(demoClass.assignments[0].questionId)
      : null;
    const firstClassQuestionId = demoClass?.questions?.length
      ? oidToString(demoClass.questions[0])
      : null;

    const testIds = {
      users: {
        admin: {
          email: 'admin1@example.com',
          password: 'Password123!',
          id: oidToString(admin?._id),
        },
        teacher: {
          email: 'teacher1@example.com',
          password: 'Password123!',
          id: oidToString(teacher?._id),
        },
        demoStudent: {
          email: 'demo@example.com',
          password: 'Password123!',
          id: oidToString(demoStudent?._id),
        },
        student1: {
          email: 'student1@example.com',
          password: 'Password123!',
          id: oidToString(student1?._id),
        },
      },
      demoClass: demoClass
        ? {
            id: oidToString(demoClass._id),
            name: demoClass.name,
            firstAssignmentQuestionId,
            firstQuestionId: firstClassQuestionId,
            assignmentCount: demoClass.assignments?.length ?? 0,
            questionCount: demoClass.questions?.length ?? 0,
          }
        : null,
    };

    console.log('===== TEST ACCOUNT IDs (see seed.js) =====\n');

    const rows = [
      ['ADMIN', testIds.users.admin],
      ['TEACHER', testIds.users.teacher],
      ['STUDENT (demo)', testIds.users.demoStudent],
      ['STUDENT 1', testIds.users.student1],
    ];

    for (const [label, u] of rows) {
      console.log(`${label}:`);
      console.log(`  Email: ${u.email}`);
      console.log(`  Password: ${u.password}`);
      console.log(`  ID: ${u.id ?? '(not found — run seed or check DB)'}\n`);
    }

    if (testIds.demoClass) {
      console.log('DEMO CLASS:');
      console.log(`  Name: ${testIds.demoClass.name}`);
      console.log(`  ID: ${testIds.demoClass.id}`);
      console.log(`  Assignments: ${testIds.demoClass.assignmentCount}, Questions: ${testIds.demoClass.questionCount}`);
      console.log(`  First assignment question ID: ${testIds.demoClass.firstAssignmentQuestionId ?? 'n/a'}`);
      console.log(`  First class question ID: ${testIds.demoClass.firstQuestionId ?? 'n/a'}\n`);
    } else {
      console.log('DEMO CLASS: (not found — run seed)\n');
    }

    console.log('======== JSON (for tests / env / fixtures) ========\n');
    console.log(JSON.stringify(testIds, null, 2));
    console.log('\n====================================================');

    if (!admin && !teacher && !demoStudent && !student1) {
      console.log(
        '\nNo seeded users matched (admin1@ / teacher1@ / demo@ / student1@).'
      );
      if (userCount === 0) {
        console.log('The database has zero users — run the seed once:\n  npm run seed\n  # or: node seed.js\n');
      } else {
        console.log(
          'Users exist but not these emails. Seed this DB or fix .env MONGO_URI to match where data lives.\n'
        );
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

getTestIds();
