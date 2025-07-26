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
  canCreateClass: { type: Boolean, default: false },
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
    enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'],
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
  isRun: { type: Boolean, default: false }
});

const attemptSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  questionType: {
    type: String,
    enum: ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'],
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
    if (!['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'].includes(attempt.questionType)) {
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

// Register Models
const User = mongoose.model('User', userSchema);
const Class = mongoose.model('Class', classSchema);
const Question = mongoose.model('Question', questionSchema);
const Submission = mongoose.model('Submission', submissionSchema);
const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);

// MongoDB connection
const MONGO_URI = 'mongodb://localhost:27017/education_platform';
const SALT_ROUNDS = 10;

// Sample data configurations
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const QUESTION_TYPES = ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'];
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
  { name: 'Demo Class', description: 'A demo class with all questions available for student1@example.com to practice.' }
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
    description: 'Write a function to find the maximum element in an array of integers.',
    type: 'coding',
    difficulty: 'medium',
    level: 'intermediate',
    points: 15,
    timeLimit: 3,
    memoryLimit: 256,
    starterCode: [
      { language: 'javascript', code: 'function findMax(arr) {\n  // Your code here\n}' },
      { language: 'python', code: 'def find_max(arr):\n    # Your code here\n' }
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
      Leaderboard.deleteMany({})
    ]);
    console.log('[Seed] Existing data cleared');

    // Generate Users
    console.log('[Seed] Generating users...');
    const hashedPassword = await bcrypt.hash('Password123!', SALT_ROUNDS);
    const users = [];

    // Admins
    for (let i = 0; i < 2; i++) {
      users.push({
        name: faker.person.fullName(),
        email: `admin${i + 1}@example.com`,
        number: faker.phone.number(),
        role: 'admin',
        password: hashedPassword,
        canCreateClass: true,
        isBlocked: {}
      });
    }

    // Teachers
    for (let i = 0; i < 5; i++) {
      users.push({
        name: faker.person.fullName(),
        email: `teacher${i + 1}@example.com`,
        number: faker.phone.number(),
        role: 'teacher',
        password: hashedPassword,
        canCreateClass: true,
        isBlocked: {}
      });
    }

    // Students
    for (let i = 0; i < 50; i++) {
      users.push({
        name: faker.person.fullName(),
        email: `student${i + 1}@example.com`,
        number: faker.phone.number(),
        role: 'student',
        password: hashedPassword,
        canCreateClass: false,
        isBlocked: {}
      });
    }

    const insertedUsers = await User.insertMany(users);
    console.log(`[Seed] Inserted ${insertedUsers.length} users`);

    const adminUsers = insertedUsers.filter((u) => u.role === 'admin');
    const teacherUsers = insertedUsers.filter((u) => u.role === 'teacher');
    const studentUsers = insertedUsers.filter((u) => u.role === 'student');

    // Generate Classes
    console.log('[Seed] Generating classes...');
    const classes = [];
    const student1 = insertedUsers.find((u) => u.email === 'student1@example.com');
    for (const classData of CLASS_DATA) {
      const numTeachers = randomInt(1, 2);
      const numStudents = randomInt(10, 20);
      let selectedStudents = faker.helpers.arrayElements(studentUsers, numStudents);
      if (classData.name === 'Demo Class' && student1) {
        // Ensure student1@example.com is included in Demo Class
        selectedStudents = [student1, ...faker.helpers.arrayElements(
          studentUsers.filter((s) => s._id.toString() !== student1._id.toString()),
          numStudents - 1
        )];
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

    const insertedClasses = await Class.insertMany(classes);
    console.log(`[Seed] Inserted ${insertedClasses.length} classes`);

    // Update isBlocked for students
    console.log('[Seed] Updating isBlocked for students...');
    const userBulkOps = [];
    for (const cls of insertedClasses) {
      for (const studentId of cls.students) {
        userBulkOps.push({
          updateOne: {
            filter: { _id: studentId },
            update: { $set: { [`isBlocked.${cls._id}`]: cls.name !== 'Demo Class' && Math.random() > 0.9 } } // No block for Demo Class
          }
        });
      }
    }
    if (userBulkOps.length > 0) {
      await User.bulkWrite(userBulkOps);
    }
    console.log('[Seed] isBlocked updated for students');

    // Generate Questions
    console.log('[Seed] Generating questions...');
    const questions = [];
    const demoClass = insertedClasses.find((c) => c.name === 'Demo Class');
    for (const questionData of QUESTION_DATA) {
      const classIds = faker.helpers.arrayElements(
        insertedClasses.filter((c) => c.name !== 'Demo Class'),
        randomInt(1, 3)
      ).map((c) => c._id);
      const allClassIds = demoClass ? [...new Set([...classIds, demoClass._id])] : classIds;
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
      } else if (questionData.type === 'coding' || questionData.type === 'fillInTheBlanksCoding') {
        question.starterCode = questionData.starterCode;
        question.testCases = questionData.testCases;
        question.constraints = questionData.constraints;
        question.examples = questionData.examples;
        question.languages = questionData.languages;
      }

      questions.push(question);
    }

    const insertedQuestions = await Question.insertMany(questions);
    console.log(`[Seed] Inserted ${insertedQuestions.length} questions`);

    // Update Classes with Questions and Assignments
    console.log('[Seed] Updating classes with questions and assignments...');
    const classBulkOps = [];
    for (const cls of insertedClasses) {
      const classQuestions = insertedQuestions.filter((q) =>
        q.classes.some((c) => c.classId.toString() === cls._id.toString())
      );
      const assignments = classQuestions.slice(0, randomInt(1, classQuestions.length)).map((q) => ({
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

    // Generate Submissions
    console.log('[Seed] Generating submissions...');
    const submissions = [];
    for (let i = 0; i < 500; i++) {
      const cls = randomChoice(insertedClasses);
      const classQuestions = insertedQuestions.filter((q) =>
        q.classes.some((c) => c.classId.toString() === cls._id.toString())
      );
      if (classQuestions.length === 0) continue;
      const question = randomChoice(classQuestions);
      const student = randomChoice(cls.students);
      const isCorrect = Math.random() > 0.3;
      const isRun = Math.random() > 0.7;
      const isCustomInput = isRun && (question.type === 'coding' || question.type === 'fillInTheBlanksCoding') && Math.random() > 0.8;

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

    // Verify Data
    console.log('[Seed] Verifying data...');
    const userCount = await User.countDocuments();
    const classCount = await Class.countDocuments();
    const questionCount = await Question.countDocuments();
    const submissionCount = await Submission.countDocuments();
    const leaderboardCount = await Leaderboard.countDocuments();
    const sampleStudent = await User.findOne({ role: 'student' }).lean();
    console.log(`[Seed] Total users: ${userCount}`);
    console.log(`[Seed] Total classes: ${classCount}`);
    console.log(`[Seed] Total questions: ${questionCount}`);
    console.log(`[Seed] Total submissions: ${submissionCount}`);
    console.log(`[Seed] Total leaderboard entries: ${leaderboardCount}`);
    console.log('[Seed] Sample student isBlocked:', sampleStudent.isBlocked);

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