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

// Minimal seed: single demo class only
const CLASS_DATA = [
  {
    name: 'Demo Class',
    description:
      'A demo class with all questions available, published, enabled, and assigned. Login with demo@example.com.'
  }
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
  }

  return question;
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
          "// {{USER_CODE}}\nconst fs = require('fs');\nconst d = JSON.parse(fs.readFileSync(0, 'utf8').trim());\nconsole.log(sumPair(d.a, d.b));\n"
      },
      {
        language: 'python',
        code:
          'import json\n# {{USER_CODE}}\nif __name__ == "__main__":\n    d = json.loads(input())\n    print(sum_pair(d["a"], d["b"]))'
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

  return base;
}

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

    // Minimal users: 1 admin, 1 teacher, 1 student (demo)
    console.log('[Seed] Generating users (minimal)...');
    const hashedPassword = await bcrypt.hash('Password123!', SALT_ROUNDS);
    const users = [
      {
        name: 'Admin One',
        email: 'admin1@example.com',
        number: '1000000000',
        role: 'admin',
        password: hashedPassword,
        canCreateQuestion: true,
        isBlocked: {}
      },
      {
        name: 'Teacher One',
        email: 'teacher1@example.com',
        number: '1000000001',
        role: 'teacher',
        password: hashedPassword,
        canCreateQuestion: true,
        isBlocked: {}
      },
      {
        name: 'Demo Student',
        email: 'demo@example.com',
        number: '1000000002',
        role: 'student',
        password: hashedPassword,
        canCreateQuestion: false,
        isBlocked: {}
      }
    ];

    const insertedUsers = await User.insertMany(users);
    console.log(`[Seed] Inserted ${insertedUsers.length} users`);

    const teacher = insertedUsers.find((u) => u.role === 'teacher');
    const demoStudent = insertedUsers.find((u) => u.email === 'demo@example.com');

    console.log('[Seed] Generating Demo Class...');
    const classData = CLASS_DATA[0];
    const insertedClasses = await Class.insertMany([
      {
        name: classData.name,
        description: classData.description,
        createdBy: teacher._id,
        teachers: [teacher._id],
        students: [demoStudent._id],
        status: 'active',
        questions: [],
        assignments: [],
        totalRuns: 0,
        totalSubmits: 0
      }
    ]);
    console.log(`[Seed] Inserted ${insertedClasses.length} class(es)`);

    // 10 questions per type (6 types) = 60 total; QUESTION_DATA seeds + generics
    console.log('[Seed] Generating questions (10 per type = 60 total)...');
    const demoClass = insertedClasses.find((c) => c.name === 'Demo Class');
    const questions = buildAllQuestions(teacher._id, demoClass._id);
    const insertedQuestions = await Question.insertMany(questions);
    console.log(`[Seed] Inserted ${insertedQuestions.length} questions`);

    console.log('[Seed] Updating Demo Class with questions and assignments...');
    const classQuestions = insertedQuestions;
    const assignments = classQuestions.map((q) => ({
      questionId: q._id,
      assignedAt: new Date(),
      dueDate: faker.date.future(),
      maxPoints: q.points
    }));
    await Class.updateOne(
      { _id: demoClass._id },
      { $set: { questions: classQuestions.map((q) => q._id), assignments } }
    );
    console.log('[Seed] Demo Class updated with questions and assignments');

    // Minimal submissions for leaderboard smoke test
    console.log('[Seed] Generating submissions (minimal)...');
    const submissions = [];
    const targetSubmissionCount = 20;
    const demoClassId = demoClass._id;
    for (let i = 0; i < targetSubmissionCount; i++) {
      const cls = insertedClasses.find((c) => c._id.toString() === demoClassId.toString()) || randomChoice(insertedClasses);
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

    // No bulk exams/attempts in minimal seed
    console.log('[Seed] Skipping exam templates and bulk exams (minimal seed)');

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
    
    const demoClassFinal = await Class.findOne({ name: 'Demo Class' }).populate('questions').populate('students').lean();
    const questionsByType = await Question.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    console.log(`[Seed] Total users: ${userCount}`);
    console.log(`[Seed] Total classes: ${classCount}`);
    console.log(`[Seed] Total questions: ${questionCount}`);
    console.log(`[Seed] Questions by type:`, questionsByType.map((r) => `${r._id}=${r.count}`).join(', '));
    console.log(`[Seed] Total submissions: ${submissionCount}`);
    console.log(`[Seed] Total leaderboard entries: ${leaderboardCount}`);
    console.log(`[Seed] Total exams: ${examCount} (${templateCount} templates, ${regularExamCount} regular exams)`);
    console.log(`[Seed] Total exam attempts: ${examAttemptCount}`);

    const testAdmin = await User.findOne({ email: 'admin1@example.com' }).lean();
    const testTeacher = await User.findOne({ email: 'teacher1@example.com' }).lean();
    const testStudent = await User.findOne({ email: 'demo@example.com' }).lean();

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
    console.log(`[Seed] STUDENT (Demo — only student user):`);
    console.log(`[Seed]   Email: demo@example.com`);
    console.log(`[Seed]   Password: Password123!`);
    console.log(`[Seed]   ID: ${testStudent?._id}`);
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