require('dotenv').config();

const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker');
const bcrypt = require('bcrypt');

// Define Models
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  email: { type: String, unique: true, required: true, index: true },
  number: String,
  role: { type: String, enum: ['admin', 'teacher', 'student', 'superAdmin'], required: true },
  password: String,
  resetToken: String,
  resetTokenExpiry: Date,
  canCreateQuestion: { type: Boolean, default: false },
  isBlocked: { type: Map, of: Boolean, default: {} }
}, {
  indexes: [{ key: { name: 'text', email: 'text' } }]
});

const classSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  teachers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Question' }],
  assignments: [{
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    assignedAt: { type: Date, default: Date.now },
    dueDate: { type: Date },
    maxPoints: { type: Number, default: 10 }
  }],
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  totalRuns: { type: Number, default: 0 },
  totalSubmits: { type: Number, default: 0 }
}, {
  indexes: [
    { key: { questions: 1 } },
    { key: { 'assignments.questionId': 1 } }
  ]
});

const classSettingsSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  isPublished: { type: Boolean, default: false },
  isDisabled: { type: Boolean, default: false }
});

const testCaseSchema = new mongoose.Schema({
  input: { type: String, required: true },
  expectedOutput: { type: String, required: true },
  isPublic: { type: Boolean, default: false }
});

const questionSchema = new mongoose.Schema({
  classes: [classSettingsSchema],
  title: { type: String, required: true },
  description: { type: String, required: true },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
  tags: [{ type: String }],
  points: { type: Number, default: 10 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  hints: [{ type: String }],
  solution: { type: String },
  level: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
  type: {
    type: String,
    enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'],
    required: true
  },
  options: [{ type: String }],
  correctOption: { type: Number },
  correctOptions: [{ type: Number }],
  correctAnswer: { type: String },
  codeSnippet: { type: String },
  starterCode: [{
    language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] },
    code: { type: String }
  }],
  templateCode: [{
    language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] },
    code: { type: String }
  }],
  driverCode: [{
    language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] },
    code: { type: String }
  }],
  testCases: [testCaseSchema],
  constraints: { type: String },
  examples: [{ type: String }],
  languages: [{ type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] }],
  timeLimit: { type: Number, default: 2 },
  memoryLimit: { type: Number, default: 256 },
  maxAttempts: { type: Number },
  explanation: { type: String }
}, {
  indexes: [
    { key: { 'classes.classId': 1 } },
    { key: { title: 'text', tags: 'text' } }
  ]
});

const submissionSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answer: mongoose.Schema.Types.Mixed, // Changed to Mixed to support arrays for multipleCorrectMcq
  isCorrect: Boolean,
  isCustomInput: { type: Boolean, default: false },
  score: Number,
  output: String,
  submittedAt: { type: Date, default: Date.now },
  isRun: { type: Boolean, default: false },
  examAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt' },
  passedTestCases: { type: Number, default: 0 },
  totalTestCases: { type: Number, default: 0 },
  language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] }
});

const attemptSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  questionType: {
    type: String,
    enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'],
    required: true
  },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
  isCorrect: { type: Boolean, required: true },
  score: { type: Number, required: true },
  output: String,
  submittedAt: { type: Date, required: true },
  isRun: { type: Boolean, default: false }
});

const leaderboardSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attempts: [attemptSchema],
  highestScores: [{
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
    score: { type: Number, required: true },
    isCorrect: { type: Boolean, required: true },
    submittedAt: { type: Date, required: true }
  }],
  totalScore: { type: Number, default: 0 },
  correctAttempts: { type: Number, default: 0 },
  wrongAttempts: { type: Number, default: 0 },
  totalRuns: { type: Number, default: 0 },
  totalSubmits: { type: Number, default: 0 },
  activityStatus: { type: String, enum: ['active', 'inactive', 'focused'], default: 'inactive' },
  needsFocus: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});

leaderboardSchema.index({ classId: 1, studentId: 1 }, { unique: true });
leaderboardSchema.index({ activityStatus: 1 });
leaderboardSchema.index({ needsFocus: 1 });

leaderboardSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  const highestByQuestion = {};
  let correctCount = 0;
  let wrongCount = 0;
  let runCount = 0;
  let submitCount = 0;

  for (const attempt of this.attempts) {
    const qId = attempt.questionId.toString();
    if (!['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'].includes(attempt.questionType)) {
      console.error(`[Leaderboard] Invalid questionType: ${attempt.questionType} for questionId: ${qId}`);
      attempt.questionType = 'coding'; // Fallback to a valid type
    }
    if (attempt.isCorrect) correctCount++;
    else wrongCount++;
    if (attempt.isRun) runCount++;
    else submitCount++;

    if (!highestByQuestion[qId] || attempt.score > highestByQuestion[qId].score ||
        (attempt.score === highestByQuestion[qId].score && attempt.submittedAt > highestByQuestion[qId].submittedAt)) {
      highestByQuestion[qId] = {
        questionId: attempt.questionId,
        submissionId: attempt.submissionId,
        score: attempt.score,
        isCorrect: attempt.isCorrect,
        submittedAt: attempt.submittedAt
      };
    }
  }

  this.highestScores = Object.values(highestByQuestion);
  this.totalScore = this.highestScores.reduce((sum, entry) => sum + entry.score, 0);
  this.correctAttempts = correctCount;
  this.wrongAttempts = wrongCount;
  this.totalRuns = runCount;
  this.totalSubmits = submitCount;
  this.activityStatus = this.totalSubmits > 0 ? (this.totalSubmits >= 5 ? 'focused' : 'active') : 'inactive';

  next();
});

// Exam Models
const examQuestionSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  points: { type: Number, default: 0 },
  order: { type: Number, default: 0 },
  sectionId: { type: String },
  timeLimitSeconds: { type: Number }
}, { _id: false });

const examSectionSchema = new mongoose.Schema({
  sectionId: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String },
  durationSeconds: { type: Number, default: 0 },
  allowRevisit: { type: Boolean, default: true },
  order: { type: Number, default: 0 }
}, { _id: false });

const examSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  questions: [examQuestionSchema],
  sections: [examSectionSchema],
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
  scoring: {
    immediateScoreRelease: { type: Boolean, default: false },
    releaseStatus: { type: String, enum: ['not_released', 'released'], default: 'not_released' },
    gradingMode: { type: String, enum: ['auto', 'manual', 'mixed'], default: 'auto' }
  },
  template: {
    isTemplate: { type: Boolean, default: false },
    templateName: { type: String },
    templateDescription: { type: String },
    baseTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam' }
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['draft', 'scheduled', 'active', 'completed', 'archived'], default: 'draft' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const violationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['tab_switch', 'fullscreen_exit', 'copy_paste', 'network_loss', 'heartbeat'],
    required: true
  },
  timestamp: { type: Date, default: Date.now },
  details: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const answerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
  answer: mongoose.Schema.Types.Mixed,
  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  isCorrect: { type: Boolean, default: false },
  language: { type: String },
  passedTestCases: { type: Number, default: 0 },
  totalTestCases: { type: Number, default: 0 }
}, { _id: false });

const sectionTimerSchema = new mongoose.Schema({
  sectionId: { type: String, required: true },
  remainingSeconds: { type: Number, default: 0 },
  completed: { type: Boolean, default: false }
}, { _id: false });

const questionTimerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  remainingSeconds: { type: Number },
  completed: { type: Boolean, default: false }
}, { _id: false });

const examAttemptSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'submitted', 'auto_submitted', 'terminated', 'expired'],
    default: 'not_started'
  },
  startedAt: { type: Date },
  endsAt: { type: Date },
  submittedAt: { type: Date },
  autoSubmitted: { type: Boolean, default: false },
  manualSubmitted: { type: Boolean, default: false },
  currentSectionId: { type: String },
  currentQuestionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
  sectionTimers: [sectionTimerSchema],
  questionTimers: [questionTimerSchema],
  violations: [violationSchema],
  violationCount: { type: Number, default: 0 },
  tabSwitchCount: { type: Number, default: 0 },
  fullscreenExitCount: { type: Number, default: 0 },
  copyPasteCount: { type: Number, default: 0 },
  networkDropCount: { type: Number, default: 0 },
  lastHeartbeatAt: { type: Date },
  answers: [answerSchema],
  totalScore: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  remark: { type: String },
  feedback: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

examAttemptSchema.index({ examId: 1, studentId: 1 }, { unique: true });

// Register Models
const User = mongoose.model('User', userSchema);
const Class = mongoose.model('Class', classSchema);
const Question = mongoose.model('Question', questionSchema);
const Submission = mongoose.model('Submission', submissionSchema);
const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);
const Exam = mongoose.model('Exam', examSchema);
const ExamAttempt = mongoose.model('ExamAttempt', examAttemptSchema);

// MongoDB connection (same as server.js / getTestIds.js when .env is set)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/education_platform';
const SALT_ROUNDS = 10;

