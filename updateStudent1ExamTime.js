const mongoose = require('mongoose');

// Define Exam Schema (matching seed.js)
const examSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  questions: [mongoose.Schema.Types.Mixed],
  sections: [mongoose.Schema.Types.Mixed],
  proctoring: {
    durationMinutes: { type: Number, required: true },
    startTime: { type: Date },
    endTime: { type: Date },
    autoSubmitOnEnd: { type: Boolean, default: true },
    tabSwitchLimit: { type: Number, default: 5 },
    copyPasteDisabled: { type: Boolean, default: true },
    fullscreenRequired: { type: Boolean, default: true },
    internetRequired: { type: Boolean, default: true },
    allowRunCode: { type: Boolean, default: true }
  },
  scoring: mongoose.Schema.Types.Mixed,
  template: mongoose.Schema.Types.Mixed,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['draft', 'scheduled', 'active', 'completed', 'archived'], default: 'draft' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Exam = mongoose.model('Exam', examSchema);

// MongoDB connection
const MONGO_URI = 'mongodb://localhost:27017/education_platform';

/**
 * Updates the exam time for student1
 * @param {number} startHour - Start hour (0-23)
 * @param {number} startMinute - Start minute (0-59)
 * @param {number} endHour - End hour (0-23)
 * @param {number} endMinute - End minute (0-59)
 */
async function updateStudent1ExamTime(startHour, startMinute, endHour, endMinute) {
  try {
    // Connect to MongoDB
    console.log('[Update] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('[Update] Connected to MongoDB');

    // Find the exam for student1 (by title pattern)
    const examTitlePattern = /Student1 Special Exam/i;
    const exam = await Exam.findOne({ title: { $regex: examTitlePattern } });

    if (!exam) {
      console.log('[Update] Error: Exam for student1 not found');
      console.log('[Update] Searching for exams with "student1" in title...');
      const allExams = await Exam.find({ title: { $regex: /student1/i } });
      if (allExams.length === 0) {
        console.log('[Update] No exams found for student1');
      } else {
        console.log('[Update] Found exams:');
        allExams.forEach((e) => {
          console.log(`  - ${e.title} (ID: ${e._id})`);
        });
      }
      await mongoose.disconnect();
      return;
    }

    console.log(`[Update] Found exam: "${exam.title}"`);
    console.log(`[Update] Current start time: ${exam.proctoring?.startTime ? new Date(exam.proctoring.startTime).toLocaleString() : 'Not set'}`);
    console.log(`[Update] Current end time: ${exam.proctoring?.endTime ? new Date(exam.proctoring.endTime).toLocaleString() : 'Not set'}`);

    // Calculate new times
    const now = new Date();
    const newStartTime = new Date(now);
    newStartTime.setHours(startHour, startMinute, 0, 0);

    const newEndTime = new Date(now);
    newEndTime.setHours(endHour, endMinute, 0, 0);

    // If the start time has already passed today, set it for tomorrow
    if (newStartTime < now) {
      newStartTime.setDate(newStartTime.getDate() + 1);
      newEndTime.setDate(newEndTime.getDate() + 1);
      console.log('[Update] Start time has passed today, setting for tomorrow');
    }

    // Calculate duration in minutes
    const durationMinutes = Math.floor((newEndTime.getTime() - newStartTime.getTime()) / (60 * 1000));

    // Update exam
    exam.proctoring.startTime = newStartTime;
    exam.proctoring.endTime = newEndTime;
    exam.proctoring.durationMinutes = durationMinutes;
    
    // Ensure scoring object exists
    if (!exam.scoring) {
      exam.scoring = {};
    }
    // Set immediateScoreRelease to true so students can see results immediately
    exam.scoring.immediateScoreRelease = true;
    
    // Update status based on new times
    if (newStartTime > now) {
      exam.status = 'scheduled';
    } else if (newEndTime > now) {
      exam.status = 'active';
    } else {
      exam.status = 'completed';
    }

    exam.updatedAt = new Date();
    await exam.save();

    console.log(`[Update] Exam updated successfully!`);
    console.log(`[Update] New start time: ${newStartTime.toLocaleString()}`);
    console.log(`[Update] New end time: ${newEndTime.toLocaleString()}`);
    console.log(`[Update] Duration: ${durationMinutes} minutes`);
    console.log(`[Update] Status: ${exam.status}`);
    console.log(`[Update] Immediate Score Release: ${exam.scoring.immediateScoreRelease}`);

    await mongoose.disconnect();
    console.log('[Update] Disconnected from MongoDB');
  } catch (error) {
    console.error('[Update] Error updating exam time:', error.message, error.stack);
    await mongoose.disconnect();
    throw error;
  }
}

// Get command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  // Default: 6:20 PM to 6:50 PM
  console.log('[Update] No arguments provided, using default: 6:20 PM to 6:50 PM');
  updateStudent1ExamTime(18, 20, 18, 50).catch((err) => {
    console.error('[Update] Update process failed:', err.message, err.stack);
    process.exit(1);
  });
} else if (args.length === 4) {
  // Parse arguments: startHour startMinute endHour endMinute
  const startHour = parseInt(args[0], 10);
  const startMinute = parseInt(args[1], 10);
  const endHour = parseInt(args[2], 10);
  const endMinute = parseInt(args[3], 10);

  if (isNaN(startHour) || isNaN(startMinute) || isNaN(endHour) || isNaN(endMinute)) {
    console.error('[Update] Error: All arguments must be numbers');
    console.log('[Update] Usage: node updateStudent1ExamTime.js [startHour startMinute endHour endMinute]');
    console.log('[Update] Example: node updateStudent1ExamTime.js 18 20 18 50  (6:20 PM to 6:50 PM)');
    process.exit(1);
  }

  updateStudent1ExamTime(startHour, startMinute, endHour, endMinute).catch((err) => {
    console.error('[Update] Update process failed:', err.message, err.stack);
    process.exit(1);
  });
} else {
  console.log('[Update] Usage: node updateStudent1ExamTime.js [startHour startMinute endHour endMinute]');
  console.log('[Update] Example: node updateStudent1ExamTime.js 18 20 18 50  (6:20 PM to 6:50 PM)');
  console.log('[Update] Example: node updateStudent1ExamTime.js 18 10 18 40  (6:10 PM to 6:40 PM)');
  console.log('[Update] If no arguments provided, defaults to 6:20 PM to 6:50 PM');
  process.exit(1);
}

