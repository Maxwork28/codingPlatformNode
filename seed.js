require('dotenv').config();

const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker');
const bcrypt = require('bcrypt');
const { applyDefaultSolutions } = require('./utils/buildDefaultSolutions');

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
  isDisabled: { type: Boolean, default: false },
  publishedAt: { type: Date }
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
  solutionCode: { type: String },
  solutionLanguage: { type: String },
  solutionCodes: [{
    language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] },
    code: { type: String }
  }],
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
  explanation: { type: String },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published' },
  isDraft: { type: Boolean, default: false },
  publishedAt: { type: Date },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
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
  language: { type: String, enum: ['javascript', 'c', 'cpp', 'java', 'python', 'php', 'ruby', 'go'] },
  status: {
    type: String,
    enum: ['accepted', 'wrong_answer', 'tle', 'mle', 'runtime_error', 'compile_error'],
    default: 'accepted'
  }
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

const CLASS_DATA = [
  {
    key: 'demo',
    name: 'Demo Class',
    description:
      'A demo class with all questions available, published, enabled, and assigned. Login with demo@example.com.',
    status: 'active'
  },
  {
    key: 'dsa',
    name: 'Data Structures - Batch A',
    description: 'Arrays, linked lists, stacks, queues and trees with weekly practice sets.',
    status: 'active'
  },
  {
    key: 'web',
    name: 'Web Development Basics',
    description: 'JavaScript fundamentals, DOM and problem solving for web developers.',
    status: 'active'
  },
  {
    key: 'python',
    name: 'Python Fundamentals (2025)',
    description: 'Last year\'s batch, kept for reference.',
    status: 'inactive'
  }
];

const EXTRA_TEACHERS = [
  { name: 'Priya Sharma', email: 'teacher2@example.com', canCreateQuestion: false },
  { name: 'Rahul Verma', email: 'teacher3@example.com', canCreateQuestion: true }
];

const STUDENT_COUNT = 30;

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
      { language: 'javascript', code: '{{USER_CODE}}\n\nconst fs = require(\'fs\');\nconst data = JSON.parse(fs.readFileSync(0, \'utf8\').trim());\nconst result = findMax(data.arr);\nconsole.log(result);\n' },
      { language: 'python', code: 'import json\n\n{{USER_CODE}}\n\nif __name__ == "__main__":\n    data = json.loads(input())\n    arr = data["arr"]\n    result = find_max(arr)\n    print(result)' }
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

/** Build a Question document from QUESTION_DATA row(s); all questions attach only to Demo Class (published, enabled). */
function buildQuestionDoc(questionData, createdById, demoClassId) {
  const question = {
    classes: [
      {
        classId: demoClassId,
        isPublished: true,
        isDisabled: false
      }
    ],
    title: questionData.title,
    description: questionData.description,
    difficulty: questionData.difficulty,
    level: questionData.level,
    points: questionData.points,
    createdBy: createdById,
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
  } else if (
    questionData.type === 'coding' ||
    questionData.type === 'fillInTheBlanksCoding' ||
    questionData.type === 'codingWithDriver'
  ) {
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
    if (questionData.solutionCodes) {
      question.solutionCodes = questionData.solutionCodes;
    }
    if (questionData.solutionCode) {
      question.solutionCode = questionData.solutionCode;
      question.solutionLanguage = questionData.solutionLanguage;
    }
    if (questionData.correctAnswer) {
      question.correctAnswer = questionData.correctAnswer;
    }
    if (questionData.codeSnippet) {
      question.codeSnippet = questionData.codeSnippet;
    }
  }

  return applyDefaultSolutions(question);
}

/** Pad to 10 per type: use QUESTION_DATA seeds first, then generic placeholders. */
function buildAllQuestions(createdById, demoClassId) {
  const byType = {};
  for (const t of QUESTION_TYPES) {
    byType[t] = [];
  }
  for (const row of QUESTION_DATA) {
    byType[row.type].push(buildQuestionDoc(row, createdById, demoClassId));
  }

  let genIndex = 0;
  for (const type of QUESTION_TYPES) {
    while (byType[type].length < 10) {
      genIndex += 1;
      byType[type].push(generateGenericQuestion(type, genIndex, createdById, demoClassId));
    }
  }

  return QUESTION_TYPES.flatMap((t) => byType[t]);
}