// Sample data configurations
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const QUESTION_TYPES = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'];
const LANGUAGES = ['javascript', 'python', 'java', 'cpp', 'c', 'php', 'ruby', 'go'];
const ACTIVITY_STATUSES = ['active', 'inactive', 'focused'];

// Realistic class data
const CLASS_DATA = [
  { name: 'CS101: Introduction to Programming', description: 'Learn the basics of programming using Python.' },
  { name: 'CS201: Data Structures', description: 'Explore fundamental data structures like arrays, linked lists, stacks, and queues.' },
  { name: 'CS301: Algorithms', description: 'Study algorithm design and analysis.' },
  { name: 'CS102: Web Development Basics', description: 'Build dynamic websites using HTML, CSS, and JavaScript.' },
  { name: 'CS202: Object-Oriented Programming', description: 'Master OOP concepts in Java.' },
  { name: 'CS302: Database Systems', description: 'Learn about relational databases, SQL, and NoSQL.' },
  { name: 'CS103: Introduction to JavaScript', description: 'Get started with JavaScript.' },
  { name: 'CS203: Advanced Python Programming', description: 'Dive deeper into Python.' },
  { name: 'CS303: Competitive Programming', description: 'Prepare for coding competitions.' },
  { name: 'CS401: Software Engineering', description: 'Learn software development methodologies.' },
  { name: 'Demo Class', description: 'A demo class with all questions available, published, enabled, and assigned. Perfect for testing and practice! Login with demo@example.com.' }
];

// Realistic question data
const QUESTION_DATA = [
  {
    title: 'Reverse a String',
    description: 'Write a function that reverses a given string.',
    type: 'coding',
    difficulty: 'easy',
    level: 'beginner',
    points: 10,
    timeLimit: 2,
    memoryLimit: 256,
    starterCode: [
      { language: 'javascript', code: 'function reverseString(str) {\n  // Your code here\n}' },
      { language: 'python', code: 'def reverse_string(s):\n    # Your code here\n' },
      { language: 'java', code: 'public String reverseString(String str) {\n    // Your code here\n}' }
    ],
    testCases: [
      { input: '"hello"', expectedOutput: '"olleh"', isPublic: true },
      { input: '"world"', expectedOutput: '"dlrow"', isPublic: true },
      { input: '"abc"', expectedOutput: '"cba"', isPublic: false }
    ],
    constraints: '1 <= str.length <= 100',
    examples: ['Input: "hello" -> Output: "olleh"', 'Input: "world" -> Output: "dlrow"'],
    languages: ['javascript', 'python', 'java'],
    tags: ['string', 'algorithm'],
    hints: ['Use a loop to swap characters.', 'Consider built-in string methods.'],
    solution: 'Reverse the string by iterating from both ends and swapping characters.',
    explanation: 'The solution iterates through the string and swaps characters from both ends.'
  },
  {
    title: 'What is a Variable?',
    description: 'Choose the correct definition of a variable in programming.',
    type: 'singleCorrectMcq',
    difficulty: 'easy',
    level: 'beginner',
    points: 5,
    timeLimit: 1,
    memoryLimit: 128,
    options: [
      'A named storage location in memory',
      'A type of loop',
      'A function definition',
      'A database query'
    ],
    correctOption: 0,
    tags: ['basics', 'programming'],
    hints: ['Think about how data is stored in a program.'],
    explanation: 'A variable is a named storage location in memory used to hold data.'
  },
  {
    title: 'Multiple Choice Question',
    description: 'Select all correct data types in Python.',
    type: 'multipleCorrectMcq',
    difficulty: 'medium',
    level: 'intermediate',
    points: 8,
    timeLimit: 1,
    memoryLimit: 128,
    options: ['int', 'float', 'char', 'list'],
    correctOptions: [0, 1, 3],
    tags: ['python', 'data types'],
    hints: ['Consider Python’s built-in data types.'],
    explanation: 'Python includes int, float, and list, but char is not a distinct type.'
  },
  {
    title: 'Complete the Python Loop Syntax',
    description: 'Fill in the blank to complete the Python for loop syntax.',
    type: 'fillInTheBlanks',
    difficulty: 'easy',
    level: 'beginner',
    points: 5,
    timeLimit: 1,
    memoryLimit: 128,
    correctAnswer: 'range',
    tags: ['python', 'loops'],
    hints: ['The keyword generates a sequence of numbers.'],
    explanation: 'The range function is used in Python for loops to iterate over a sequence.'
  },
  {
    title: 'Find the Maximum Element',
    description: 'Write a function to find the maximum element in an array of integers. Your program must read one JSON value from stdin (a bare array like [1,2,3]) and print the result.',
    type: 'coding',
    difficulty: 'medium',
    level: 'intermediate',
    points: 15,
    timeLimit: 3,
    memoryLimit: 256,
    starterCode: [
      {
        language: 'javascript',
        code:
          "const fs = require('fs');\n" +
          'function findMax(arr) {\n' +
          '  // Your code here\n' +
          '}\n' +
          "const raw = fs.readFileSync(0, 'utf8').trim();\n" +
          'const data = JSON.parse(raw);\n' +
          'const arr = Array.isArray(data) ? data : data.arr;\n' +
          'console.log(findMax(arr));\n'
      },
      {
        language: 'python',
        code:
          'import json\n' +
          'import sys\n\n' +
          'def find_max(arr):\n' +
          '    # Your code here\n' +
          '    pass\n\n' +
          'data = json.loads(sys.stdin.read().strip())\n' +
          "arr = data if isinstance(data, list) else data['arr']\n" +
          'print(find_max(arr))\n'
      }
    ],
    testCases: [
      { input: '[1, 5, 3, 9, 2]', expectedOutput: '9', isPublic: true },
      { input: '[-1, -5, -3]', expectedOutput: '-1', isPublic: true },
      { input: '[0]', expectedOutput: '0', isPublic: false }
    ],
    constraints: '1 <= arr.length <= 1000, -10^9 <= arr[i] <= 10^9',
    examples: ['Input: [1, 5, 3, 9, 2] -> Output: 9', 'Input: [-1, -5, -3] -> Output: -1'],
    languages: ['javascript', 'python'],
    tags: ['array', 'algorithm'],
    hints: ['Track the largest value while iterating.', 'Handle negative numbers.'],
    solution: 'Iterate through the array and update the maximum value.',
    explanation: 'The solution iterates through the array to find the largest element.'
  },
  {
    title: 'Find Maximum (LeetCode-style)',
    description: 'Write a function to find the maximum element in an array of integers. You only need to implement the function—input/output is handled by the platform.',
    type: 'codingWithDriver',
    difficulty: 'easy',
    level: 'beginner',
    points: 10,
    timeLimit: 2,
    memoryLimit: 256,
    starterCode: [
      { language: 'javascript', code: 'function findMax(arr) {\n  // Your code here\n  return 0;\n}' },
      { language: 'python', code: 'def find_max(arr):\n    # Your code here\n    pass' }
    ],
    driverCode: [
      { language: 'javascript', code: '// {{USER_CODE}}\n\nconst fs = require(\'fs\');\nconst data = JSON.parse(fs.readFileSync(0, \'utf8\').trim());\nconst result = findMax(data.arr);\nconsole.log(result);\n' },
      { language: 'python', code: 'import json\n\n# {{USER_CODE}}\n\nif __name__ == "__main__":\n    data = json.loads(input())\n    arr = data["arr"]\n    result = find_max(arr)\n    print(result)' }
    ],
    testCases: [
      { input: '{"arr": [1, 5, 3, 9, 2]}', expectedOutput: '9', isPublic: true },
      { input: '{"arr": [-1, -5, -3]}', expectedOutput: '-1', isPublic: true },
      { input: '{"arr": [42]}', expectedOutput: '42', isPublic: false }
    ],
    constraints: '1 <= arr.length <= 1000, -10^9 <= arr[i] <= 10^9',
    examples: ['Input: [1, 5, 3, 9, 2] -> Output: 9', 'Input: [-1, -5, -3] -> Output: -1'],
    languages: ['javascript', 'python'],
    tags: ['array', 'algorithm', 'leetcode-style'],
    hints: ['Use max(arr) in Python or Math.max(...arr) in JavaScript.', 'Or iterate and track the largest value.'],
    solution: 'def find_max(arr): return max(arr)',
    explanation: 'The solution returns the maximum element. Students only implement the function.'
  },
  {
    title: 'Binary Search Implementation',
    description: 'Implement a binary search algorithm to find a target value in a sorted array.',
    type: 'coding',
    difficulty: 'hard',
    level: 'advanced',
    points: 20,
    timeLimit: 4,
    memoryLimit: 512,
    starterCode: [
      { language: 'javascript', code: 'function binarySearch(arr, target) {\n  // Your code here\n}' },
      { language: 'python', code: 'def binary_search(arr, target):\n    # Your code here\n' },
      { language: 'java', code: 'public int binarySearch(int[] arr, int target) {\n    // Your code here\n}' }
    ],
    testCases: [
      { input: '[1, 3, 5, 7, 9], 5', expectedOutput: '2', isPublic: true },
      { input: '[1, 2, 3, 4], 6', expectedOutput: '-1', isPublic: true },
      { input: '[1], 1', expectedOutput: '0', isPublic: false }
    ],
    constraints: '1 <= arr.length <= 10^5, -10^9 <= arr[i], target <= 10^9',
    examples: [
      'Input: arr = [1, 3, 5, 7, 9], target = 5 -> Output: 2',
      'Input: arr = [1, 2, 3, 4], target = 6 -> Output: -1'
    ],
    languages: ['javascript', 'python', 'java'],
    tags: ['binary search', 'algorithm'],
    hints: ['Ensure the array is sorted.', 'Use two pointers to narrow the search range.'],
    solution: 'Use two pointers to halve the search space.',
    explanation: 'Binary search halves the search space in each step to find the target.'
  },
  {
    title: 'Complete the Factorial Function',
    description: 'Complete the factorial function that computes n! (n factorial) for a given integer n. The function should return the product of all positive integers up to n. You need to fill in the missing logic in the provided code.',
    type: 'fillInTheBlanksCoding',
    difficulty: 'medium',
    level: 'intermediate',
    points: 12,
    timeLimit: 2,
    memoryLimit: 256,
    starterCode: [
      { language: 'javascript', code: 'function factorial(n) {\n  // ___FILL_IN_THE_BLANK___\n}' },
      { language: 'python', code: 'def factorial(n):\n    # ___FILL_IN_THE_BLANK___\n' },
      { language: 'java', code: 'public class Solution {\n    public long factorial(int n) {\n        // ___FILL_IN_THE_BLANK___\n    }\n}' }
    ],
    testCases: [
      { input: '5', expectedOutput: '120', isPublic: true },
      { input: '0', expectedOutput: '1', isPublic: true },
      { input: '7', expectedOutput: '5040', isPublic: false }
    ],
    constraints: '0 <= n <= 12',
    examples: [
      'Input: n = 5 -> Output: 120 (since 5! = 5 * 4 * 3 * 2 * 1 = 120)',
      'Input: n = 0 -> Output: 1 (by definition, 0! = 1)'
    ],
    languages: ['javascript', 'python', 'java'],
    tags: ['math', 'recursion'],
    hints: ['Consider using recursion or iteration.', 'Handle the base cases for 0 and 1.'],
    solution: 'Use recursion to compute n * factorial(n-1), with base cases n=0 or n=1 returning 1.',
    explanation: 'The factorial of n is computed recursively by multiplying n with the factorial of (n-1). For n=0 or n=1, return 1.'
  }
];

