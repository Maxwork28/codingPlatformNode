/**
 * Seeds only the `users` collection (admins, teachers, students).
 * Does not touch classes, questions, exams, etc.
 *
 * Usage: node seedUsersOnly.js
 *        npm run seed:users
 *
 * Default password for all accounts: Password123!
 */
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/education_platform';
const SALT_ROUNDS = 10;

/** @type {{ admins: number; teachers: number; students: number }} */
const COUNTS = {
  admins: Number(process.env.SEED_USER_ADMINS) || 5,
  teachers: Number(process.env.SEED_USER_TEACHERS) || 10,
  students: Number(process.env.SEED_USER_STUDENTS) || 20,
};

async function seedUsersOnly() {
  try {
    console.log('[seed:users] Connecting...');
    await mongoose.connect(MONGO_URI);
    console.log('[seed:users] Connected:', mongoose.connection.name);

    const hashedPassword = await bcrypt.hash('Password123!', SALT_ROUNDS);
    const users = [];

    for (let i = 0; i < COUNTS.admins; i++) {
      users.push({
        name: `Admin ${i + 1}`,
        email: `admin${i + 1}@example.com`,
        number: '9999990001',
        role: 'admin',
        password: hashedPassword,
        canCreateQuestion: true,
        isBlocked: new Map(),
      });
    }

    for (let i = 0; i < COUNTS.teachers; i++) {
      users.push({
        name: `Teacher ${i + 1}`,
        email: `teacher${i + 1}@example.com`,
        number: '9999991001',
        role: 'teacher',
        password: hashedPassword,
        canCreateQuestion: true,
        isBlocked: new Map(),
      });
    }

    users.push({
      name: 'Demo Student',
      email: 'demo@example.com',
      number: '9999992000',
      role: 'student',
      password: hashedPassword,
      canCreateQuestion: false,
      isBlocked: new Map(),
    });

    for (let i = 0; i < COUNTS.students; i++) {
      users.push({
        name: `Student ${i + 1}`,
        email: `student${i + 1}@example.com`,
        number: `999999${String(3000 + i).padStart(4, '0')}`,
        role: 'student',
        password: hashedPassword,
        canCreateQuestion: false,
        isBlocked: new Map(),
      });
    }

    const deleted = await User.deleteMany({});
    console.log(`[seed:users] Removed ${deleted.deletedCount} existing user documents`);

    const inserted = await User.insertMany(users);
    console.log(`[seed:users] Inserted ${inserted.length} users (${
      COUNTS.admins
    } admins, ${COUNTS.teachers} teachers, ${1 + COUNTS.students} students incl. demo)`);

    console.log('\n[seed:users] Sample logins (password: Password123!)');
    console.log('  admin1@example.com');
    console.log('  teacher1@example.com');
    console.log('  demo@example.com');
    console.log('  student1@example.com');
    console.log('\n[seed:users] Done.');
  } catch (err) {
    console.error('[seed:users] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

seedUsersOnly();
