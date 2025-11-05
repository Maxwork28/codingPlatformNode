# Teacher Question Testing API Documentation

## Overview

Teachers have dedicated endpoints to test coding questions without affecting student leaderboards, submissions, or class statistics. These endpoints allow teachers to:
- Run code against **ALL test cases** (public + hidden)
- Test with custom inputs **without format validation**
- Get detailed execution results
- Preview questions from a student's perspective

---

## Key Differences from Student Submission Flow

| Feature | Student Flow | Teacher Flow |
|---------|-------------|--------------|
| **Endpoint** | `/questions/:questionId/submit` | `/questions/:questionId/teacher-test` |
| **Test Cases** | Public only (for run) or All (for submit) | **ALL test cases visible** |
| **Database Save** | ✅ Creates Submission record | ❌ **No database save** |
| **Leaderboard** | ✅ Updates leaderboard | ❌ **No leaderboard impact** |
| **Class Stats** | ✅ Updates totalRuns/totalSubmits | ❌ **No stats update** |
| **Socket.IO** | ✅ Emits real-time events | ❌ **No emissions** |
| **Max Attempts** | ✅ Enforced | ❌ **No limit** |
| **Block Check** | ✅ Checks if student blocked | ❌ **No block check** |
| **Input Validation** | ✅ Strict array format | ❌ **No format restriction** |
| **Authorization** | Student only | **Teacher/Admin only** |

---

## API Endpoints

### 1. Test Question with All Test Cases

**Endpoint:** `POST /questions/:questionId/teacher-test`

**Authorization:** Teacher or Admin only

**Request Body:**
```json
{
  "answer": "function twoSum(nums, target) { return [0, 1]; }",
  "classId": "65abc123...",
  "language": "javascript"
}
```

**Response (Success - 200):**
```json
{
  "message": "Code tested successfully (teacher mode - no submission saved)",
  "testResults": [
    {
      "input": "[2, 7, 11, 15]\\n9",
      "output": "[0, 1]",
      "expected": "[0, 1]",
      "passed": true,
      "isPublic": true,
      "error": null
    },
    {
      "input": "[3, 2, 4]\\n6",
      "output": "[1, 2]",
      "expected": "[1, 2]",
      "passed": true,
      "isPublic": false
    }
  ],
  "passedTestCases": 2,
  "totalTestCases": 2,
  "publicTestCases": 1,
  "hiddenTestCases": 1,
  "isCorrect": true,
  "explanation": "Use a hash map to find complement values",
  "teacherMode": true
}
```

**Features:**
- ✅ Shows **ALL test cases** (both public and hidden)
- ✅ Each test result includes `isPublic` flag
- ✅ No database save
- ✅ No leaderboard update
- ✅ Detailed error messages per test case

---

### 2. Test Question with Custom Input

**Endpoint:** `POST /questions/:questionId/teacher-test-custom`

**Authorization:** Teacher or Admin only

**Request Body:**
```json
{
  "answer": "function twoSum(nums, target) { return [0, 1]; }",
  "classId": "65abc123...",
  "language": "javascript",
  "customInput": "[10, 20, 30, 40]\\n50",
  "expectedOutput": "[0, 3]"
}
```

**Response (Success - 200):**
```json
{
  "message": "Code tested with custom input successfully (teacher mode)",
  "testResult": {
    "input": "[10, 20, 30, 40]\\n50",
    "output": "[0, 3]",
    "expected": "[0, 3]",
    "passed": true,
    "isPublic": true,
    "error": null
  },
  "customInput": "[10, 20, 30, 40]\\n50",
  "expectedOutput": "[0, 3]",
  "actualOutput": "[0, 3]",
  "passed": true,
  "error": null,
  "explanation": "Use a hash map to find complement values",
  "teacherMode": true
}
```

**Features:**
- ✅ **No format validation** on custom input
- ✅ Teachers can input **any string** (not limited to array format)
- ✅ `expectedOutput` is **optional**
- ✅ `passed` is `null` if no expected output provided
- ✅ Useful for testing edge cases
- ✅ No database save

---

## Backend Implementation

### Controller: `questionController.js`

#### teacherTestQuestion
```javascript
exports.teacherTestQuestion = async (req, res) => {
    // 1. Authorization: Only teachers/admins
    if (!['teacher', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: 'Only teachers and admins can test questions' });
    }

    // 2. Get question
    const question = await Question.findById(questionId);

    // 3. Validate language
    if (!language || !question.languages.includes(language)) {
        return res.status(400).json({ error: 'Invalid language' });
    }

    // 4. Execute with ALL test cases
    const testResults = await executeDockerCode(
        language,
        codeToExecute,
        question.testCases, // ALL test cases (public + hidden)
        question.timeLimit,
        question.memoryLimit
    );

    // 5. Calculate results
    const passedTestCases = testResults.filter(test => test.passed).length;
    const publicTestCases = testResults.filter(test => test.isPublic).length;
    const hiddenTestCases = testResults.filter(test => !test.isPublic).length;

    // 6. Return results (NO DATABASE SAVE)
    res.status(200).json({
        testResults,      // All test results
        passedTestCases,
        totalTestCases,
        publicTestCases,
        hiddenTestCases,
        isCorrect,
        teacherMode: true
    });
};
```

