const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  role: { type: String, enum: ['admin', 'teacher', 'student', 'superAdmin'], required: true }
}, { collection: 'users' });

const User = mongoose.model('User', userSchema);

const MONGO_URI = 'mongodb://localhost:27017/education_platform';

async function getTestIds() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB\n');

    const admin = await User.findOne({ email: 'admin1@example.com' }).lean();
    const teacher = await User.findOne({ email: 'teacher1@example.com' }).lean();
    const student = await User.findOne({ email: 'demo@example.com' }).lean();

    console.log('===== TEST ACCOUNT IDs =====\n');
    console.log('ADMIN:');
    console.log(`  Email: admin1@example.com`);
    console.log(`  Password: Password123!`);
    console.log(`  ID: ${admin?._id}\n`);

    console.log('TEACHER:');
    console.log(`  Email: teacher1@example.com`);
    console.log(`  Password: Password123!`);
    console.log(`  ID: ${teacher?._id}\n`);

    console.log('STUDENT (Demo):');
    console.log(`  Email: demo@example.com`);
    console.log(`  Password: Password123!`);
    console.log(`  ID: ${student?._id}\n`);

    console.log('===========================');

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

getTestIds();