function generateGenericQuestion(type, index, createdById, demoClassId) {
  const base = {
    classes: [{ classId: demoClassId, isPublished: true, isDisabled: false }],
    title: `Sample ${type} #${index}`,
    description: faker.lorem.paragraph(),
    difficulty: randomChoice(DIFFICULTIES),
    level: randomChoice(LEVELS),
    points: randomInt(5, 20),
    createdBy: createdById,
    hints: [faker.lorem.sentence()],
    solution: faker.lorem.sentence(),
    type,
    timeLimit: randomInt(1, 4),
    memoryLimit: 256,
    tags: faker.helpers.arrayElements(['practice', 'demo', 'generic'], randomInt(1, 3)),
    explanation: faker.lorem.sentence(),
    updatedAt: new Date()
  };

  if (type === 'singleCorrectMcq') {
    base.options = [
      faker.lorem.words(3),
      faker.lorem.words(3),
      faker.lorem.words(3),
      faker.lorem.words(3)
    ];
    base.correctOption = randomInt(0, 3);
  } else if (type === 'multipleCorrectMcq') {
    base.options = [
      faker.lorem.words(2),
      faker.lorem.words(2),
      faker.lorem.words(2),
      faker.lorem.words(2)
    ];
    const a = randomInt(0, 3);
    let b = randomInt(0, 3);
    if (b === a) b = (a + 1) % 4;
    base.correctOptions = [a, b].sort((x, y) => x - y);
  } else if (type === 'fillInTheBlanks') {
    base.correctAnswer = faker.lorem.word();
  } else if (type === 'fillInTheBlanksCoding') {
    base.starterCode = [
      { language: 'javascript', code: 'function f(n) {\n  // ___FILL_IN_THE_BLANK___\n}' },
      { language: 'python', code: 'def f(n):\n    # ___FILL_IN_THE_BLANK___\n' }
    ];
    base.testCases = [
      { input: '3', expectedOutput: '6', isPublic: true },
      { input: '0', expectedOutput: '1', isPublic: true },
      { input: '4', expectedOutput: '24', isPublic: false }
    ];
    base.constraints = '0 <= n <= 12';
    base.examples = ['Input: 3 -> Output: 6'];
    base.languages = ['javascript', 'python'];
  } else if (type === 'coding') {
    base.starterCode = [
      { language: 'javascript', code: 'function sum(a, b) {\n  // Your code\n}' },
      { language: 'python', code: 'def sum(a, b):\n    pass\n' }
    ];
    base.testCases = [
      { input: '1 2', expectedOutput: '3', isPublic: true },
      { input: '0 0', expectedOutput: '0', isPublic: true },
      { input: '-1 5', expectedOutput: '4', isPublic: false }
    ];
    base.constraints = 'Integers only';
    base.examples = ['Input: 1 2 -> Output: 3'];
    base.languages = ['javascript', 'python'];
  } else if (type === 'codingWithDriver') {
    base.starterCode = [
      { language: 'javascript', code: 'function sumPair(a, b) {\n  return 0;\n}' },
      { language: 'python', code: 'def sum_pair(a, b):\n    pass' }
    ];
    base.driverCode = [
      {
        language: 'javascript',
        code:
          "{{USER_CODE}}\nconst fs = require('fs');\nconst d = JSON.parse(fs.readFileSync(0, 'utf8').trim());\nconsole.log(sumPair(d.a, d.b));\n"
      },
      {
        language: 'python',
        code:
          'import json\n{{USER_CODE}}\nif __name__ == "__main__":\n    d = json.loads(input())\n    print(sum_pair(d["a"], d["b"]))'
      }
    ];
    base.testCases = [
      { input: '{"a":1,"b":2}', expectedOutput: '3', isPublic: true },
      { input: '{"a":0,"b":0}', expectedOutput: '0', isPublic: true },
      { input: '{"a":-2,"b":7}', expectedOutput: '5', isPublic: false }
    ];
    base.constraints = 'a, b are integers';
    base.examples = ['Input: a=1 b=2 -> Output: 3'];
    base.languages = ['javascript', 'python'];
  }

  return applyDefaultSolutions(base);
}

// Utility functions
const randomChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const HOUR = 60 * 60 * 1000;
const hoursFromNow = (hours) => new Date(Date.now() + hours * HOUR);
const daysAgo = (days) => hoursFromNow(-days * 24);
const CODING_TYPES = new Set(['coding', 'fillInTheBlanksCoding', 'codingWithDriver']);
const idOf = (doc) => String(doc._id || doc);