#### teacherTestWithCustomInput
```javascript
exports.teacherTestWithCustomInput = async (req, res) => {
    // 1. Authorization: Only teachers/admins
    if (!['teacher', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: 'Only teachers and admins can test questions' });
    }

    // 2. Validate custom input exists (NO FORMAT VALIDATION)
    if (!customInput || typeof customInput !== 'string' || !customInput.trim()) {
        return res.status(400).json({ error: 'Valid custom input is required' });
    }

    // 3. Create custom test case
    const customTestCase = [{
        input: customInput.trim(),
        expectedOutput: expectedOutput ? expectedOutput.trim() : '',
        isPublic: true
    }];

    // 4. Execute with custom input
    const testResults = await executeDockerCode(
        language,
        codeToExecute,
        customTestCase,
        question.timeLimit,
        question.memoryLimit
    );

    // 5. Return result (NO DATABASE SAVE)
    res.status(200).json({
        testResult: testResults[0],
        customInput: customInput.trim(),
        expectedOutput: expectedOutput || null,
        actualOutput: testResults[0].output,
        passed: expectedOutput ? testResults[0].passed : null,
        teacherMode: true
    });
};
```

---

## Frontend Implementation

### API Service: `src/common/services/api.js`

#### teacherTestQuestion
```javascript
export const teacherTestQuestion = async (questionId, answer, classId, language) => {
  console.log('teacherTestQuestion called', { questionId, classId, language });
  try {
    const response = await api.post(`/questions/${questionId}/teacher-test`, {
      answer,
      classId,
      language
    });
    console.log('teacherTestQuestion success', { 
      testResults: response.data.testResults,
      passedTestCases: response.data.passedTestCases,
      totalTestCases: response.data.totalTestCases,
      publicTestCases: response.data.publicTestCases,
      hiddenTestCases: response.data.hiddenTestCases
    });
    return response;
  } catch (err) {
    console.error('teacherTestQuestion error', { error: err.response?.data?.error });
    throw err.response?.data?.error || 'Failed to test question';
  }
};
```

#### teacherTestWithCustomInput
```javascript
export const teacherTestWithCustomInput = async (
  questionId, 
  answer, 
  classId, 
  language, 
  customInput, 
  expectedOutput
) => {
  console.log('teacherTestWithCustomInput called', { 
    questionId, 
    classId, 
    language, 
    customInput, 
    expectedOutput 
  });
  try {
    const response = await api.post(`/questions/${questionId}/teacher-test-custom`, {
      answer,
      classId,
      language,
      customInput,
      expectedOutput
    });
    console.log('teacherTestWithCustomInput success', { 
      testResult: response.data.testResult,
      actualOutput: response.data.actualOutput,
      passed: response.data.passed
    });
    return response;
  } catch (err) {
    console.error('teacherTestWithCustomInput error', { 
      error: err.response?.data?.error 
    });
    throw err.response?.data?.error || 'Failed to test with custom input';
  }
};
```

---

## Usage in TakeClass Component

### Example: Run Code Button
```javascript
const handleRunCode = async () => {
  try {
    setLoading(true);
    
    const response = await teacherTestQuestion(
      selectedQuestion._id,
      code,
      selectedClass._id,
      selectedLanguage
    );

    // Display results with ALL test cases visible
    setTestResults({
      message: response.data.message,
      testResults: response.data.testResults,
      passedTestCases: response.data.passedTestCases,
      totalTestCases: response.data.totalTestCases,
      publicTestCases: response.data.publicTestCases,
      hiddenTestCases: response.data.hiddenTestCases,
      isCorrect: response.data.isCorrect,
      explanation: response.data.explanation
    });

  } catch (err) {
    console.error('Failed to run code:', err);
    setTestResults({
      error: true,
      message: typeof err === 'string' ? err : 'Failed to execute code'
    });
  } finally {
    setLoading(false);
  }
};
```

### Example: Run with Custom Input Button
```javascript
const handleRunWithCustomInput = async () => {
  try {
    setLoading(true);
    
    const response = await teacherTestWithCustomInput(
      selectedQuestion._id,
      code,
      selectedClass._id,
      selectedLanguage,
      customInput,
      customOutput
    );

    // Display custom test result
    setTestResults({
      message: response.data.message,
      testResult: response.data.testResult,
      customInput: response.data.customInput,
      expectedOutput: response.data.expectedOutput,
      actualOutput: response.data.actualOutput,
      passed: response.data.passed,
      isCustomTest: true,
      explanation: response.data.explanation
    });

  } catch (err) {
    console.error('Failed to run with custom input:', err);
    setTestResults({
      error: true,
      message: typeof err === 'string' ? err : 'Failed to execute code'
    });
  } finally {
    setLoading(false);
  }
};
```

