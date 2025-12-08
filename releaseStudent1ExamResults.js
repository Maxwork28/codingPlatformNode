const mongoose = require('mongoose');

// Define Exam Schema
const examSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  questions: [mongoose.Schema.Types.Mixed],
  sections: [mongoose.Schema.Types.Mixed],
  proctoring: mongoose.Schema.Types.Mixed,
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
 * Releases results for student1 exam by setting immediateScoreRelease to true
 */
async function releaseStudent1ExamResults() {
  try {
    console.log('[Release] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('[Release] Connected to MongoDB');

    // Find the exam for student1 (by title pattern)
    const examTitlePattern = /Student1 Special Exam/i;
    const exam = await Exam.findOne({ title: { $regex: examTitlePattern } });

    if (!exam) {
      console.log('[Release] Error: Exam for student1 not found');
      console.log('[Release] Searching for exams with "student1" in title...');
      const allExams = await Exam.find({ title: { $regex: /student1/i } });
      if (allExams.length === 0) {
        console.log('[Release] No exams found for student1');
      } else {
        console.log('[Release] Found exams:');
        allExams.forEach((e) => {
          console.log(`  - ${e.title} (ID: ${e._id})`);
        });
      }
      await mongoose.disconnect();
      return;
    }

    console.log(`[Release] Found exam: "${exam.title}"`);
    console.log(`[Release] Current immediateScoreRelease: ${exam.scoring?.immediateScoreRelease || false}`);
    console.log(`[Release] Current releaseStatus: ${exam.scoring?.releaseStatus || 'not_released'}`);

    // Ensure scoring object exists
    if (!exam.scoring) {
      exam.scoring = {};
    }

    // Set immediateScoreRelease to true
    exam.scoring.immediateScoreRelease = true;
    exam.updatedAt = new Date();
    await exam.save();

    console.log('[Release] Exam results released successfully!');
    console.log(`[Release] immediateScoreRelease: ${exam.scoring.immediateScoreRelease}`);
    console.log(`[Release] Students can now view their results immediately after submission.`);

    await mongoose.disconnect();
    console.log('[Release] Disconnected from MongoDB');
  } catch (error) {
    console.error('[Release] Error releasing exam results:', error.message, error.stack);
    await mongoose.disconnect();
    throw error;
  }
}

// Run the function
releaseStudent1ExamResults().catch((err) => {
  console.error('[Release] Release process failed:', err.message, err.stack);
  process.exit(1);
});

