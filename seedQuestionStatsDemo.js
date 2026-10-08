/**
 * Seed Demo Class submissions so Take Class → Question statistics
 * has real student code to open in the editor.
 *
 * Does not wipe users or other classes.
 *
 * Usage: npm run seed:stats
 */
require('dotenv').config();

const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User');
const Class = require('./models/Class');
const Question = require('./models/Question');
const Submission = require('./models/Submission');
const Leaderboard = require('./models/Leaderboard');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/education_platform';
const TITLE = 'Sum Two Numbers';

function assertSafeSeedTarget(uri, label) {
  if (process.argv.includes('--yes-i-know')) return;
  let host = '';
  try {
    host = new URL(uri).hostname.replace(/^\[|\]$/g, '');
  } catch {
    host = '';
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (process.env.NODE_ENV === 'production' || !isLocal) {
    console.error(
      `[${label}] Refusing to run: target host is "${host || 'unparseable'}" and NODE_ENV is "${process.env.NODE_ENV || 'development'}".\n` +
        `[${label}] This script modifies data. Point MONGO_URI at localhost, or pass --yes-i-know to override.`,
    );
    process.exit(1);
  }
}

function randomSeedPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${out}!`;
}

/** Only accounts created by this run get this password; existing accounts keep theirs. */
const PASSWORD = randomSeedPassword();
let createdAccounts = 0;

const CORRECT_PY = `a, b = map(int, input().split())
print(a + b)
`;

const WRONG_SUBTRACT = `a, b = map(int, input().split())
print(a - b)
`;

const WRONG_MULTIPLY = `a, b = map(int, input().split())
print(a * b)
`;

const WRONG_ONE_NUMBER = `print(int(input()) + 1)
`;

const CORRECT_JS = `const fs = require('fs');
const [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
console.log(a + b);
`;

const WRONG_JS = `const fs = require('fs');
const [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
console.log(a - b);
`;

async function upsertUser({ name, email, role, canCreateQuestion }) {
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const existing = await User.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
  if (existing) {
    existing.name = name;
    existing.role = role;
    existing.canCreateQuestion = Boolean(canCreateQuestion);
    if (!existing.password) {
      existing.password = hashed;
      createdAccounts += 1;
    }
    await existing.save();
    return existing;
  }
  createdAccounts += 1;
  return User.create({
    name,
    email,
    number: '9990000000',
    role,
    password: hashed,
    canCreateQuestion: Boolean(canCreateQuestion),
    isBlocked: {},
  });
}

async function run() {
  assertSafeSeedTarget(MONGO_URI, 'seed:stats');
  await mongoose.connect(MONGO_URI);
  console.log('[seed:stats] Connected:', mongoose.connection.name);

  const teacher = await upsertUser({
    name: 'Teacher 1',
    email: 'teacher1@example.com',
    role: 'teacher',
    canCreateQuestion: true,
  });
  const admin = await upsertUser({
    name: 'Admin 1',
    email: 'admin1@example.com',
    role: 'admin',
    canCreateQuestion: true,
  });
  const demo = await upsertUser({
    name: 'Demo Student',
    email: 'demo@example.com',
    role: 'student',
  });

  const students = [demo];
  for (let i = 1; i <= 8; i += 1) {
    students.push(
      await upsertUser({
        name: `Student ${i}`,
        email: `student${i}@example.com`,
        role: 'student',
      })
    );
  }

  let demoClass = await Class.findOne({ name: 'Demo Class' });
  if (!demoClass) {
    demoClass = await Class.create({
      name: 'Demo Class',
      description: 'Demo class for Take Class statistics',
      createdBy: admin._id,
      students: students.map((s) => s._id),
      teachers: [teacher._id],
      questions: [],
      assignments: [],
      status: 'active',
    });
    console.log('[seed:stats] Created Demo Class');
  } else {
    const existingStudents = new Set((demoClass.students || []).map((id) => id.toString()));
    students.forEach((s) => {
      if (!existingStudents.has(s._id.toString())) demoClass.students.push(s._id);
    });
    const teacherId = teacher._id.toString();
    if (!(demoClass.teachers || []).some((id) => id.toString() === teacherId)) {
      demoClass.teachers.push(teacher._id);
    }
    await demoClass.save();
    console.log('[seed:stats] Updated Demo Class roster');
  }

  let question = await Question.findOne({ title: TITLE, type: 'coding' });
  const classEntry = {
    classId: demoClass._id,
    isPublished: true,
    isDisabled: false,
    publishedAt: new Date(),
  };
  if (!question) {
    question = await Question.create({
      title: TITLE,
      description: 'Read two integers on one line and print their sum.',
      difficulty: 'easy',
      level: 'beginner',
      points: 10,
      type: 'coding',
      createdBy: teacher._id,
      languages: ['python', 'javascript'],
      timeLimit: 2,
      memoryLimit: 256,
      inputFormat: 'Two integers a and b separated by a space.',
      outputFormat: 'A single integer: a + b.',
      sampleIo: [{ input: '2 3', output: '5' }],
      testCases: [
        { input: '2 3', expectedOutput: '5', isPublic: true },
        { input: '10 20', expectedOutput: '30', isPublic: true },
        { input: '-4 9', expectedOutput: '5', isPublic: false },
      ],
      starterCode: [
        { language: 'python', code: '# Read two integers and print their sum\n' },
        { language: 'javascript', code: '// Read two integers and print their sum\n' },
      ],
      templateCode: [
        { language: 'python', code: '# Read two integers and print their sum\n' },
        { language: 'javascript', code: '// Read two integers and print their sum\n' },
      ],
      solutionCodes: [
        { language: 'python', code: CORRECT_PY },
        { language: 'javascript', code: CORRECT_JS },
      ],
      solutionCode: CORRECT_PY,
      solutionLanguage: 'python',
      classes: [classEntry],
      status: 'published',
      isDraft: false,
      tags: ['math', 'basics'],
    });
    console.log('[seed:stats] Created question:', TITLE);
  } else {
    const existingClass = (question.classes || []).find(
      (c) => c.classId.toString() === demoClass._id.toString()
    );
    if (!existingClass) question.classes.push(classEntry);
    else {
      existingClass.isPublished = true;
      existingClass.isDisabled = false;
      existingClass.publishedAt = new Date();
    }
    question.solutionCodes = [
      { language: 'python', code: CORRECT_PY },
      { language: 'javascript', code: CORRECT_JS },
    ];
    await question.save();
    console.log('[seed:stats] Updated question:', TITLE);
  }

  if (!(demoClass.questions || []).some((id) => id.toString() === question._id.toString())) {
    demoClass.questions.push(question._id);
  }
  const hasAssignment = (demoClass.assignments || []).some(
    (a) => a.questionId.toString() === question._id.toString()
  );
  if (!hasAssignment) {
    demoClass.assignments.push({
      questionId: question._id,
      assignedAt: new Date(),
      maxPoints: 10,
    });
  }
  await demoClass.save();

  await Submission.deleteMany({ questionId: question._id, classId: demoClass._id });
  await Leaderboard.removeQuestion({ classIds: [demoClass._id], questionId: question._id });

  const rows = [
    { student: students[0], language: 'python', code: WRONG_SUBTRACT, correct: false }, // demo
    { student: students[1], language: 'python', code: WRONG_MULTIPLY, correct: false },
    { student: students[2], language: 'python', code: WRONG_ONE_NUMBER, correct: false },
    { student: students[3], language: 'javascript', code: WRONG_JS, correct: false },
    { student: students[4], language: 'python', code: CORRECT_PY, correct: true },
    { student: students[5], language: 'javascript', code: CORRECT_JS, correct: true },
    { student: students[6], language: 'python', code: WRONG_SUBTRACT, correct: false },
    // students[7] and students[8] stay inactive
  ];

  const now = Date.now();
  const submissions = rows.map((row, i) => ({
    questionId: question._id,
    classId: demoClass._id,
    studentId: row.student._id,
    answer: row.code,
    language: row.language,
    isCorrect: row.correct,
    score: row.correct ? 10 : 0,
    output: row.correct ? 'Correct' : 'Incorrect',
    isRun: false,
    passedTestCases: row.correct ? 3 : 0,
    totalTestCases: 3,
    status: row.correct ? 'accepted' : 'wrong_answer',
    submittedAt: new Date(now - (rows.length - i) * 60 * 1000),
  }));

  const inserted = await Submission.insertMany(submissions);
  console.log(`[seed:stats] Inserted ${inserted.length} submissions`);

  // One atomic leaderboard update per submission (the same path the API uses).
  for (const sub of inserted) {
    await Leaderboard.recordSubmit({
      classId: demoClass._id,
      studentId: sub.studentId,
      questionId: question._id,
      questionType: 'coding',
      submissionId: sub._id,
      score: sub.score,
      isCorrect: sub.isCorrect,
      submittedAt: sub.submittedAt,
      passedTestCases: sub.passedTestCases,
      totalTestCases: sub.totalTestCases,
    });
  }

  console.log('\n[seed:stats] Ready to check Question statistics\n');
  console.log('  Teacher login: teacher1@example.com');
  if (createdAccounts > 0) {
    console.log(`  Password for the ${createdAccounts} account(s) created by this run (shown once): ${PASSWORD}`);
  } else {
    console.log('  All demo accounts already existed; their passwords were left unchanged.');
  }
  console.log('  Take Class → Demo Class → Sum Two Numbers → ⋮ → Question statistics');
  console.log('  Open a Wrong student (Demo Student, Student 1–3, 6) in the editor');
  console.log('  Fix print(a - b) to print(a + b), then Run corrected code\n');
  console.log('  Question id:', question._id.toString());
  console.log('  Class id:   ', demoClass._id.toString());
}

run()
  .catch((err) => {
    console.error('[seed:stats] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