---

## Validations

### Backend Validations

#### teacherTestQuestion
- ✅ User must be teacher or admin
- ✅ Question must exist
- ✅ Must be a coding question (`coding` or `fillInTheBlanksCoding`)
- ✅ Language must be supported by the question
- ❌ No block check
- ❌ No max attempts check
- ❌ No class enrollment check

#### teacherTestWithCustomInput
- ✅ User must be teacher or admin
- ✅ Question must exist
- ✅ Must be a coding question
- ✅ Language must be supported
- ✅ Custom input must be a non-empty string
- ❌ **No format validation on custom input**
- ❌ Expected output is optional
- ❌ No block check
- ❌ No max attempts check

---

## Error Handling

### Common Errors

#### 403 Forbidden
```json
{
  "error": "Only teachers and admins can test questions"
}
```

#### 404 Not Found
```json
{
  "error": "Question not found"
}
```

#### 400 Bad Request
```json
{
  "error": "Language javascript is not supported for this question"
}
```

```json
{
  "error": "Only coding or fillInTheBlanksCoding questions can be tested"
}
```

```json
{
  "error": "Valid custom input is required"
}
```

#### 500 Internal Server Error
```json
{
  "error": "Code execution failed: Compilation Error: ..."
}
```

---

## Test Results Format

### Individual Test Result
```javascript
{
  input: "[2, 7, 11, 15]\\n9",         // Input provided to code
  output: "[0, 1]",                    // Actual output from code
  expected: "[0, 1]",                  // Expected output
  passed: true,                        // Whether test passed
  isPublic: true,                      // Whether test case is public
  error: null                          // Error message if any
}
```

### Compilation Error Example
```javascript
{
  input: "[2, 7, 11, 15]\\n9",
  output: "Compilation Error: SyntaxError: Unexpected token }",
  expected: "[0, 1]",
  passed: false,
  isPublic: true,
  error: "SyntaxError: Unexpected token }"
}
```

### Execution Error Example
```javascript
{
  input: "[2, 7, 11, 15]\\n9",
  output: "Execution Error: ReferenceError: undefined is not a function",
  expected: "[0, 1]",
  passed: false,
  isPublic: false,
  error: "ReferenceError: undefined is not a function"
}
```

---

## Security Features

1. **Role-based Access Control**
   - Only teachers and admins can access these endpoints
   - Students get 403 Forbidden

2. **No Data Persistence**
   - No Submission records created
   - No Leaderboard updates
   - No Class statistics affected
   - No Socket.IO emissions

3. **Docker Isolation**
   - Same security as student submissions
   - Network disabled
   - Memory limits enforced
   - CPU limits enforced
   - Temp files cleaned up

4. **No Impact on Students**
   - Teacher testing is completely isolated
   - Students are unaware of teacher tests
   - No real-time notifications

---

## Use Cases

### 1. Testing Before Publishing
Teachers can test their questions with various inputs before making them available to students.

### 2. Debugging Test Cases
Teachers can verify that hidden test cases work correctly without publishing the question.

### 3. Custom Input Testing
Teachers can test edge cases that aren't covered by predefined test cases.

### 4. Solution Validation
Teachers can validate their reference solutions against all test cases.

### 5. Live Class Demonstrations
Teachers can demonstrate solutions to students in real-time without affecting leaderboards.

---

## Comparison Table

| Feature | Student Submit | Student Run | Teacher Test | Teacher Custom Test |
|---------|---------------|-------------|--------------|---------------------|
| **Endpoint** | `/submit` | `/run` | `/teacher-test` | `/teacher-test-custom` |
| **Test Cases** | All | Public only | **All (visible)** | **Custom only** |
| **Database** | ✅ Saved | ✅ Saved | ❌ Not saved | ❌ Not saved |
| **Leaderboard** | ✅ Updated | ❌ No update | ❌ No update | ❌ No update |
| **Stats** | ✅ Updated | ✅ Runs++ | ❌ No update | ❌ No update |
| **Socket.IO** | ✅ Emitted | ✅ Emitted | ❌ No emission | ❌ No emission |
| **Max Attempts** | ✅ Enforced | ❌ No limit | ❌ No limit | ❌ No limit |
| **Block Check** | ✅ Checked | ✅ Checked | ❌ No check | ❌ No check |
| **Input Format** | ✅ Validated | ✅ Validated | N/A | ❌ **No validation** |
| **Role** | Student | Student | **Teacher/Admin** | **Teacher/Admin** |

---

## Conclusion

The teacher testing API provides a powerful, isolated environment for teachers to:
- Test questions thoroughly before publishing
- Debug issues without affecting student data
- Demonstrate solutions in live classes
- Validate reference implementations
- Test edge cases with custom inputs

All of this is done **without any impact** on student leaderboards, submissions, or class statistics.