// Utility functions
const randomChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function seedDatabase() {
  try {
    // Connect to MongoDB
    console.log('[Seed] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('[Seed] Connected to MongoDB');

    // Clear existing data
    console.log('[Seed] Clearing existing data...');
    await Promise.all([
      User.deleteMany({}),
      Class.deleteMany({}),
      Question.deleteMany({}),
      Submission.deleteMany({}),
      Leaderboard.deleteMany({}),
      ExamAttempt.deleteMany({}),
      Exam.deleteMany({})
    ]);
    console.log('[Seed] Existing data cleared');

    // Generate Users - At least 500 total
    console.log('[Seed] Generating users...');
    const hashedPassword = await bcrypt.hash('Password123!', SALT_ROUNDS);
    const users = [];

    // Admins (10 admins)
    for (let i = 0; i < 10; i++) {
      users.push({
        name: faker.person.fullName(),
        email: `admin${i + 1}@example.com`,
        number: faker.phone.number(),
        role: 'admin',
        password: hashedPassword,
        canCreateQuestion: true,
        isBlocked: {}
      });
    }

    // Teachers (50 teachers)
    for (let i = 0; i < 50; i++) {
      users.push({
        name: faker.person.fullName(),
        email: `teacher${i + 1}@example.com`,
        number: faker.phone.number(),
        role: 'teacher',
        password: hashedPassword,
        canCreateQuestion: true,
        isBlocked: {}
      });
    }

    // Demo Student
    users.push({
      name: 'Demo Student',
      email: 'demo@example.com',
      number: faker.phone.number(),
      role: 'student',
      password: hashedPassword,
      canCreateQuestion: false,
      isBlocked: {}
    });

    // Students (at least 500 students to ensure 500+ total users)
    for (let i = 0; i < 500; i++) {
      users.push({
        name: faker.person.fullName(),
        email: `student${i + 1}@example.com`,
        number: faker.phone.number(),
        role: 'student',
        password: hashedPassword,
        canCreateQuestion: false,
        isBlocked: {}
      });
    }

    const insertedUsers = await User.insertMany(users);
    console.log(`[Seed] Inserted ${insertedUsers.length} users`);

    const adminUsers = insertedUsers.filter((u) => u.role === 'admin');
    const teacherUsers = insertedUsers.filter((u) => u.role === 'teacher');
    const studentUsers = insertedUsers.filter((u) => u.role === 'student');

    // Generate Classes - At least 500 classes
    console.log('[Seed] Generating classes...');
    const classes = [];
    const student1 = insertedUsers.find((u) => u.email === 'student1@example.com');
    const demoStudent = insertedUsers.find((u) => u.email === 'demo@example.com');
    
    // First, add the predefined classes (including Demo Class)
    for (const classData of CLASS_DATA) {
      const numTeachers = randomInt(1, 3);
      const numStudents = randomInt(15, 30);
      let selectedStudents = faker.helpers.arrayElements(studentUsers, numStudents);
      if (classData.name === 'Demo Class') {
        // Ensure demo@example.com and student1@example.com are included in Demo Class
        const otherStudents = faker.helpers.arrayElements(
          studentUsers.filter((s) => 
            s._id.toString() !== student1?._id.toString() && 
            s._id.toString() !== demoStudent?._id.toString()
          ),
          numStudents - 2
        );
        selectedStudents = [
          ...(demoStudent ? [demoStudent] : []),
          ...(student1 ? [student1] : []),
          ...otherStudents
        ].filter(Boolean);
      }
      classes.push({
        name: classData.name,
        description: classData.description,
        createdBy: randomChoice(teacherUsers)._id,
        teachers: faker.helpers.arrayElements(teacherUsers, numTeachers).map((t) => t._id),
        students: selectedStudents.map((s) => s._id),
        status: 'active',
        questions: [],
        assignments: [],
        totalRuns: 0,
        totalSubmits: 0
      });
    }
    
    // Generate additional classes to reach 500+
    const additionalClassNames = [
      'CS104: Advanced Programming', 'CS204: Data Structures II', 'CS304: Advanced Algorithms',
      'CS105: Software Development', 'CS205: Database Design', 'CS305: Machine Learning',
      'CS106: Mobile Development', 'CS206: Web Development II', 'CS306: Cloud Computing',
      'CS107: Game Development', 'CS207: Network Programming', 'CS307: Distributed Systems',
      'CS108: UI/UX Design', 'CS208: Security Fundamentals', 'CS308: Blockchain Technology',
      'MATH101: Calculus I', 'MATH201: Linear Algebra', 'MATH301: Statistics',
      'PHYS101: Physics I', 'PHYS201: Physics II', 'CHEM101: Chemistry Basics',
      'ENG101: English Composition', 'HIST101: World History', 'ECON101: Economics',
      'BIO101: Biology I', 'BIO201: Biology II', 'PSYCH101: Psychology',
      'CS401: Capstone Project', 'CS402: Research Methods', 'CS403: Thesis',
      'CS501: Graduate Algorithms', 'CS502: Advanced Databases', 'CS503: AI Research'
    ];
    
    const totalClassesNeeded = 500;
    const remainingClasses = totalClassesNeeded - classes.length;
    
    for (let i = 0; i < remainingClasses; i++) {
      const classIndex = i % additionalClassNames.length;
      const baseName = additionalClassNames[classIndex];
      const numTeachers = randomInt(1, 3);
      const numStudents = randomInt(10, 40);
      const selectedStudents = faker.helpers.arrayElements(studentUsers, Math.min(numStudents, studentUsers.length));
      
      classes.push({
        name: `${baseName} - Section ${Math.floor(i / additionalClassNames.length) + 1}`,
        description: faker.lorem.sentence(),
        createdBy: randomChoice(teacherUsers)._id,
        teachers: faker.helpers.arrayElements(teacherUsers, Math.min(numTeachers, teacherUsers.length)).map((t) => t._id),
        students: selectedStudents.map((s) => s._id),
        status: Math.random() > 0.1 ? 'active' : 'inactive',
        questions: [],
        assignments: [],
        totalRuns: 0,
        totalSubmits: 0
      });
    }

    const insertedClasses = await Class.insertMany(classes);
    console.log(`[Seed] Inserted ${insertedClasses.length} classes`);

    // Update isBlocked for students
    console.log('[Seed] Updating isBlocked for students...');
    const userBulkOps = [];
    const demoClassForBlocking = insertedClasses.find((c) => c.name === 'Demo Class');
    for (const cls of insertedClasses) {
      for (const studentId of cls.students) {
        const student = insertedUsers.find((u) => u._id.toString() === studentId.toString());
        // Never block demo@example.com or any students in Demo Class
        const shouldBlock = cls.name !== 'Demo Class' && 
                           student?.email !== 'demo@example.com' && 
                           Math.random() > 0.9;
        userBulkOps.push({
          updateOne: {
            filter: { _id: studentId },
            update: { $set: { [`isBlocked.${cls._id}`]: shouldBlock } }
          }
        });
      }
    }
    if (userBulkOps.length > 0) {
      await User.bulkWrite(userBulkOps);
    }
    console.log('[Seed] isBlocked updated for students');

    // Generate Questions - At least 500 questions
    console.log('[Seed] Generating questions...');
    const questions = [];
    const demoClass = insertedClasses.find((c) => c.name === 'Demo Class');
    
    // First, add the predefined questions
    for (const questionData of QUESTION_DATA) {
      const classIds = faker.helpers.arrayElements(
        insertedClasses.filter((c) => c.name !== 'Demo Class'),
        randomInt(1, 5)
      ).map((c) => c._id);
      
      // Always include Demo Class as the first entry with published and enabled status
      const allClassIds = demoClass ? [demoClass._id, ...classIds] : classIds;
      
      const question = {
        classes: allClassIds.map((classId) => ({
          classId,
          isPublished: classId.toString() === demoClass?._id.toString() ? true : Math.random() > 0.5,
          isDisabled: classId.toString() === demoClass?._id.toString() ? false : Math.random() > 0.8
        })),
        title: questionData.title,
        description: questionData.description,
        difficulty: questionData.difficulty,
        level: questionData.level,
        points: questionData.points,
        createdBy: randomChoice(teacherUsers)._id,
        hints: questionData.hints,
        solution: questionData.solution,
        type: questionData.type,
        timeLimit: questionData.timeLimit,
        memoryLimit: questionData.memoryLimit,
        tags: questionData.tags,
        explanation: questionData.explanation,
        updatedAt: new Date()
      };

      if (questionData.type === 'singleCorrectMcq') {
        question.options = questionData.options;
        question.correctOption = questionData.correctOption;
      } else if (questionData.type === 'multipleCorrectMcq') {
        question.options = questionData.options;
        question.correctOptions = questionData.correctOptions;
      } else if (questionData.type === 'fillInTheBlanks') {
        question.correctAnswer = questionData.correctAnswer;
      } else if (questionData.type === 'coding' || questionData.type === 'fillInTheBlanksCoding' || questionData.type === 'codingWithDriver') {
        question.starterCode = questionData.starterCode;
        question.testCases = questionData.testCases;
        question.constraints = questionData.constraints;
        question.examples = questionData.examples;
        question.languages = questionData.languages;
        if (questionData.type === 'codingWithDriver' && questionData.driverCode) {
          question.driverCode = questionData.driverCode;
        }
        if (questionData.templateCode) {
          question.templateCode = questionData.templateCode;
        }
      }

      questions.push(question);
    }
    
    // Generate additional questions to reach 500+
    const questionTemplates = [
      { type: 'coding', baseTitle: 'Two Sum Problem', difficulty: 'easy', level: 'beginner' },
      { type: 'codingWithDriver', baseTitle: 'Find Max (LeetCode-style)', difficulty: 'easy', level: 'beginner' },
      { type: 'coding', baseTitle: 'Palindrome Check', difficulty: 'easy', level: 'beginner' },
      { type: 'coding', baseTitle: 'Array Rotation', difficulty: 'medium', level: 'intermediate' },
      { type: 'coding', baseTitle: 'Merge Sorted Arrays', difficulty: 'medium', level: 'intermediate' },
      { type: 'coding', baseTitle: 'Binary Tree Traversal', difficulty: 'hard', level: 'advanced' },
      { type: 'coding', baseTitle: 'Graph Shortest Path', difficulty: 'hard', level: 'advanced' },
      { type: 'singleCorrectMcq', baseTitle: 'What is a variable?', difficulty: 'easy', level: 'beginner' },
      { type: 'singleCorrectMcq', baseTitle: 'What is recursion?', difficulty: 'medium', level: 'intermediate' },
      { type: 'multipleCorrectMcq', baseTitle: 'Data types in Python', difficulty: 'easy', level: 'beginner' },
      { type: 'multipleCorrectMcq', baseTitle: 'OOP principles', difficulty: 'medium', level: 'intermediate' },
      { type: 'fillInTheBlanks', baseTitle: 'Complete the loop', difficulty: 'easy', level: 'beginner' },
      { type: 'fillInTheBlanksCoding', baseTitle: 'Complete the function', difficulty: 'medium', level: 'intermediate' }
    ];
    
    const totalQuestionsNeeded = 500;
    const remainingQuestions = totalQuestionsNeeded - questions.length;
    
    for (let i = 0; i < remainingQuestions; i++) {
      const template = questionTemplates[i % questionTemplates.length];
      const questionType = template.type;
      const difficulty = template.difficulty;
      const level = template.level;
      
      // Assign to random classes
      const numClasses = randomInt(1, 8);
      const assignedClasses = faker.helpers.arrayElements(insertedClasses, Math.min(numClasses, insertedClasses.length));
      const allClassIds = demoClass && !assignedClasses.some(c => c._id.toString() === demoClass._id.toString())
        ? [demoClass._id, ...assignedClasses.map(c => c._id)]
        : assignedClasses.map(c => c._id);
      
      const question = {
        classes: allClassIds.map((classId) => ({
          classId,
          isPublished: classId.toString() === demoClass?._id.toString() ? true : Math.random() > 0.3,
          isDisabled: classId.toString() === demoClass?._id.toString() ? false : Math.random() > 0.85
        })),
        title: `${template.baseTitle} - ${i + 1}`,
        description: faker.lorem.paragraph(),
        difficulty: difficulty,
        level: level,
        points: randomInt(5, 25),
        createdBy: randomChoice(teacherUsers)._id,
        hints: [faker.lorem.sentence(), faker.lorem.sentence()],
        solution: faker.lorem.paragraph(),
        type: questionType,
        timeLimit: randomInt(1, 5),
        memoryLimit: randomInt(128, 512),
        tags: faker.helpers.arrayElements(['algorithm', 'data-structures', 'programming', 'coding', 'practice', 'test'], randomInt(1, 4)),
        explanation: faker.lorem.paragraph(),
        updatedAt: faker.date.past()
      };
      
      // Add type-specific fields
      if (questionType === 'singleCorrectMcq') {
        question.options = [
          faker.lorem.sentence(),
          faker.lorem.sentence(),
          faker.lorem.sentence(),
          faker.lorem.sentence()
        ];
        question.correctOption = randomInt(0, 3);
      } else if (questionType === 'multipleCorrectMcq') {
        question.options = [
          faker.lorem.sentence(),
          faker.lorem.sentence(),
          faker.lorem.sentence(),
          faker.lorem.sentence()
        ];
        question.correctOptions = [randomInt(0, 3), randomInt(0, 3)].filter((v, i, a) => a.indexOf(v) === i);
      } else if (questionType === 'fillInTheBlanks') {
        question.correctAnswer = faker.lorem.word();
      } else if (questionType === 'coding' || questionType === 'fillInTheBlanksCoding' || questionType === 'codingWithDriver') {
        const selectedLanguages = faker.helpers.arrayElements(LANGUAGES, randomInt(2, 5));
        question.starterCode = selectedLanguages.map(lang => ({
          language: lang,
          code: `// ${lang} starter code\nfunction solution() {\n  // Your code here\n}`
        }));
        question.testCases = [
          { input: faker.lorem.word(), expectedOutput: faker.lorem.word(), isPublic: true },
          { input: faker.lorem.word(), expectedOutput: faker.lorem.word(), isPublic: true },
          { input: faker.lorem.word(), expectedOutput: faker.lorem.word(), isPublic: false }
        ];
        question.constraints = faker.lorem.sentence();
        question.examples = [faker.lorem.sentence(), faker.lorem.sentence()];
        question.languages = selectedLanguages;
        if (questionType === 'codingWithDriver') {
          question.driverCode = selectedLanguages.map(lang => ({
            language: lang,
            code:
              lang === 'python'
                ? 'import json\n\n# {{USER_CODE}}\n\nif __name__ == "__main__":\n    data = json.loads(input())\n    arr = data["arr"] if isinstance(data, dict) else data\n    result = solution(arr)\n    print(result)'
                : '// {{USER_CODE}}\n\nconst fs = require(\'fs\');\nconst data = JSON.parse(fs.readFileSync(0, \'utf8\').trim());\nconst arr = Array.isArray(data) ? data : data.arr;\nconst result = solution(arr);\nconsole.log(typeof result === \'object\' ? JSON.stringify(result) : result);\n'
          }));
          question.testCases = [
            { input: '{"arr":[1,2,3]}', expectedOutput: '3', isPublic: true },
            { input: '{"arr":[-1,5,0]}', expectedOutput: '5', isPublic: true },
            { input: '{"arr":[10]}', expectedOutput: '10', isPublic: false }
          ];
          question.starterCode = selectedLanguages.map((lang) => ({
            language: lang,
            code:
              lang === 'python'
                ? 'def solution(arr):\n    # Your code here\n    pass'
                : lang === 'javascript'
                  ? 'function solution(arr) {\n  // Your code here\n}'
                  : `// ${lang}\nfunction solution(arr) {\n  // Your code here\n}`
          }));
        }
      }
      
      questions.push(question);
    }

    const insertedQuestions = await Question.insertMany(questions);
    console.log(`[Seed] Inserted ${insertedQuestions.length} questions`);

    // Update Classes with Questions and Assignments
    console.log('[Seed] Updating classes with questions and assignments...');
    const classBulkOps = [];
    const demoClassDoc = insertedClasses.find((c) => c.name === 'Demo Class');
    for (const cls of insertedClasses) {
      const classQuestions = insertedQuestions.filter((q) =>
        q.classes.some((c) => c.classId.toString() === cls._id.toString())
      );
      
      // For Demo Class, add ALL questions as assignments
      // For other classes, add a random subset
      const assignments = cls._id.toString() === demoClassDoc?._id.toString()
        ? classQuestions.map((q) => ({
            questionId: q._id,
            assignedAt: new Date(),
            dueDate: faker.date.future(),
            maxPoints: q.points
          }))
        : classQuestions.slice(0, randomInt(1, classQuestions.length)).map((q) => ({
            questionId: q._id,
            assignedAt: new Date(),
            dueDate: faker.date.future(),
            maxPoints: q.points
          }));

      classBulkOps.push({
        updateOne: {
          filter: { _id: cls._id },
          update: {
            $set: {
              questions: classQuestions.map((q) => q._id),
              assignments
            }
          }
        }
      });
    }
    if (classBulkOps.length > 0) {
      await Class.bulkWrite(classBulkOps);
    }
    console.log('[Seed] Classes updated with questions and assignments');

    // Generate Submissions - At least 500 submissions
    console.log('[Seed] Generating submissions...');
    const submissions = [];
    const targetSubmissionCount = 2000; // Generate more submissions for better testing
    for (let i = 0; i < targetSubmissionCount; i++) {
      const cls = randomChoice(insertedClasses);
      const classQuestions = insertedQuestions.filter((q) =>
        q.classes.some((c) => c.classId.toString() === cls._id.toString())
      );
      if (classQuestions.length === 0) continue;
      const question = randomChoice(classQuestions);
      const student = randomChoice(cls.students);
      const isCorrect = Math.random() > 0.3;
      const isRun = Math.random() > 0.7;
      const isCustomInput = isRun && (question.type === 'coding' || question.type === 'fillInTheBlanksCoding' || question.type === 'codingWithDriver') && Math.random() > 0.8;

      let answer;
      if (question.type === 'singleCorrectMcq') {
        answer = String(isCorrect ? question.correctOption : randomInt(0, question.options.length - 1));
      } else if (question.type === 'multipleCorrectMcq') {
        answer = isCorrect
          ? question.correctOptions.map(String)
          : [String(randomInt(0, question.options.length - 1))];
      } else if (question.type === 'fillInTheBlanks') {
        answer = isCorrect ? question.correctAnswer : faker.lorem.word();
      } else {
        answer = question.starterCode?.find(sc => sc.language === question.languages[0])?.code || faker.lorem.lines(3);
      }

      submissions.push({
        questionId: question._id,
        classId: cls._id,
        studentId: student,
        answer,
        isCorrect,
        isCustomInput,
        score: isCorrect && !isRun && !isCustomInput ? question.points : 0,
        output: isCustomInput ? JSON.stringify([{ input: 'custom input', output: 'simulated output' }]) : (isCorrect ? 'Correct' : 'Incorrect'),
        isRun,
        submittedAt: faker.date.past()
      });
    }

    const insertedSubmissions = await Submission.insertMany(submissions);
    console.log(`[Seed] Inserted ${insertedSubmissions.length} submissions`);

    // Update Class Run/Submit Counts
    console.log('[Seed] Updating class run/submit counts...');
    const classRunSubmitOps = [];
    for (const cls of insertedClasses) {
      const classSubmissions = insertedSubmissions.filter(
        (s) => s.classId.toString() === cls._id.toString()
      );
      const totalRuns = classSubmissions.filter((s) => s.isRun).length;
      const totalSubmits = classSubmissions.filter((s) => !s.isRun).length;

      classRunSubmitOps.push({
        updateOne: {
          filter: { _id: cls._id },
          update: { $set: { totalRuns, totalSubmits } }
        }
      });
    }
    if (classRunSubmitOps.length > 0) {
      await Class.bulkWrite(classRunSubmitOps);
    }
    console.log('[Seed] Class run/submit counts updated');

    // Generate Leaderboard
    console.log('[Seed] Generating leaderboard entries...');
    const leaderboardEntries = [];
    for (const cls of insertedClasses) {
      for (const studentId of cls.students) {
        const studentSubmissions = insertedSubmissions.filter(
          (s) => s.classId.toString() === cls._id.toString() && s.studentId.toString() === studentId.toString()
        );

        if (studentSubmissions.length === 0) continue;

        const attempts = studentSubmissions.map((s) => {
          const question = insertedQuestions.find(
            (q) => q._id.toString() === s.questionId.toString()
          );
          return {
            questionId: s.questionId,
            questionType: question.type, // Use exact question type from questionSchema
            submissionId: s._id,
            isCorrect: s.isCorrect,
            score: s.score,
            output: s.output,
            submittedAt: s.submittedAt,
            isRun: s.isRun
          };
        });

        const entry = new Leaderboard({
          classId: cls._id,
          studentId,
          attempts,
          needsFocus: Math.random() > 0.8
        });

        await entry.save();
        leaderboardEntries.push(entry);
      }
    }
    console.log(`[Seed] Inserted ${leaderboardEntries.length} leaderboard entries`);

    // Generate Exam Templates - At least 50 templates
    console.log('[Seed] Generating exam templates...');
    const templates = [];
    const templateTitles = [
      'Midterm Exam Template', 'Final Exam Template', 'Weekly Quiz Template', 'Practice Test Template',
      'Chapter 1 Quiz Template', 'Chapter 2 Quiz Template', 'Chapter 3 Quiz Template',
      'Assignment 1 Template', 'Assignment 2 Template', 'Assignment 3 Template',
      'Lab Exam Template', 'Project Review Template', 'Comprehensive Test Template',
      'Unit Test Template', 'Module Assessment Template', 'Skill Evaluation Template'
    ];

    // Generate 50 templates
    for (let i = 0; i < 50; i++) {
      const templateTitle = i < templateTitles.length 
        ? templateTitles[i] 
        : `Custom Template ${i + 1}`;
      const templateClass = randomChoice(insertedClasses);
      const templateQuestions = insertedQuestions
        .filter(q => q.classes.some(c => c.classId.toString() === templateClass._id.toString()))
        .slice(0, randomInt(5, 10));
      
      if (templateQuestions.length === 0) continue;

      const sections = [
        {
          sectionId: 'section-1',
          title: 'Section 1: Multiple Choice',
          description: 'Answer all multiple choice questions',
          durationSeconds: 1800, // 30 minutes
          allowRevisit: true,
          order: 0
        },
        {
          sectionId: 'section-2',
          title: 'Section 2: Coding',
          description: 'Solve the coding problems',
          durationSeconds: 3600, // 60 minutes
          allowRevisit: true,
          order: 1
        }
      ];

      const examQuestions = templateQuestions.map((q, idx) => ({
        questionId: q._id,
        points: q.points || 10,
        order: idx,
        sectionId: (q.type === 'coding' || q.type === 'fillInTheBlanksCoding' || q.type === 'codingWithDriver') 
          ? 'section-2' 
          : 'section-1',
        timeLimitSeconds: q.type === 'coding' ? 300 : null // 5 minutes for coding questions
      }));

      templates.push({
        title: templateTitle,
        description: `Template for ${templateTitle.toLowerCase()}`,
        classId: templateClass._id,
        questions: examQuestions,
        sections: sections,
        proctoring: {
          durationMinutes: 90,
          startTime: null,
          endTime: null,
          autoSubmitOnEnd: true,
          tabSwitchLimit: 5,
          copyPasteDisabled: true,
          fullscreenRequired: true,
          internetRequired: true,
          allowRunCode: true
        },
        scoring: {
          immediateScoreRelease: false,
          releaseStatus: 'not_released',
          gradingMode: 'auto'
        },
        template: {
          isTemplate: true,
          templateName: templateTitle,
          templateDescription: `Reusable template for ${templateTitle.toLowerCase()}`,
          baseTemplateId: null
        },
        createdBy: randomChoice(teacherUsers)._id,
        status: 'draft'
      });
    }

    const insertedTemplates = await Exam.insertMany(templates);
    console.log(`[Seed] Inserted ${insertedTemplates.length} exam templates`);

    // Generate Regular Exams - At least 500 exams
    console.log('[Seed] Generating regular exams...');
    const exams = [];
    const examTitles = [
      'Midterm Examination - CS101', 'Final Exam - Data Structures', 'Weekly Quiz - Week 5',
      'Practice Test - Algorithms', 'Assessment Test - JavaScript Basics',
      'Chapter 1 Quiz', 'Chapter 2 Quiz', 'Chapter 3 Quiz', 'Chapter 4 Quiz',
      'Lab Exam 1', 'Lab Exam 2', 'Lab Exam 3', 'Project Review 1', 'Project Review 2',
      'Unit Test 1', 'Unit Test 2', 'Module Assessment', 'Comprehensive Test',
      'Skill Evaluation', 'Progress Test', 'Mock Exam', 'Practice Assessment'
    ];

    const now = new Date();
    
    // Create exams in all statuses - distribute 500 exams across statuses
    const examStatusConfigs = [
      { status: 'draft', count: 125, hasStartTime: false, hasEndTime: false },
      { status: 'scheduled', count: 125, hasStartTime: true, hasEndTime: true, startOffset: 1, endOffset: 2 }, // 1-2 days in future
      { status: 'active', count: 125, hasStartTime: true, hasEndTime: true, startOffset: -0.5, endOffset: 0.5 }, // Started 12h ago, ends in 12h
      { status: 'completed', count: 125, hasStartTime: true, hasEndTime: true, startOffset: -2, endOffset: -1 } // Ended 1-2 days ago
    ];

    let examIndex = 0;
    for (const config of examStatusConfigs) {
      for (let i = 0; i < config.count; i++) {
        const examClass = randomChoice(insertedClasses);
        const classQuestions = insertedQuestions.filter(q =>
          q.classes.some(c => c.classId.toString() === examClass._id.toString())
        );

        if (classQuestions.length === 0) continue;

        // Select questions ensuring all types are represented
        const selectedQuestions = faker.helpers.arrayElements(
          classQuestions,
          Math.min(randomInt(5, 15), classQuestions.length)
        );

        // Create multiple sections for better testing
        const sections = [
          {
            sectionId: 'section-1',
            title: 'Section 1: Multiple Choice & Fill-in-the-blanks',
            description: 'Answer all multiple choice and fill-in-the-blank questions',
            durationSeconds: randomInt(1800, 3600), // 30-60 minutes
            allowRevisit: true,
            order: 0
          },
          {
            sectionId: 'section-2',
            title: 'Section 2: Coding Problems',
            description: 'Solve the coding problems',
            durationSeconds: randomInt(3600, 7200), // 60-120 minutes
            allowRevisit: true,
            order: 1
          }
        ];

        // Distribute questions across sections
        const examQuestions = selectedQuestions.map((q, idx) => {
          const isCoding = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(q.type);
          return {
            questionId: q._id,
            points: q.points || 10,
            order: idx,
            sectionId: isCoding ? 'section-2' : 'section-1',
            timeLimitSeconds: isCoding ? randomInt(180, 600) : null // 3-10 minutes for coding
          };
        });

        // Calculate times based on config
        let startTime = null;
        let endTime = null;
        let durationMinutes = 60;

        if (config.hasStartTime) {
          const startOffsetMs = config.startOffset * 24 * 60 * 60 * 1000; // Convert days to ms
          startTime = new Date(now.getTime() + startOffsetMs);
        }

        if (config.hasEndTime && config.hasStartTime) {
          const endOffsetMs = config.endOffset * 24 * 60 * 60 * 1000;
          endTime = new Date(now.getTime() + endOffsetMs);
          durationMinutes = Math.max(30, Math.floor((endTime.getTime() - startTime.getTime()) / (60 * 1000)));
        } else if (config.hasEndTime) {
          const endOffsetMs = config.endOffset * 24 * 60 * 60 * 1000;
          endTime = new Date(now.getTime() + endOffsetMs);
          durationMinutes = 60; // Default
        } else {
          durationMinutes = randomInt(30, 120); // Default duration for drafts
        }

        exams.push({
          title: examIndex < examTitles.length 
            ? `${examTitles[examIndex % examTitles.length]} - ${examClass.name.substring(0, 20)}` 
            : `${config.status.charAt(0).toUpperCase() + config.status.slice(1)} Exam ${examIndex + 1} - ${examClass.name.substring(0, 20)}`,
          description: `${config.status.charAt(0).toUpperCase() + config.status.slice(1)} examination for ${examClass.name}`,
          classId: examClass._id,
          questions: examQuestions,
          sections: sections,
          proctoring: {
            durationMinutes: durationMinutes,
            startTime: startTime,
            endTime: endTime,
            autoSubmitOnEnd: true,
            tabSwitchLimit: randomInt(3, 10),
            copyPasteDisabled: Math.random() > 0.2,
            fullscreenRequired: Math.random() > 0.3,
            internetRequired: Math.random() > 0.4,
            allowRunCode: Math.random() > 0.3
          },
          scoring: {
            immediateScoreRelease: config.status === 'completed' ? Math.random() > 0.5 : false,
            releaseStatus: config.status === 'completed' && Math.random() > 0.3 ? 'released' : 'not_released',
            gradingMode: randomChoice(['auto', 'manual', 'mixed'])
          },
          template: {
            isTemplate: false,
            baseTemplateId: Math.random() > 0.6 && insertedTemplates.length > 0 ? randomChoice(insertedTemplates)._id : null
          },
          createdBy: randomChoice([...teacherUsers, ...adminUsers])._id,
          status: config.status
        });
        examIndex++;
      }
    }

    const insertedExams = await Exam.insertMany(exams);
    console.log(`[Seed] Inserted ${insertedExams.length} regular exams`);

    // Add specific exam for student1 (6:00 PM to 6:30 PM)
    console.log('[Seed] Creating specific exam for student1...');
    // student1 is already declared earlier in the function, reuse it
    if (student1) {
      // Find Demo Class (student1 is explicitly added to Demo Class)
      const student1Class = insertedClasses.find((c) => c.name === 'Demo Class');
      
      if (student1Class) {
        // Get questions for this class
        const classQuestions = insertedQuestions.filter(q =>
          q.classes.some(c => c.classId.toString() === student1Class._id.toString())
        );
        
        if (classQuestions.length > 0) {
          // Select a mix of questions
          const selectedQuestions = faker.helpers.arrayElements(
            classQuestions,
            Math.min(8, classQuestions.length)
          );
          
          // Create proper sections
          const sections = [
            {
              sectionId: 'section-1',
              title: 'Section 1: Multiple Choice & Fill-in-the-blanks',
              description: 'Answer all multiple choice and fill-in-the-blank questions',
              durationSeconds: 1800, // 30 minutes
              allowRevisit: true,
              order: 0
            },
            {
              sectionId: 'section-2',
              title: 'Section 2: Coding Problems',
              description: 'Solve the coding problems',
              durationSeconds: 1800, // 30 minutes
              allowRevisit: true,
              order: 1
            }
          ];
          
          // Distribute questions across sections
          const examQuestions = selectedQuestions.map((q, idx) => {
            const isCoding = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(q.type);
            return {
              questionId: q._id,
              points: q.points || 10,
              order: idx,
              sectionId: isCoding ? 'section-2' : 'section-1',
              timeLimitSeconds: isCoding ? 300 : null // 5 minutes for coding questions
            };
          });
          
          // Set start time to 6:20 PM today and end time to 6:50 PM (30 minutes duration)
          const now = new Date();
          const startTime = new Date(now);
          startTime.setHours(18, 20, 0, 0); // 6:20 PM
          
          const endTime = new Date(now);
          endTime.setHours(18, 50, 0, 0); // 6:50 PM
          
          // If 6:20 PM has already passed today, set it for tomorrow
          if (startTime < now) {
            startTime.setDate(startTime.getDate() + 1);
            endTime.setDate(endTime.getDate() + 1);
          }
          
          const student1Exam = new Exam({
            title: 'Student1 Special Exam - 6:20 PM to 6:50 PM',
            description: 'A scheduled exam for student1 starting at 6:20 PM and ending at 6:50 PM',
            classId: student1Class._id,
            questions: examQuestions,
            sections: sections,
            proctoring: {
              durationMinutes: 30, // 30 minutes
              startTime: startTime,
              endTime: endTime,
              autoSubmitOnEnd: true,
              tabSwitchLimit: 5,
              copyPasteDisabled: true,
              fullscreenRequired: true,
              internetRequired: true,
              allowRunCode: true
            },
            scoring: {
              immediateScoreRelease: true, // Allow students to see results immediately after submission
              releaseStatus: 'not_released',
              gradingMode: 'auto'
            },
            template: {
              isTemplate: false,
              baseTemplateId: null
            },
            createdBy: randomChoice([...teacherUsers, ...adminUsers])._id,
            status: startTime > now ? 'scheduled' : 'active'
          });
          
          const savedStudent1Exam = await student1Exam.save();
          insertedExams.push(savedStudent1Exam);
          console.log(`[Seed] Created exam for student1: "${savedStudent1Exam.title}"`);
          console.log(`[Seed]   Start Time: ${startTime.toLocaleString()}`);
          console.log(`[Seed]   End Time: ${endTime.toLocaleString()}`);
          console.log(`[Seed]   Status: ${savedStudent1Exam.status}`);
          console.log(`[Seed]   Class: ${student1Class.name}`);
          console.log(`[Seed]   Questions: ${examQuestions.length}`);
        } else {
          console.log('[Seed] Warning: No questions found for student1\'s class, skipping exam creation');
        }
      } else {
        console.log('[Seed] Warning: student1 not found in any class, skipping exam creation');
      }
    } else {
      console.log('[Seed] Warning: student1 not found, skipping exam creation');
    }

    // Generate Exam Attempts - At least 500 attempts
    console.log('[Seed] Generating exam attempts...');
    const examAttempts = [];
    let attemptCount = 0;
    const targetAttempts = 1500; // Generate more attempts for better testing
    
    for (const exam of insertedExams) {
      // Skip draft exams (students can't start them)
      if (exam.status === 'draft') continue;
      
      if (attemptCount >= targetAttempts) break;

      const examClass = insertedClasses.find(c => c._id.toString() === exam.classId.toString());
      if (!examClass || !examClass.students || examClass.students.length === 0) continue;

      // Determine how many students should attempt based on exam status
      let attemptPercentage = 0.3; // Default 30%
      if (exam.status === 'completed') {
        attemptPercentage = 0.7; // 70% for completed exams
      } else if (exam.status === 'active') {
        attemptPercentage = 0.5; // 50% for active exams
      } else if (exam.status === 'scheduled') {
        attemptPercentage = 0.2; // 20% for scheduled (some might start early)
      }

      const maxStudents = Math.max(1, Math.floor(examClass.students.length * attemptPercentage));
      const studentsToAttempt = faker.helpers.arrayElements(
        examClass.students,
        Math.min(maxStudents, examClass.students.length)
      );
      
      // Limit attempts per exam to ensure we get good distribution
      const studentsForThisExam = Math.min(studentsToAttempt.length, Math.floor(targetAttempts / insertedExams.length) + 1);
      const selectedStudents = studentsToAttempt.slice(0, studentsForThisExam);

      for (const studentId of selectedStudents) {
        if (attemptCount >= targetAttempts) break;
        // Determine attempt status based on exam status
        let attemptStatus;
        if (exam.status === 'completed') {
          attemptStatus = randomChoice(['submitted', 'auto_submitted']);
        } else if (exam.status === 'active') {
          attemptStatus = randomChoice(['submitted', 'auto_submitted', 'in_progress', 'terminated']);
        } else if (exam.status === 'scheduled') {
          // For scheduled exams, students might have started early (in_progress) or not started yet
          attemptStatus = Math.random() > 0.7 ? 'in_progress' : 'not_started';
        } else {
          attemptStatus = randomChoice(['submitted', 'auto_submitted', 'in_progress', 'terminated']);
        }

        // Calculate startedAt based on exam and attempt status
        let startedAt;
        if (attemptStatus === 'not_started') {
          startedAt = null;
        } else if (exam.proctoring?.startTime) {
          // Start within reasonable time of exam start
          const startOffset = exam.status === 'scheduled' 
            ? randomInt(-60, 0) * 60 * 1000 // Can start up to 60 min before scheduled start
            : randomInt(0, 30) * 60 * 1000; // Start within 30 min of exam start
          startedAt = new Date(exam.proctoring.startTime.getTime() + startOffset);
        } else {
          startedAt = faker.date.past();
        }

        const endsAt = startedAt 
          ? new Date(startedAt.getTime() + exam.proctoring.durationMinutes * 60 * 1000)
          : null;
        
        const submittedAt = ['submitted', 'auto_submitted', 'terminated'].includes(attemptStatus) && startedAt
          ? new Date(Math.min(endsAt.getTime(), faker.date.between({ from: startedAt, to: endsAt }).getTime()))
          : null;

        // Generate answers for some questions (skip if not_started)
        const answers = [];
        let totalScore = 0;
        let maxScore = 0;

        if (attemptStatus === 'not_started') {
          // No answers for not_started attempts
        } else {
          // Answer questions based on attempt status
          const questionsToAnswer = attemptStatus === 'in_progress'
            ? exam.questions.slice(0, randomInt(1, Math.floor(exam.questions.length * 0.6))) // Partial answers
            : exam.questions.slice(0, randomInt(Math.floor(exam.questions.length * 0.7), exam.questions.length)); // Most/all answers

          for (const examQ of questionsToAnswer) {
          const question = insertedQuestions.find(q => q._id.toString() === examQ.questionId.toString());
          if (!question) continue;

          const isCorrect = Math.random() > 0.3;
          const score = isCorrect ? (examQ.points || question.points || 10) : 0;
          totalScore += score;
          maxScore += (examQ.points || question.points || 10);

          let answer = null;
          if (question.type === 'singleCorrectMcq') {
            answer = isCorrect ? question.correctOption : randomInt(0, question.options.length - 1);
          } else if (question.type === 'multipleCorrectMcq') {
            answer = isCorrect ? question.correctOptions : [randomInt(0, question.options.length - 1)];
          } else if (question.type === 'fillInTheBlanks') {
            answer = isCorrect ? question.correctAnswer : faker.lorem.word();
          } else if (question.type === 'coding' || question.type === 'fillInTheBlanksCoding' || question.type === 'codingWithDriver') {
            answer = question.starterCode?.[0]?.code || '// Code here';
          }

          // Create submission for all question types
          let submissionId = null;
          const submission = new Submission({
            questionId: question._id,
            classId: examClass._id,
            studentId: studentId,
            answer: answer,
            language: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type) 
              ? (question.languages?.[0] || 'javascript') 
              : undefined,
            isCorrect: isCorrect,
            score: score,
            output: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type)
              ? (isCorrect ? 'All test cases passed' : 'Some test cases failed')
              : (isCorrect ? 'Correct' : 'Incorrect'),
            isRun: false,
            examAttemptId: null, // Will be set after attempt is created
            passedTestCases: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type)
              ? (isCorrect ? question.testCases?.length || 0 : randomInt(0, Math.floor((question.testCases?.length || 0) * 0.5)))
              : (isCorrect ? 1 : 0),
            totalTestCases: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type)
              ? (question.testCases?.length || 0)
              : 1
          });
          await submission.save();
          submissionId = submission._id;

          answers.push({
            questionId: question._id,
            submissionId: submissionId,
            answer: answer,
            score: score,
            maxScore: examQ.points || question.points || 10,
            isCorrect: isCorrect,
            language: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type) 
              ? (question.languages?.[0] || 'javascript') 
              : null,
            passedTestCases: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type)
              ? (isCorrect ? question.testCases?.length || 0 : randomInt(0, Math.floor((question.testCases?.length || 0) * 0.5)))
              : (isCorrect ? 1 : 0),
            totalTestCases: ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'].includes(question.type)
              ? (question.testCases?.length || 0)
              : 1
          });
          }
        }

        // Generate violations (only for started attempts)
        const violations = [];
        let tabSwitchCount = 0;
        let copyPasteCount = 0;
        let fullscreenExitCount = 0;
        let networkDropCount = 0;

        if (startedAt && attemptStatus !== 'not_started') {
          tabSwitchCount = Math.random() > 0.7 ? randomInt(1, 4) : 0;
          for (let i = 0; i < tabSwitchCount; i++) {
            violations.push({
              type: 'tab_switch',
              timestamp: new Date(startedAt.getTime() + randomInt(5, Math.max(10, exam.proctoring.durationMinutes * 60 - 5)) * 1000),
              details: { count: i + 1 }
            });
          }

          if (Math.random() > 0.8) {
            copyPasteCount = 1;
            violations.push({
              type: 'copy_paste',
              timestamp: new Date(startedAt.getTime() + randomInt(10, Math.max(15, exam.proctoring.durationMinutes * 60 - 10)) * 1000),
              details: { action: 'copy' }
            });
          }

          if (Math.random() > 0.9) {
            fullscreenExitCount = 1;
            violations.push({
              type: 'fullscreen_exit',
              timestamp: new Date(startedAt.getTime() + randomInt(15, Math.max(20, exam.proctoring.durationMinutes * 60 - 15)) * 1000),
              details: { reason: 'user_action' }
            });
          }

          if (Math.random() > 0.95) {
            networkDropCount = 1;
            violations.push({
              type: 'network_loss',
              timestamp: new Date(startedAt.getTime() + randomInt(20, Math.max(25, exam.proctoring.durationMinutes * 60 - 20)) * 1000),
              details: { duration: randomInt(5, 30) }
            });
          }

          // Add heartbeat violations
          if (startedAt && submittedAt) {
            const heartbeatInterval = 30 * 1000; // 30 seconds
            let currentTime = new Date(startedAt.getTime());
            while (currentTime < submittedAt) {
              violations.push({
                type: 'heartbeat',
                timestamp: new Date(currentTime),
                details: { status: 'active' }
              });
              currentTime = new Date(currentTime.getTime() + heartbeatInterval);
            }
          }
        }

        // Generate timers (only for started attempts)
        const sectionTimers = startedAt ? exam.sections.map(section => ({
          sectionId: section.sectionId,
          remainingSeconds: section.durationSeconds > 0 
            ? (attemptStatus === 'submitted' || attemptStatus === 'auto_submitted' 
                ? 0 
                : randomInt(0, section.durationSeconds))
            : null,
          completed: attemptStatus === 'submitted' || attemptStatus === 'auto_submitted'
        })) : [];

        const questionTimers = startedAt ? exam.questions.map(examQ => {
          const question = insertedQuestions.find(q => q._id.toString() === examQ.questionId.toString());
          return {
            questionId: examQ.questionId,
            remainingSeconds: examQ.timeLimitSeconds 
              ? (attemptStatus === 'submitted' || attemptStatus === 'auto_submitted' 
                  ? 0 
                  : randomInt(0, examQ.timeLimitSeconds))
              : null,
            completed: attemptStatus === 'submitted' || attemptStatus === 'auto_submitted'
          };
        }) : [];

        const attempt = new ExamAttempt({
          examId: exam._id,
          studentId: studentId,
          classId: examClass._id,
          status: attemptStatus,
          startedAt: startedAt,
          endsAt: endsAt,
          submittedAt: submittedAt,
          autoSubmitted: attemptStatus === 'auto_submitted',
          manualSubmitted: attemptStatus === 'submitted',
          currentSectionId: startedAt ? (exam.sections[0]?.sectionId || null) : null,
          currentQuestionId: startedAt ? (exam.questions[0]?.questionId || null) : null,
          sectionTimers: sectionTimers,
          questionTimers: questionTimers,
          violations: violations,
          violationCount: violations.length,
          tabSwitchCount: tabSwitchCount,
          fullscreenExitCount: fullscreenExitCount,
          copyPasteCount: copyPasteCount,
          networkDropCount: networkDropCount,
          lastHeartbeatAt: startedAt 
            ? (submittedAt || new Date(startedAt.getTime() + randomInt(5, Math.max(10, exam.proctoring.durationMinutes * 60 - 5)) * 1000))
            : null,
          answers: answers,
          totalScore: totalScore,
          maxScore: maxScore
        });

        await attempt.save();
        examAttempts.push(attempt);
        attemptCount++;

        // Update all submissions for this attempt with examAttemptId
        const submissionIds = answers.filter(a => a.submissionId).map(a => a.submissionId);
        if (submissionIds.length > 0) {
          await Submission.updateMany(
            { _id: { $in: submissionIds } },
            { $set: { examAttemptId: attempt._id } }
          );
        }
      }
    }

    console.log(`[Seed] Inserted ${examAttempts.length} exam attempts`);

    // Verify Data
    console.log('[Seed] Verifying data...');
    const userCount = await User.countDocuments();
    const classCount = await Class.countDocuments();
    const questionCount = await Question.countDocuments();
    const submissionCount = await Submission.countDocuments();
    const leaderboardCount = await Leaderboard.countDocuments();
    const examCount = await Exam.countDocuments();
    const examAttemptCount = await ExamAttempt.countDocuments();
    const templateCount = await Exam.countDocuments({ 'template.isTemplate': true });
    const regularExamCount = await Exam.countDocuments({ 'template.isTemplate': { $ne: true } });
    
    const sampleStudent = await User.findOne({ role: 'student' }).lean();
    const demoStudentDoc = await User.findOne({ email: 'demo@example.com' }).lean();
    const demoClassFinal = await Class.findOne({ name: 'Demo Class' }).populate('questions').populate('students').lean();
    
    // Exam status breakdown
    const draftExams = await Exam.countDocuments({ status: 'draft', 'template.isTemplate': { $ne: true } });
    const scheduledExams = await Exam.countDocuments({ status: 'scheduled', 'template.isTemplate': { $ne: true } });
    const activeExams = await Exam.countDocuments({ status: 'active', 'template.isTemplate': { $ne: true } });
    const completedExams = await Exam.countDocuments({ status: 'completed', 'template.isTemplate': { $ne: true } });
    
    // Exam attempt status breakdown
    const notStartedAttempts = await ExamAttempt.countDocuments({ status: 'not_started' });
    const inProgressAttempts = await ExamAttempt.countDocuments({ status: 'in_progress' });
    const submittedAttempts = await ExamAttempt.countDocuments({ status: 'submitted' });
    const autoSubmittedAttempts = await ExamAttempt.countDocuments({ status: 'auto_submitted' });
    const terminatedAttempts = await ExamAttempt.countDocuments({ status: 'terminated' });

    console.log(`[Seed] Total users: ${userCount}`);
    console.log(`[Seed] Total classes: ${classCount}`);
    console.log(`[Seed] Total questions: ${questionCount}`);
    console.log(`[Seed] Total submissions: ${submissionCount}`);
    console.log(`[Seed] Total leaderboard entries: ${leaderboardCount}`);
    console.log(`[Seed] Total exams: ${examCount} (${templateCount} templates, ${regularExamCount} regular exams)`);
    console.log(`[Seed]   - Draft exams: ${draftExams}`);
    console.log(`[Seed]   - Scheduled exams: ${scheduledExams}`);
    console.log(`[Seed]   - Active exams: ${activeExams}`);
    console.log(`[Seed]   - Completed exams: ${completedExams}`);
    console.log(`[Seed] Total exam attempts: ${examAttemptCount}`);
    console.log(`[Seed]   - Not started: ${notStartedAttempts}`);
    console.log(`[Seed]   - In progress: ${inProgressAttempts}`);
    console.log(`[Seed]   - Submitted: ${submittedAttempts}`);
    console.log(`[Seed]   - Auto-submitted: ${autoSubmittedAttempts}`);
    console.log(`[Seed]   - Terminated: ${terminatedAttempts}`);
    console.log('[Seed] Sample student isBlocked:', sampleStudent.isBlocked);
    
    // Get test account IDs
    const testAdmin = await User.findOne({ email: 'admin1@example.com' }).lean();
    const testTeacher = await User.findOne({ email: 'teacher1@example.com' }).lean();
    const testStudent = await User.findOne({ email: 'demo@example.com' }).lean();
    const testStudent2 = await User.findOne({ email: 'student1@example.com' }).lean();
    
    console.log('\n[Seed] ===== TEST ACCOUNT CREDENTIALS =====');
    console.log(`[Seed] ADMIN ACCOUNT:`);
    console.log(`[Seed]   Email: admin1@example.com`);
    console.log(`[Seed]   Password: Password123!`);
    console.log(`[Seed]   ID: ${testAdmin?._id}`);
    console.log(`[Seed]`);
    console.log(`[Seed] TEACHER ACCOUNT:`);
    console.log(`[Seed]   Email: teacher1@example.com`);
    console.log(`[Seed]   Password: Password123!`);
    console.log(`[Seed]   ID: ${testTeacher?._id}`);
    console.log(`[Seed]`);
    console.log(`[Seed] STUDENT ACCOUNT 1 (Demo):`);
    console.log(`[Seed]   Email: demo@example.com`);
    console.log(`[Seed]   Password: Password123!`);
    console.log(`[Seed]   ID: ${testStudent?._id}`);
    console.log(`[Seed]`);
    console.log(`[Seed] STUDENT ACCOUNT 2:`);
    console.log(`[Seed]   Email: student1@example.com`);
    console.log(`[Seed]   Password: Password123!`);
    console.log(`[Seed]   ID: ${testStudent2?._id}`);
    console.log(`[Seed]`);
    console.log(`[Seed] ===== DEMO ACCOUNT INFO =====`);
    console.log(`[Seed] Demo Student Email: demo@example.com`);
    console.log(`[Seed] Demo Student Password: Password123!`);
    console.log(`[Seed] Demo Class Name: ${demoClassFinal?.name}`);
    console.log(`[Seed] Demo Class Students: ${demoClassFinal?.students?.length || 0}`);
    console.log(`[Seed] Demo Class Questions: ${demoClassFinal?.questions?.length || 0} (ALL PUBLISHED & ENABLED)`);
    console.log(`[Seed] Demo Class Assignments: ${demoClassFinal?.assignments?.length || 0} (ALL QUESTIONS)`);
    console.log('[Seed] ================================\n');

    console.log('[Seed] Database seeding completed successfully!');
  } catch (error) {
    console.error('[Seed] Error seeding database:', error.message, error.stack);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('[Seed] Disconnected from MongoDB');
  }
}

seedDatabase().catch((err) => {
  console.error('[Seed] Seed process failed:', err.message, err.stack);
  process.exit(1);
});