function buildAnswer(question, isCorrect) {
  if (question.type === 'singleCorrectMcq') {
    return String(isCorrect ? question.correctOption : (question.correctOption + 1) % question.options.length);
  }
  if (question.type === 'multipleCorrectMcq') {
    return isCorrect ? question.correctOptions.map(String) : [String(randomInt(0, question.options.length - 1))];
  }
  if (question.type === 'fillInTheBlanks') {
    return isCorrect ? question.correctAnswer : faker.lorem.word();
  }
  const language = question.languages?.[0] || 'javascript';
  return question.starterCode?.find((sc) => sc.language === language)?.code || faker.lorem.lines(3);
}

function buildSubmission({ question, classId, studentId, isCorrect, isRun, submittedAt }) {
  const coding = CODING_TYPES.has(question.type);
  const total = coding ? question.testCases?.length || 3 : 0;
  const passed = coding ? (isCorrect ? total : randomInt(0, Math.max(0, total - 1))) : 0;
  const isCustomInput = isRun && coding && Math.random() > 0.8;
  let status = 'accepted';
  if (!isCorrect) status = coding ? randomChoice(['wrong_answer', 'wrong_answer', 'runtime_error', 'tle']) : 'wrong_answer';
  return {
    questionId: question._id,
    classId,
    studentId,
    answer: buildAnswer(question, isCorrect),
    language: coding ? question.languages?.[0] || 'javascript' : undefined,
    isCorrect,
    isCustomInput,
    score: isCorrect && !isRun && !isCustomInput ? question.points : 0,
    output: isCustomInput
      ? JSON.stringify([{ input: 'custom input', output: 'simulated output' }])
      : isCorrect ? 'Correct' : 'Incorrect',
    isRun,
    submittedAt,
    passedTestCases: passed,
    totalTestCases: total,
    status
  };
}

/** Activity per student: inactive (no submits), active (1-4 submits), focused (5+ submits). */
function pickProfile(isDemo) {
  if (isDemo) return { name: 'focused', submits: 18, skill: 0.75 };
  const roll = Math.random();
  if (roll < 0.2) return { name: 'inactive', submits: 0, skill: 0 };
  if (roll < 0.65) return { name: 'active', submits: randomInt(1, 4), skill: 0.4 + Math.random() * 0.4 };
  return { name: 'focused', submits: randomInt(5, 14), skill: 0.5 + Math.random() * 0.45 };
}

/** Runs and submits for one student in one class, spread over `spanDays` ending `endDaysAgo` days ago. */
function buildStudentActivity({ classId, studentId, questions, profile, spanDays, endDaysAgo }) {
  const out = [];
  if (!profile.submits || questions.length === 0) return out;
  const picked = faker.helpers.arrayElements(questions, Math.min(profile.submits, questions.length));
  for (const question of picked) {
    let at = daysAgo(endDaysAgo + Math.random() * spanDays);
    if (Math.random() < 0.4) {
      out.push(buildSubmission({ question, classId, studentId, isCorrect: Math.random() < profile.skill, isRun: true, submittedAt: at }));
      at = new Date(at.getTime() + randomInt(2, 15) * 60 * 1000);
    }
    const isCorrect = Math.random() < profile.skill;
    out.push(buildSubmission({ question, classId, studentId, isCorrect, isRun: false, submittedAt: at }));
    if (!isCorrect && Math.random() < 0.5) {
      const retryAt = new Date(at.getTime() + randomInt(5, 90) * 60 * 1000);
      out.push(buildSubmission({ question, classId, studentId, isCorrect: true, isRun: false, submittedAt: retryAt }));
    }
  }
  return out;
}

/** One exam question per type from the class's published questions. */
function pickExamQuestions(classQuestions, sectionId) {
  const pool = [];
  for (const type of QUESTION_TYPES) {
    const match = classQuestions.find((q) => q.type === type);
    if (match) pool.push(match);
  }
  return pool.map((question, index) => ({
    questionId: question._id,
    points: question.points || 10,
    order: index,
    sectionId
  }));
}

function buildExam({ title, description, classId, classQuestions, createdBy, durationMinutes, startTime, endTime, status, scoring, template, proctoring = {} }) {
  const sectionId = 'section-1';
  return {
    title,
    description,
    classId,
    questions: pickExamQuestions(classQuestions, sectionId),
    sections: [{
      sectionId,
      title: 'Main',
      description: 'All question types',
      durationSeconds: durationMinutes * 60,
      allowRevisit: true,
      order: 0
    }],
    proctoring: {
      durationMinutes,
      startTime,
      endTime,
      autoSubmitOnEnd: true,
      tabSwitchLimit: 5,
      copyPasteDisabled: true,
      fullscreenRequired: false,
      internetRequired: true,
      allowRunCode: true,
      ...proctoring
    },
    scoring: { immediateScoreRelease: false, releaseStatus: 'not_released', gradingMode: 'auto', ...scoring },
    template: template || { isTemplate: false },
    createdBy,
    status,
    createdAt: startTime ? new Date(startTime.getTime() - 3 * 24 * HOUR) : daysAgo(5)
  };
}

function buildAttemptAnswers(exam, questionsById, skill, answeredCount) {
  return exam.questions.slice(0, answeredCount).map((eq) => {
    const question = questionsById.get(String(eq.questionId));
    const isCorrect = Math.random() < skill;
    const coding = CODING_TYPES.has(question.type);
    const total = coding ? question.testCases?.length || 3 : 1;
    return {
      questionId: eq.questionId,
      answer: buildAnswer(question, isCorrect),
      language: coding ? question.languages?.[0] || 'javascript' : undefined,
      score: isCorrect ? eq.points : 0,
      maxScore: eq.points,
      isCorrect,
      passedTestCases: isCorrect ? total : randomInt(0, total - 1),
      totalTestCases: total
    };
  });
}

function buildViolations(count, startedAt) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'tab_switch',
    timestamp: new Date(startedAt.getTime() + (i + 1) * randomInt(2, 6) * 60 * 1000),
    details: { reason: 'Window lost focus' }
  }));
}

/** Finished attempts: mostly submitted, some auto-submitted, a few terminated for tab switching. */
function buildFinishedAttempts(exam, studentIds, questionsById) {
  const maxScore = exam.questions.reduce((sum, q) => sum + q.points, 0);
  const start = exam.proctoring.startTime;
  return studentIds.map((studentId, index) => {
    const roll = index === 0 ? 0 : Math.random();
    const status = roll < 0.7 ? 'submitted' : roll < 0.88 ? 'auto_submitted' : 'terminated';
    const startedAt = new Date(start.getTime() + randomInt(0, 15) * 60 * 1000);
    const endsAt = new Date(startedAt.getTime() + exam.proctoring.durationMinutes * 60 * 1000);
    const answered = status === 'terminated' ? randomInt(1, exam.questions.length - 1) : exam.questions.length;
    const answers = buildAttemptAnswers(exam, questionsById, 0.45 + Math.random() * 0.5, answered);
    const tabSwitches = status === 'terminated' ? exam.proctoring.tabSwitchLimit : randomInt(0, 2);
    const submittedAt = status === 'auto_submitted'
      ? endsAt
      : new Date(startedAt.getTime() + randomInt(15, exam.proctoring.durationMinutes - 5) * 60 * 1000);
    return {
      examId: exam._id,
      studentId,
      classId: exam.classId,
      status,
      startedAt,
      endsAt,
      submittedAt,
      autoSubmitted: status === 'auto_submitted',
      manualSubmitted: status === 'submitted',
      currentSectionId: 'section-1',
      violations: buildViolations(tabSwitches, startedAt),
      violationCount: tabSwitches,
      tabSwitchCount: tabSwitches,
      answers,
      totalScore: answers.reduce((sum, a) => sum + a.score, 0),
      maxScore,
      remark: status === 'terminated' ? 'Terminated: tab switch limit reached' : undefined,
      lastHeartbeatAt: submittedAt
    };
  });
}

/** Attempts still running in a live exam. */
function buildLiveAttempts(exam, studentIds, questionsById) {
  const maxScore = exam.questions.reduce((sum, q) => sum + q.points, 0);
  return studentIds.map((studentId) => {
    const startedAt = hoursFromNow(-Math.random() * 0.75);
    const answers = buildAttemptAnswers(exam, questionsById, 0.6, randomInt(1, exam.questions.length - 1));
    return {
      examId: exam._id,
      studentId,
      classId: exam.classId,
      status: 'in_progress',
      startedAt,
      endsAt: new Date(startedAt.getTime() + exam.proctoring.durationMinutes * 60 * 1000),
      currentSectionId: 'section-1',
      currentQuestionId: exam.questions[answers.length]?.questionId,
      answers,
      totalScore: answers.reduce((sum, a) => sum + a.score, 0),
      maxScore,
      tabSwitchCount: randomInt(0, 1),
      lastHeartbeatAt: new Date()
    };
  });
}

async function seedDatabase() {
  try {
    console.log('[Seed] Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('[Seed] Connected to MongoDB');

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

    // ---------------------------------------------------------------- users
    console.log('[Seed] Generating users...');
    const hashedPassword = await bcrypt.hash('Password123!', SALT_ROUNDS);
    const baseUser = { password: hashedPassword, isBlocked: {} };
    const users = [
      { ...baseUser, name: 'Admin One', email: 'admin1@example.com', number: '1000000000', role: 'admin', canCreateQuestion: true },
      { ...baseUser, name: 'Admin Two', email: 'admin2@example.com', number: '1000000003', role: 'admin', canCreateQuestion: true },
      { ...baseUser, name: 'Teacher One', email: 'teacher1@example.com', number: '1000000001', role: 'teacher', canCreateQuestion: true },
      ...EXTRA_TEACHERS.map((t, i) => ({ ...baseUser, ...t, number: `100000001${i}`, role: 'teacher' })),
      { ...baseUser, name: 'Demo Student', email: 'demo@example.com', number: '1000000002', role: 'student', canCreateQuestion: false }
    ];
    for (let i = 1; i < STUDENT_COUNT; i++) {
      users.push({
        ...baseUser,
        name: faker.person.fullName(),
        email: `student${i}@example.com`,
        number: `9${String(100000000 + i * 7919).slice(0, 9)}`,
        role: 'student',
        canCreateQuestion: false
      });
    }
    const insertedUsers = await User.insertMany(users);
    console.log(`[Seed] Inserted ${insertedUsers.length} users`);

    const admin = insertedUsers.find((u) => u.email === 'admin1@example.com');
    const teacher1 = insertedUsers.find((u) => u.email === 'teacher1@example.com');
    const teacher2 = insertedUsers.find((u) => u.email === 'teacher2@example.com');
    const teacher3 = insertedUsers.find((u) => u.email === 'teacher3@example.com');
    const students = insertedUsers.filter((u) => u.role === 'student');
    const demoStudent = students.find((u) => u.email === 'demo@example.com');
    students.sort((a, b) => (a._id.equals(demoStudent._id) ? -1 : b._id.equals(demoStudent._id) ? 1 : 0));
    const studentRange = (from, to) => students.slice(from, to + 1).map((s) => s._id);

    // -------------------------------------------------------------- classes
    console.log('[Seed] Generating classes...');
    const membership = {
      demo: { teachers: [teacher1._id, teacher2._id], students: studentRange(0, 17), createdAt: daysAgo(45) },
      dsa: { teachers: [teacher1._id], students: [demoStudent._id, ...studentRange(10, 21)], createdAt: daysAgo(30) },
      web: { teachers: [teacher3._id], students: [students[5]._id, ...studentRange(18, 29)], createdAt: daysAgo(20) },
      python: { teachers: [teacher2._id], students: studentRange(20, 25), createdAt: daysAgo(320) }
    };
    const insertedClasses = await Class.insertMany(
      CLASS_DATA.map((c) => ({
        name: c.name,
        description: c.description,
        createdBy: admin._id,
        teachers: membership[c.key].teachers,
        students: membership[c.key].students,
        status: c.status,
        questions: [],
        assignments: [],
        createdAt: membership[c.key].createdAt,
        totalRuns: 0,
        totalSubmits: 0
      }))
    );
    const classByKey = Object.fromEntries(CLASS_DATA.map((c, i) => [c.key, insertedClasses[i]]));
    const demoClass = classByKey.demo;
    console.log(`[Seed] Inserted ${insertedClasses.length} classes`);

    // ------------------------------------------------------------ questions
    // Demo Class gets all 60 (10 per type). Other classes share subsets with mixed publish states.
    console.log('[Seed] Generating questions...');
    const classQuestionDocs = buildAllQuestions(teacher1._id, demoClass._id).map((q, index) => {
      const typeIndex = Math.floor(index / 10);
      const slot = index % 10;
      const settings = q.classes.map((c) => ({ ...c, publishedAt: daysAgo(randomInt(10, 40)) }));
      if (slot <= 2) {
        const unpublished = slot === 2 && typeIndex % 2 === 0;
        settings.push({
          classId: classByKey.dsa._id,
          isPublished: !unpublished,
          isDisabled: slot === 2 && typeIndex === 5,
          publishedAt: unpublished ? undefined : daysAgo(randomInt(3, 25))
        });
      }
      if (slot === 3 || slot === 4) {
        const unpublished = slot === 4 && typeIndex === 0;
        settings.push({
          classId: classByKey.web._id,
          isPublished: !unpublished,
          isDisabled: false,
          publishedAt: unpublished ? undefined : daysAgo(randomInt(2, 15))
        });
      }
      if (slot === 5) {
        settings.push({ classId: classByKey.python._id, isPublished: true, isDisabled: false, publishedAt: daysAgo(300) });
      }
      return {
        ...q,
        createdBy: typeIndex % 3 === 2 ? teacher3._id : teacher1._id,
        classes: settings,
        status: 'published',
        isDraft: false,
        publishedAt: daysAgo(40),
        publishedBy: teacher1._id,
        createdAt: daysAgo(randomInt(40, 60))
      };
    });

    // Question bank entries not attached to any class yet
    let genericIndex = 200;
    const bankDocs = QUESTION_TYPES.flatMap((type) => [0, 1].map(() => {
      genericIndex += 1;
      const q = generateGenericQuestion(type, genericIndex, admin._id, demoClass._id);
      return { ...q, classes: [], status: 'published', isDraft: false, publishedAt: daysAgo(randomInt(5, 30)), publishedBy: admin._id };
    }));

    // Unpublished drafts per creator (Drafts pages + navbar badge)
    const draftOwners = [
      [teacher1, 4],
      [teacher3, 2],
      [admin, 3]
    ];
    const draftDocs = draftOwners.flatMap(([owner, count]) => Array.from({ length: count }, (_, i) => {
      genericIndex += 1;
      const type = QUESTION_TYPES[i % QUESTION_TYPES.length];
      const q = generateGenericQuestion(type, genericIndex, owner._id, demoClass._id);
      return {
        ...q,
        title: `Draft: ${faker.hacker.verb()} ${faker.hacker.noun()} (${type})`,
        classes: [],
        status: 'draft',
        isDraft: true,
        createdAt: daysAgo(randomInt(0, 6))
      };
    }));

    const insertedQuestions = await Question.insertMany([...classQuestionDocs, ...bankDocs, ...draftDocs]);
    const questionsById = new Map(insertedQuestions.map((q) => [String(q._id), q]));
    console.log(
      `[Seed] Inserted ${insertedQuestions.length} questions (${classQuestionDocs.length} in classes, ${bankDocs.length} bank, ${draftDocs.length} drafts)`
    );

    const questionsForClass = (cls, { publishedOnly = false } = {}) =>
      insertedQuestions.filter((q) =>
        q.classes.some((c) => idOf(c.classId) === idOf(cls) && (!publishedOnly || (c.isPublished && !c.isDisabled)))
      );

    console.log('[Seed] Linking questions and assignments to classes...');
    for (const cls of insertedClasses) {
      const classQuestions = questionsForClass(cls);
      const published = questionsForClass(cls, { publishedOnly: true });
      await Class.updateOne(
        { _id: cls._id },
        {
          $set: {
            questions: classQuestions.map((q) => q._id),
            assignments: published.map((q, i) => ({
              questionId: q._id,
              assignedAt: daysAgo(randomInt(5, 30)),
              dueDate: i % 3 === 0 ? daysAgo(randomInt(1, 4)) : hoursFromNow(randomInt(24, 24 * 14)),
              maxPoints: q.points
            }))
          }
        }
      );
    }

    // ---------------------------------------------------- practice activity
    console.log('[Seed] Generating practice submissions...');
    const submissionDocs = [];
    const profiles = new Map();
    for (const cls of insertedClasses) {
      const classKey = CLASS_DATA[insertedClasses.indexOf(cls)].key;
      const published = questionsForClass(cls, { publishedOnly: true });
      const archived = cls.status === 'inactive';
      for (const studentId of cls.students) {
        const isDemo = studentId.equals(demoStudent._id);
        const profile = pickProfile(isDemo && classKey === 'demo');
        profiles.set(`${idOf(cls)}:${idOf(studentId)}`, profile);
        submissionDocs.push(...buildStudentActivity({
          classId: cls._id,
          studentId,
          questions: published,
          profile,
          spanDays: archived ? 60 : 21,
          endDaysAgo: archived ? 240 : 0
        }));
      }
    }
    const insertedSubmissions = await Submission.insertMany(submissionDocs);
    console.log(`[Seed] Inserted ${insertedSubmissions.length} submissions`);

    await Class.bulkWrite(insertedClasses.map((cls) => {
      const classSubs = insertedSubmissions.filter((s) => idOf(s.classId) === idOf(cls));
      return {
        updateOne: {
          filter: { _id: cls._id },
          update: { $set: { totalRuns: classSubs.filter((s) => s.isRun).length, totalSubmits: classSubs.filter((s) => !s.isRun).length } }
        }
      };
    }));

    // Block a couple of inactive students so the blocked state shows up in class views
    console.log('[Seed] Blocking inactive students...');
    let blockedCount = 0;
    for (const [classKey, limit] of [['demo', 2], ['dsa', 1]]) {
      const cls = classByKey[classKey];
      const inactive = cls.students.filter((sid) =>
        !sid.equals(demoStudent._id) && profiles.get(`${idOf(cls)}:${idOf(sid)}`)?.name === 'inactive'
      ).slice(0, limit);
      for (const sid of inactive) {
        await User.updateOne({ _id: sid }, { $set: { [`isBlocked.${idOf(cls)}`]: true } });
        blockedCount += 1;
      }
    }
    console.log(`[Seed] Blocked ${blockedCount} students`);

    console.log('[Seed] Generating leaderboard entries...');
    let leaderboardCount = 0;
    for (const cls of insertedClasses) {
      for (const studentId of cls.students) {
        const attempts = insertedSubmissions
          .filter((s) => idOf(s.classId) === idOf(cls) && s.studentId.equals(studentId))
          .sort((a, b) => a.submittedAt - b.submittedAt)
          .map((s) => ({
            questionId: s.questionId,
            questionType: questionsById.get(idOf(s.questionId)).type,
            submissionId: s._id,
            isCorrect: s.isCorrect,
            score: s.score,
            output: s.output,
            submittedAt: s.submittedAt,
            isRun: s.isRun
          }));
        const wrong = attempts.filter((a) => !a.isRun && !a.isCorrect).length;
        const submits = attempts.filter((a) => !a.isRun).length;
        await new Leaderboard({
          classId: cls._id,
          studentId,
          attempts,
          needsFocus: submits > 0 && wrong / submits > 0.5
        }).save();
        leaderboardCount += 1;
      }
    }
    console.log(`[Seed] Inserted ${leaderboardCount} leaderboard entries`);

    // ---------------------------------------------------------------- exams
    console.log('[Seed] Generating exams, templates and attempts...');
    const pub = (key) => questionsForClass(classByKey[key], { publishedOnly: true });
    const examDocs = [
      buildExam({
        title: 'DSA Practice Template',
        description: 'Reusable template covering every question type.',
        classId: demoClass._id,
        classQuestions: pub('demo'),
        createdBy: admin._id,
        durationMinutes: 60,
        status: 'draft',
        proctoring: { fullscreenRequired: true },
        template: { isTemplate: true, templateName: 'DSA Practice Template', templateDescription: 'One question of each type.' }
      }),
      buildExam({
        title: 'Quick Weekly Quiz Template',
        description: 'Short 30 minute quiz for any class.',
        classId: classByKey.dsa._id,
        classQuestions: pub('dsa'),
        createdBy: admin._id,
        durationMinutes: 30,
        status: 'draft',
        template: { isTemplate: true, templateName: 'Quick Weekly Quiz Template', templateDescription: '30 minutes, auto graded.' }
      }),
      buildExam({
        title: 'Draft Class Quiz',
        description: 'Not published yet.',
        classId: demoClass._id,
        classQuestions: pub('demo'),
        createdBy: teacher1._id,
        durationMinutes: 45,
        status: 'draft'
      }),
      buildExam({
        title: 'Scheduled Weekly Test',
        description: 'Starts tomorrow.',
        classId: demoClass._id,
        classQuestions: pub('demo'),
        createdBy: teacher1._id,
        durationMinutes: 60,
        startTime: hoursFromNow(24),
        endTime: hoursFromNow(26),
        status: 'scheduled',
        scoring: { immediateScoreRelease: true }
      }),
      buildExam({
        title: 'Live Class Test',
        description: 'Open now for the demo student.',
        classId: demoClass._id,
        classQuestions: pub('demo'),
        createdBy: teacher1._id,
        durationMinutes: 90,
        startTime: hoursFromNow(-1),
        endTime: hoursFromNow(6),
        status: 'active',
        scoring: { immediateScoreRelease: true }
      }),
      buildExam({
        title: 'Past Week Test',
        description: 'Finished exam with released scores.',
        classId: demoClass._id,
        classQuestions: pub('demo'),
        createdBy: teacher1._id,
        durationMinutes: 60,
        startTime: hoursFromNow(-48),
        endTime: hoursFromNow(-46),
        status: 'completed',
        scoring: { immediateScoreRelease: true, releaseStatus: 'released' }
      }),
      buildExam({
        title: 'DSA Mid-term Assessment',
        description: 'Completed. Scores are waiting to be released.',
        classId: classByKey.dsa._id,
        classQuestions: pub('dsa'),
        createdBy: teacher1._id,
        durationMinutes: 90,
        startTime: hoursFromNow(-24 * 4),
        endTime: hoursFromNow(-24 * 4 + 3),
        status: 'completed'
      }),
      buildExam({
        title: 'DSA Weekly Quiz 3',
        description: 'Live now.',
        classId: classByKey.dsa._id,
        classQuestions: pub('dsa'),
        createdBy: teacher1._id,
        durationMinutes: 45,
        startTime: hoursFromNow(-0.5),
        endTime: hoursFromNow(5),
        status: 'active',
        scoring: { immediateScoreRelease: true }
      }),
      buildExam({
        title: 'JS Basics Test',
        description: 'Scheduled for later this week.',
        classId: classByKey.web._id,
        classQuestions: pub('web'),
        createdBy: teacher3._id,
        durationMinutes: 60,
        startTime: hoursFromNow(24 * 3),
        endTime: hoursFromNow(24 * 3 + 2),
        status: 'scheduled'
      }),
      buildExam({
        title: 'Web Dev Unit Test 1',
        description: 'Finished with released scores.',
        classId: classByKey.web._id,
        classQuestions: pub('web'),
        createdBy: teacher3._id,
        durationMinutes: 60,
        startTime: hoursFromNow(-24 * 7),
        endTime: hoursFromNow(-24 * 7 + 2),
        status: 'completed',
        scoring: { immediateScoreRelease: false, releaseStatus: 'released' }
      }),
      buildExam({
        title: 'Python Final Exam',
        description: 'Last year\'s final.',
        classId: classByKey.python._id,
        classQuestions: pub('python'),
        createdBy: teacher2._id,
        durationMinutes: 120,
        startTime: daysAgo(250),
        endTime: new Date(daysAgo(250).getTime() + 3 * HOUR),
        status: 'completed',
        scoring: { releaseStatus: 'released' }
      })
    ];
    const insertedExams = await Exam.insertMany(examDocs);
    const examByTitle = Object.fromEntries(insertedExams.map((e) => [e.title, e]));

    const others = (key, count, { includeDemo = false } = {}) => {
      const pool = classByKey[key].students.filter((sid) => !sid.equals(demoStudent._id));
      const picked = faker.helpers.arrayElements(pool, Math.min(count, pool.length));
      return includeDemo ? [demoStudent._id, ...picked] : picked;
    };

    const attemptDocs = [
      ...buildFinishedAttempts(examByTitle['Past Week Test'], others('demo', 13, { includeDemo: true }), questionsById),
      ...buildLiveAttempts(examByTitle['Live Class Test'], others('demo', 4), questionsById),
      ...buildFinishedAttempts(examByTitle['DSA Mid-term Assessment'], others('dsa', 10, { includeDemo: true }), questionsById),
      ...buildLiveAttempts(examByTitle['DSA Weekly Quiz 3'], others('dsa', 5), questionsById),
      ...buildFinishedAttempts(examByTitle['Web Dev Unit Test 1'], others('web', 11), questionsById),
      ...buildFinishedAttempts(examByTitle['Python Final Exam'], others('python', 6), questionsById)
    ];
    await ExamAttempt.insertMany(attemptDocs);
    const templateTotal = insertedExams.filter((e) => e.template?.isTemplate).length;
    console.log(`[Seed] Inserted ${insertedExams.length} exams (${templateTotal} templates) and ${attemptDocs.length} attempts`);

    // --------------------------------------------------------------- summary
    const counts = {
      users: await User.countDocuments(),
      classes: await Class.countDocuments(),
      questions: await Question.countDocuments(),
      drafts: await Question.countDocuments({ isDraft: true }),
      submissions: await Submission.countDocuments(),
      leaderboard: await Leaderboard.countDocuments(),
      exams: await Exam.countDocuments(),
      attempts: await ExamAttempt.countDocuments()
    };
    console.log('[Seed] Totals:', counts);

    console.log('\n[Seed] ===== ACCOUNTS (password for all: Password123!) =====');
    console.log('[Seed] Admins:   admin1@example.com, admin2@example.com');
    console.log('[Seed] Teachers: teacher1@example.com (can create questions), teacher2@example.com (cannot), teacher3@example.com');
    console.log(`[Seed] Students: demo@example.com, student1..student${STUDENT_COUNT - 1}@example.com`);
    console.log('[Seed] Classes:');
    for (const cls of insertedClasses) {
      console.log(`[Seed]   ${cls.name} (${cls.status}): ${cls.students.length} students, ${questionsForClass(cls).length} questions`);
    }
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
