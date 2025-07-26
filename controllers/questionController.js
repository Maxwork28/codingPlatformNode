const mongoose = require('mongoose');
const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Class = require('../models/Class');
const Leaderboard = require('../models/Leaderboard');

const docker = new Docker();

const supportedLanguages = ['javascript', 'c', 'cpp', 'java', 'python', 'ruby', 'php', 'go'];

const languageConfig = {
    javascript: { image: 'javascript-compiler', ext: '.js', compileCmd: null, runCmd: ['node', '/app/code.js'] },
    c: { image: 'c-compiler', ext: '.c', compileCmd: ['gcc', '/app/code.c', '-o', '/app/code'], runCmd: ['./code'] },
    cpp: { image: 'cpp-compiler', ext: '.cpp', compileCmd: ['g++', '/app/code.cpp', '-o', '/app/code'], runCmd: ['./code'] },
    java: { image: 'java-compiler', ext: '.java', compileCmd: ['javac', '/app/Solution.java'], runCmd: ['java', '-cp', '/app', 'Solution'] },
    python: { image: 'python-compiler', ext: '.py', compileCmd: null, runCmd: ['python', '/app/code.py'] },
    php: { image: 'php-compiler', ext: '.php', compileCmd: null, runCmd: ['php', '/app/code.php'] },
    ruby: { image: 'ruby-compiler', ext: '.rb', compileCmd: null, runCmd: ['ruby', '/app/code.rb'] },
    go: { image: 'go-compiler', ext: '.go', compileCmd: null, runCmd: ['go', 'run', '/app/code.go'] },
};

const executeDockerCode = async (language, code, testCases, timeLimit, memoryLimit) => {
    console.log('[executeDockerCode] Starting execution for language:', language);
    const config = languageConfig[language];
    if (!config) {
        console.error('[executeDockerCode] Unsupported language:', language);
        throw new Error(`Unsupported language: ${language}`);
    }

    const codeFile = language === 'java' ? 'Solution.java' : `code${config.ext}`;
    const tempDir = path.join(__dirname, '../temp', Date.now().toString());
    console.log('[executeDockerCode] Creating temp directory:', tempDir);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, codeFile), code);

    const container = await docker.createContainer({
        Image: config.image,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {
            Binds: [`${tempDir}:/app:rw`],
            NetworkMode: 'none',
            Memory: memoryLimit * 1024 * 1024, // MB to bytes
            CpuPeriod: 100000, // 100ms period
            CpuQuota: Math.floor(timeLimit * 100000), // Time limit in microseconds
        },
        WorkingDir: '/app',
        Cmd: ['sleep', 'infinity'],
    });
    console.log('[executeDockerCode] Container created');
    await container.start();
    console.log('[executeDockerCode] Container started');

    const testResults = [];

    try {
        if (config.compileCmd) {
            console.log('[executeDockerCode] Compiling with:', config.compileCmd);
            const compileExec = await container.exec({
                Cmd: config.compileCmd,
                AttachStdout: true,
                AttachStderr: true,
            });
            const compileStream = await compileExec.start({});
            let compileOutput = '', compileError = '';
            await new Promise((resolve) => {
                docker.modem.demuxStream(compileStream, 
                    { write: (data) => compileOutput += data.toString() },
                    { write: (data) => compileError += data.toString() }
                );
                compileStream.on('end', resolve);
            });
            console.log('[executeDockerCode] Compile output:', compileOutput);
            console.log('[executeDockerCode] Compile error:', compileError);
            if (compileError) {
                console.error('[executeDockerCode] Compilation failed');
                for (const test of testCases) {
                    testResults.push({
                        input: test.input,
                        output: `Compilation Error: ${compileError}`,
                        expected: test.expectedOutput,
                        passed: false,
                        isPublic: test.isPublic,
                        error: compileError
                    });
                }
                return testResults;
            }
        }

        for (const test of testCases) {
            console.log('[executeDockerCode] Running test case with input:', test.input);
            const exec = await container.exec({
                Cmd: ['bash', '-c', `echo "${test.input.replace(/"/g, '\\"')}" | ${config.runCmd.join(' ')}`],
                AttachStdout: true,
                AttachStderr: true,
            });
            const stream = await exec.start({});
            let output = '', error = '';
            await new Promise((resolve) => {
                docker.modem.demuxStream(stream, 
                    { write: (data) => output += data.toString() },
                    { write: (data) => error += data.toString() }
                );
                stream.on('end', resolve);
            });
            console.log('[executeDockerCode] Test output:', output);
            console.log('[executeDockerCode] Test error:', error);
            const passed = output.trim() === test.expectedOutput.trim();
            testResults.push({
                input: test.input,
                output: output.trim(),
                expected: test.expectedOutput,
                passed,
                isPublic: test.isPublic,
                error: error.trim() || null
            });
        }
    } catch (err) {
        console.error('[executeDockerCode] Execution error:', err.message, err.stack);
        for (const test of testCases) {
            testResults.push({
                input: test.input,
                output: `Execution Error: ${err.message}`,
                expected: test.expectedOutput,
                passed: false,
                isPublic: test.isPublic,
                error: err.message
            });
        }
    } finally {
        console.log('[executeDockerCode] Cleaning up');
        try {
            await container.stop();
            await container.remove();
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.error('[executeDockerCode] Cleanup error:', cleanupErr.message);
        }
    }
    console.log('[executeDockerCode] Test results:', testResults);
    return testResults;
};

exports.submitAnswer = async (req, res) => {
    console.log('[Submission] New answer submission started');
    try {
        const { questionId } = req.params;
        const { answer, classId, language } = req.body;
        const user = req.user;

        console.log('[Submission] User:', user._id, '| Question:', questionId, '| Class:', classId, '| Language:', language);

        if (user.role !== 'student') {
            console.warn('[Submission] Error: User is not a student');
            return res.status(403).json({ error: 'Only students can submit answers' });
        }

        if (user.isBlocked?.get(classId)) {
            console.warn('[Submission] Error: User is blocked in class');
            return res.status(403).json({ error: 'You are blocked from submitting in this class' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Submission] Error: Question not found:', questionId);
            return res.status(404).json({ error: 'Question not found' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Submission] Error: Question not associated with class:', classId);
            return res.status(400).json({ error: 'Question is not associated with this class' });
        }

        if (!classEntry.isPublished) {
            console.warn('[Submission] Error: Question not published for classId');
            return res.status(403).json({ error: 'Question is not published for this class' });
        }

        if (classEntry.isDisabled) {
            console.warn('[Submission] Error: Question disabled for classId');
            return res.status(403).json({ error: 'Question is disabled for submissions in this class' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[Submission] Error: Class not found:', classId);
            return res.status(404).json({ error: 'Class not found' });
        }

        if (!classData.students.includes(user._id)) {
            console.error('[Submission] Error: Student not enrolled:', user._id);
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }

        if (question.maxAttempts) {
            const submissionCount = await Submission.countDocuments({
                questionId,
                classId,
                studentId: user._id,
                isRun: false
            });
            if (submissionCount >= question.maxAttempts) {
                console.warn('[Submission] Error: Max attempts reached');
                return res.status(403).json({ error: 'Maximum submission attempts reached' });
            }
        }

        let isCorrect = false;
        let output = null;
        let score = 0;
        let codeToExecute = answer;
        let passedTestCases = 0;
        let totalTestCases = 0;

        console.log('[Submission] Processing question type:', question.type);
        if (question.type === 'singleCorrectMcq') {
            isCorrect = parseInt(answer) === question.correctOption;
            score = isCorrect ? question.points : 0;
            output = answer;
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
            console.log('[Submission] singleCorrectMcq result:', isCorrect ? 'Correct' : 'Incorrect');
        } else if (question.type === 'multipleCorrectMcq') {
            const submittedOptions = Array.isArray(answer) ? answer.map(Number) : [parseInt(answer)];
            const correctOptions = question.correctOptions || [];
            isCorrect = submittedOptions.length === correctOptions.length &&
                       submittedOptions.every(opt => correctOptions.includes(opt)) &&
                       correctOptions.every(opt => submittedOptions.includes(opt));
            score = isCorrect ? question.points : 0;
            output = JSON.stringify(submittedOptions);
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
            console.log('[Submission] multipleCorrectMcq result:', isCorrect ? 'Correct' : 'Incorrect');
        } else if (question.type === 'fillInTheBlanks') {
            isCorrect = answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
            score = isCorrect ? question.points : 0;
            output = answer;
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
            console.log('[Submission] fillInTheBlanks result:', isCorrect ? 'Correct' : 'Incorrect');
        } else if (question.type === 'fillInTheBlanksCoding' || question.type === 'coding') {
            if (!language || !question.languages.includes(language)) {
                console.error('[Submission] Error: Invalid or unsupported language:', language);
                return res.status(400).json({ error: `Language ${language} is not supported for this question` });
            }
            if (question.type === 'fillInTheBlanksCoding' && (!question.codeSnippet || !question.correctAnswer)) {
                console.error('[Submission] Error: Missing codeSnippet or correctAnswer');
                return res.status(400).json({ error: 'Question is missing code snippet or correct answer' });
            }
            try {
                if (question.type === 'fillInTheBlanksCoding') {
                    codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
                    console.log('[Submission] Combined code for execution:', codeToExecute);
                }
                const testResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    question.testCases,
                    question.timeLimit,
                    question.memoryLimit
                );
                totalTestCases = testResults.length;
                passedTestCases = testResults.filter(test => test.passed).length;
                isCorrect = testResults.every(test => test.passed);
                score = isCorrect ? question.points : Math.floor((passedTestCases / totalTestCases) * question.points);
                output = JSON.stringify(testResults.filter(result => result.isPublic));
                console.log('[Submission] Coding test results:', testResults);
            } catch (err) {
                console.error('[Submission] Error: Code execution failed:', err.message);
                isCorrect = false;
                score = 0;
                output = `Error: ${err.message}`;
                passedTestCases = 0;
                totalTestCases = question.testCases.length;
            }
        }

        const submission = new Submission({
            questionId,
            classId,
            studentId: user._id,
            answer,
            language,
            isCorrect,
            score,
            output,
            isRun: false,
            passedTestCases,
            totalTestCases
        });
        await submission.save();
        console.log('[Submission] Saved submission:', submission._id);

        console.log('[Submission] Updating class statistics');
        classData.totalSubmits += 1;
        classData.correctAttempts += isCorrect ? 1 : 0;
        classData.wrongAttempts += isCorrect ? 0 : 1;
        await classData.save();

        console.log('[Submission] Updating leaderboard for student:', user._id);
        let leaderboard = await Leaderboard.findOne({
            classId,
            studentId: user._id,
        });

        const attempt = {
            questionId,
            questionType: question.type,
            submissionId: submission._id,
            isCorrect,
            score,
            output,
            submittedAt: new Date(),
            isRun: false,
            passedTestCases,
            totalTestCases
        };

        if (!leaderboard) {
            leaderboard = new Leaderboard({
                classId,
                studentId: user._id,
                correctAttempts: isCorrect ? 1 : 0,
                wrongAttempts: isCorrect ? 0 : 1,
                totalSubmits: 1,
                activityStatus: 'active',
                attempts: [attempt],
            });
            console.log('[Submission] Created new leaderboard');
        } else {
            leaderboard.attempts.push(attempt);
            leaderboard.correctAttempts += isCorrect ? 1 : 0;
            leaderboard.wrongAttempts += isCorrect ? 0 : 1;
            leaderboard.totalSubmits += 1;
            leaderboard.activityStatus = 'active';
            console.log('[Submission] Updated existing leaderboard');
        }
        await leaderboard.save();

        req.io.to(`class:${classId}`).emit('submissionUpdate', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            isCorrect,
            passedTestCases,
            totalTestCases
        });

        console.log('[Submission] Successfully processed');
        res.status(200).json({ 
            message: 'Answer submitted successfully', 
            submission,
            passedTestCases,
            totalTestCases,
            explanation: question.explanation
        });
    } catch (err) {
        console.error('[Submission] Error processing submission:', err.message);
        res.status(500).json({ error: 'Error submitting answer' });
    }
};

exports.runQuestion = async (req, res) => {
    console.log('[Run Question] New code run started');
    try {
        const { questionId } = req.params;
        const { answer, classId, language } = req.body;
        const user = req.user;
        console.log('[Run Question] User:', user._id, '| Question:', questionId, '| Class:', classId, '| Language:', language);

        if (user.role !== 'student') {
            console.warn('[Run Question] Error: User is not a student');
            return res.status(403).json({ error: 'Only students can run code' });
        }

        if (user.isBlocked?.get(classId)) {
            console.warn('[Run Question] Error: User is blocked in class');
            return res.status(403).json({ error: 'You are blocked from running code in this class' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Run Question] Error: Question not found:', questionId);
            return res.status(404).json({ error: 'Question not found' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Run Question] Error: Question not associated with class:', classId);
            return res.status(400).json({ error: 'Question is not associated with this class' });
        }

        if (!classEntry.isPublished) {
            console.warn('[Run Question] Error: Question not published for classId');
            return res.status(403).json({ error: 'Question is not published for this class' });
        }

        if (classEntry.isDisabled) {
            console.warn('[Run Question] Error: Question disabled for classId');
            return res.status(403).json({ error: 'Question is disabled for runs in this class' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[Run Question] Error: Class not found:', classId);
            return res.status(404).json({ error: 'Class not found' });
        }

        if (!classData.students.includes(user._id)) {
            console.error('[Run Question] Error: Student not enrolled:', user._id);
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }

        if (question.type !== 'coding' && question.type !== 'fillInTheBlanksCoding') {
            console.error('[Run Question] Error: Not a coding question');
            return res.status(400).json({ error: 'Only coding or fillInTheBlanksCoding questions can be run' });
        }

        if (!language || !question.languages.includes(language)) {
            console.error('[Run Question] Error: Invalid or unsupported language:', language);
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            if (!question.codeSnippet) {
                console.error('[Run Question] Error: Missing codeSnippet');
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
            codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
            console.log('[Run Question] Combined code for execution:', codeToExecute);
        }

        // Filter for public test cases only
        const publicTestCases = question.testCases.filter(tc => tc.isPublic);
        if (publicTestCases.length === 0) {
            console.error('[Run Question] Error: No public test cases available');
            return res.status(400).json({ error: 'No public test cases available for this question' });
        }

        let testResults;
        try {
            console.log('[Run Question] Starting code execution for language:', language);
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                publicTestCases,
                question.timeLimit,
                question.memoryLimit
            );
            console.log('[Run Question] Test results:', testResults);
        } catch (err) {
            console.error('[Run Question] Error: Code execution failed:', err.message);
            return res.status(500).json({ error: `Code execution failed: ${err.message}` });
        }

        const isCorrect = testResults.every(test => test.passed);
        const output = JSON.stringify(testResults);

        const submission = new Submission({
            questionId,
            classId,
            studentId: user._id,
            answer,
            language,
            isCorrect,
            score: 0, // No score for run
            output,
            isRun: true,
            passedTestCases: testResults.filter(test => test.passed).length,
            totalTestCases: testResults.length
        });
        await submission.save();
        console.log('[Run Question] Saved submission (run):', submission._id);

        classData.totalRuns += 1;
        await classData.save();
        console.log('[Run Question] Updated class totalRuns');

        req.io.to(`class:${classId}`).emit('codeRun', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            isCorrect,
            passedTestCases: testResults.filter(test => test.passed).length,
            totalTestCases: testResults.length
        });

        console.log('[Run Question] Successfully processed');
        res.status(200).json({ 
            message: 'Code run successfully', 
            submission, 
            testResults,
            explanation: question.explanation
        });
    } catch (err) {
        console.error('[Run Question] Error processing run:', err.message);
        res.status(500).json({ error: 'Error running code' });
    }
};

exports.runWithCustomInput = async (req, res) => {
    console.log('[Run With Custom Input] New custom input run started');
    try {
        const { questionId } = req.params;
        const { answer, classId, language, customInput, expectedOutput } = req.body;
        const user = req.user;

        console.log('[Run With Custom Input] User:', user._id, '| Question:', questionId, '| Class:', classId, '| Language:', language, '| Expected Output:', expectedOutput);

        if (user.role !== 'student') {
            console.warn('[Run With Custom Input] Error: User is not a student');
            return res.status(403).json({ error: 'Only students can run code with custom input' });
        }

        if (user.isBlocked?.get(classId)) {
            console.warn('[Run With Custom Input] Error: User is blocked in class');
            return res.status(403).json({ error: 'You are blocked from running code in this class' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Run With Custom Input] Error: Question not found:', questionId);
            return res.status(404).json({ error: 'Question not found' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Run With Custom Input] Error: Question not associated with class:', classId);
            return res.status(400).json({ error: 'Question is not associated with this class' });
        }

        if (!classEntry.isPublished) {
            console.warn('[Run With Custom Input] Error: Question not published for classId');
            return res.status(403).json({ error: 'Question is not published for this class' });
        }

        if (classEntry.isDisabled) {
            console.warn('[Run With Custom Input] Error: Question disabled for classId');
            return res.status(403).json({ error: 'Question is disabled for runs in this class' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[Run With Custom Input] Error: Class not found:', classId);
            return res.status(404).json({ error: 'Class not found' });
        }

        if (!classData.students.includes(user._id)) {
            console.error('[Run With Custom Input] Error: Student not enrolled:', user._id);
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }

        if (question.type !== 'coding' && question.type !== 'fillInTheBlanksCoding') {
            console.error('[Run With Custom Input] Error: Not a coding question');
            return res.status(400).json({ error: 'Only coding or fillInTheBlanksCoding questions can be run' });
        }

        if (!language || !question.languages.includes(language)) {
            console.error('[Run With Custom Input] Error: Invalid or unsupported language:', language);
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }

        if (!customInput || typeof customInput !== 'string') {
            console.error('[Run With Custom Input] Error: Invalid custom input');
            return res.status(400).json({ error: 'Valid custom input is required' });
        }

        if (!customInput.match(/^\[\s*-?\d+(\s*,\s*-?\d+)*\s*\]$/)) {
            console.error('[Run With Custom Input] Error: Invalid array format');
            return res.status(400).json({ error: 'Custom input must be a valid array (e.g., [1, 2, 3])' });
        }

        if (expectedOutput && typeof expectedOutput !== 'string') {
            console.error('[Run With Custom Input] Error: Invalid expected output');
            return res.status(400).json({ error: 'Expected output must be a string' });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            if (!question.codeSnippet) {
                console.error('[Run With Custom Input] Error: Missing codeSnippet');
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
            codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
            console.log('[Run With Custom Input] Combined code for execution:', codeToExecute);
        }

        const customTestCase = [{
            input: customInput,
            expectedOutput: expectedOutput || '',
            isPublic: true
        }];

        let testResults;
        try {
            console.log('[Run With Custom Input] Starting code execution for language:', language);
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                customTestCase,
                question.timeLimit,
                question.memoryLimit
            );
            console.log('[Run With Custom Input] Test results:', testResults);
        } catch (err) {
            console.error('[Run With Custom Input] Error: Code execution failed:', err.message);
            return res.status(500).json({ error: `Code execution failed: ${err.message}` });
        }

        const submission = new Submission({
            questionId,
            classId,
            studentId: user._id,
            answer,
            language,
            isCorrect: testResults[0].passed && expectedOutput !== undefined,
            score: 0, // No score for custom input run
            output: JSON.stringify(testResults),
            isRun: true,
            isCustomInput: true,
            passedTestCases: testResults[0].passed ? 1 : 0,
            totalTestCases: 1
        });
        await submission.save();
        console.log('[Run With Custom Input] Saved submission (custom run):', submission._id);

        classData.totalRuns += 1;
        await classData.save();
        console.log('[Run With Custom Input] Updated class totalRuns');

        req.io.to(`class:${classId}`).emit('customInputRun', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            customInput,
            expectedOutput
        });

        console.log('[Run With Custom Input] Successfully processed');
        res.status(200).json({
            message: 'Code run with custom input successfully',
            submission,
            testResults: testResults[0],
            explanation: question.explanation
        });
    } catch (err) {
        console.error('[Run With Custom Input] Error processing run:', err.message);
        res.status(500).json({ error: 'Error running code with custom input' });
    }
};

exports.assignQuestion = async (req, res) => {
    console.log('[Question Assignment] Started');
    try {
        const { classIds, ...questionData } = req.body;
        const user = req.user;

        console.log('[Question Assignment] User:', user._id, '| Role:', user.role, '| Class IDs:', classIds);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Question Assignment] Error: Role not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can assign questions' });
        }

        if (!questionData || !questionData.type || !questionData.title) {
            console.error('[Question Assignment] Error: Type or title missing');
            return res.status(400).json({ error: 'Question type and title required' });
        }

        if (!['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'].includes(questionData.type)) {
            console.error('[Question Assignment] Error: Invalid type');
            return res.status(400).json({ error: 'Invalid question type' });
        }

        if (questionData.type === 'coding' || questionData.type === 'fillInTheBlanksCoding') {
            if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) {
                console.error('[Question Assignment] Error: No languages');
                return res.status(400).json({ error: 'At least one language required' });
            }
            if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) {
                console.error('[Question Assignment] Error: Invalid languages');
                return res.status(400).json({ error: 'Invalid language specified' });
            }
            if (!Array.isArray(questionData.templateCode) || questionData.templateCode.length === 0) {
                console.error('[Question Assignment] Error: No template code');
                return res.status(400).json({ error: 'Template code required' });
            }
            if (!questionData.templateCode.every(tc => tc.language && tc.code && questionData.languages.includes(tc.language))) {
                console.error('[Question Assignment] Error: Invalid template code');
                return res.status(400).json({ error: 'Invalid template code structure' });
            }
            if (!questionData.testCases || !Array.isArray(questionData.testCases) || questionData.testCases.length === 0) {
                console.error('[Question Assignment] Error: No test cases');
                return res.status(400).json({ error: 'At least one test case required' });
            }
            if (questionData.timeLimit <= 0) {
                console.error('[Question Assignment] Error: Invalid time limit');
                return res.status(400).json({ error: 'Time limit must be positive' });
            }
            if (questionData.memoryLimit <= 0) {
                console.error('[Question Assignment] Error: Invalid memory limit');
                return res.status(400).json({ error: 'Memory limit must be positive' });
            }
        }

        let classes = [];
        if (classIds && Array.isArray(classIds) && classIds.length > 0) {
            classes = await Class.find({ _id: { $in: classIds } });
            if (classes.length !== classIds.length) {
                console.error('[Question Assignment] Error: Some classes not found');
                return res.status(404).json({ error: 'One or more classes not found' });
            }
        }

        const question = new Question({
            ...questionData,
            createdBy: user._id,
            points: questionData.points || (questionData.type === 'singleCorrectMcq' ? 10 : questionData.type === 'multipleCorrectMcq' ? 10 : questionData.type === 'fillInTheBlanks' ? 15 : 20),
            classes: classes.map(c => ({ classId: c._id, isPublished: false, isDisabled: false })),
        });
        await question.save();
        console.log('[Question Assignment] Saved:', question._id);

        for (const classData of classes) {
            classData.questions.push(question._id);
            await classData.save();
            console.log('[Question Assignment] Added to class:', classData._id);
        }

        res.status(201).json({ message: 'Question created and assigned', question });
    } catch (err) {
        console.error('[Question Assignment] Error:', err.message);
        res.status(500).json({ error: 'Error assigning question' });
    }
};

exports.editQuestion = async (req, res) => {
    console.log('[Edit Question] Editing Question:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const questionData = req.body;
        const user = req.user;

        console.log('[Edit Question] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Edit Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can edit' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Edit Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        if (!questionData.type || !questionData.title) {
            console.error('[Edit Question] Error: Missing fields');
            return res.status(400).json({ error: 'Type and title required' });
        }

        if (questionData.type === 'coding' || questionData.type === 'fillInTheBlanksCoding') {
            if (!Array.isArray(questionData.languages) || questionData.languages.length === 0) {
                console.error('[Edit Question] Error: No languages');
                return res.status(400).json({ error: 'At least one language required' });
            }
            if (!questionData.languages.every(lang => supportedLanguages.includes(lang))) {
                console.error('[Edit Question] Error: Invalid language');
                return res.status(400).json({ error: 'Invalid language' });
            }
            if (!Array.isArray(questionData.templateCode) || questionData.templateCode.length === 0) {
                console.error('[Edit Question] Error: No template code');
                return res.status(400).json({ error: 'Template code required' });
            }
            if (!questionData.templateCode.every(tc => tc.language && tc.code && questionData.languages.includes(tc.language))) {
                console.error('[Edit Question] Error: Invalid template code');
                return res.status(400).json({ error: 'Invalid template code' });
            }
            if (!questionData.testCases || !Array.isArray(questionData.testCases) || questionData.testCases.length === 0) {
                console.error('[Edit Question] Error: No test cases');
                return res.status(400).json({ error: 'At least one test case required' });
            }
            if (questionData.timeLimit <= 0) {
                console.error('[Edit Question] Error: Invalid time limit');
                return res.status(400).json({ error: 'Time limit must be positive' });
            }
            if (questionData.memoryLimit <= 0) {
                console.error('[Edit Question] Error: Invalid memory limit');
                return res.status(400).json({ error: 'Memory limit must be positive' });
            }
        }

        Object.assign(question, {
            ...questionData,
            updatedAt: new Date(),
        });
        await question.save();

        for (const classEntry of question.classes) {
            req.io.to(`class:${classEntry.classId}`).emit('questionUpdated', {
                questionId: question._id,
                updatedFields: questionData,
            });
        }

        console.log('[Edit Question] Question updated:', question._id);
        res.status(200).json({ message: 'Question updated', question });
    } catch (err) {
        console.error('[Edit Question] Error:', err.message);
        res.status(500).json({ error: 'Error editing question' });
    }
};

exports.deleteQuestion = async (req, res) => {
    console.log('[Delete Question] Deleting:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Delete Question] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Delete Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can delete' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Delete Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        await Class.updateMany(
            { _id: { $in: question.classes.map(c => c.classId) } },
            { $pull: { questions: question._id } }
        );

        await Submission.deleteMany({ questionId });
        await Leaderboard.updateMany(
            { classId: { $in: question.classes.map(c => c.classId) } },
            { $pull: { attempts: { questionId } } }
        );

        await question.deleteOne();
        console.log('[Delete Question] Deleted:', questionId);

        for (const classEntry of question.classes) {
            req.io.to(`class:${classEntry.classId}`).emit('questionDeleted', { questionId });
        }

        res.status(200).json({ message: 'Question deleted successfully' });
    } catch (err) {
        console.error('[Delete Question] Error:', err.message);
        res.status(500).json({ error: 'Error deleting question' });
    }
};

exports.viewSolution = async (req, res) => {
    console.log('[View Solution] Fetching solution:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[View Solution] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[View Solution] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view solution' });
        }

        const question = await Question.findById(questionId).select('solution correctAnswer correctOption correctOptions codeSnippet templateCode starterCode');
        if (!question) {
            console.error('[View Solution] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        console.log('[View Solution] Solution fetched:', questionId);
        res.status(200).json({ solution: question });
    } catch (err) {
        console.error('[View Solution] Error:', err.message);
        res.status(500).json({ error: 'Error fetching solution' });
    }
};

exports.viewTestCases = async (req, res) => {
    console.log('[View Test Cases] Fetching test cases:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[View Test Cases] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[View Test Cases] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view test cases' });
        }

        const question = await Question.findById(questionId).select('testCases');
        if (!question) {
            console.error('[View Test Cases] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        console.log('[View Test Cases] Test cases fetched:', questionId);
        res.status(200).json({ testCases: question.testCases });
    } catch (err) {
        console.error('[View Test Cases] Error:', err.message);
        res.status(500).json({ error: 'Error fetching test cases' });
    }
};

exports.viewStatement = async (req, res) => {
    console.log('[View Statement] Fetching statement:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[View Statement] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[View Statement] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view statement' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[View Statement] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        console.log('[View Statement] Statement fetched:', questionId);
        res.status(200).json({
            title: question.title,
            description: question.description,
            constraints: question.constraints,
            examples: question.examples,
            codeSnippet: question.codeSnippet,
            starterCode: question.starterCode,
        });
    } catch (err) {
        console.error('[View Statement] Error:', err.message);
        res.status(500).json({ error: 'Error fetching statement' });
    }
};

exports.publishQuestion = async (req, res) => {
    console.log('[Publish Question] Publishing:', req.params.questionId);
    try {
        const { questionId } = req.params;
        let { classId } = req.body;
        const user = req.user;

        console.log('[Publish Question] User:', user._id, '| Class:', classId);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Publish Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can publish' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Publish Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        classId = typeof classId === 'object' && classId.classId ? classId.classId : classId;
        if (!classId || typeof classId !== 'string') {
            console.error('[Publish Question] Error: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId' });
        }

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            console.error('[Publish Question] Error: Invalid ObjectId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Publish Question] Error: Not associated with class');
            return res.status(400).json({ error: 'Question not associated with class' });
        }

        console.log('[Publish Question] Before update:', classEntry.isPublished);
        classEntry.isPublished = true;
        await question.save();
        console.log('[Publish Question] After update:', classEntry.isPublished);

        req.io.to(`class:${classId}`).emit('questionPublished', {
            questionId,
            classId,
            isPublished: true,
        });

        res.status(200).json({ message: 'Question published successfully', question });
    } catch (err) {
        console.error('[Publish Question] Error:', err.message);
        res.status(500).json({ error: 'Error publishing question' });
    }
};

exports.unpublishQuestion = async (req, res) => {
    console.log('[Unpublish Question] Unpublishing:', req.params.questionId);
    try {
        const { questionId } = req.params;
        let { classId } = req.body;
        const user = req.user;

        console.log('[Unpublish Question] User:', user._id, '| Class:', classId);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Unpublish Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can unpublish' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Unpublish Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        classId = typeof classId === 'object' && classId.classId ? classId.classId : classId;
        if (!classId || typeof classId !== 'string') {
            console.error('[Unpublish Question] Error: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId' });
        }

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            console.error('[Unpublish Question] Error: Invalid ObjectId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Unpublish Question] Error: Not associated with class');
            return res.status(400).json({ error: 'Question not associated with class' });
        }

        console.log('[Unpublish Question] Before update:', classEntry.isPublished);
        classEntry.isPublished = false;
        await question.save();
        console.log('[Unpublish Question] After update:', classEntry.isPublished);

        req.io.to(`class:${classId}`).emit('questionPublished', {
            questionId,
            classId,
            isPublished: false,
        });

        res.status(200).json({ message: 'Question unpublished successfully', question });
    } catch (err) {
        console.error('[Unpublish Question] Error:', err.message);
        res.status(500).json({ error: 'Error unpublishing question' });
    }
};

exports.disableQuestion = async (req, res) => {
    console.log('[Disable Question] Disabling:', req.params.questionId);
    try {
        const { questionId } = req.params;
        let { classId } = req.body;
        const user = req.user;

        console.log('[Disable Question] User:', user._id, '| Class:', classId);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Disable Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can disable' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Disable Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        classId = typeof classId === 'object' && classId.classId ? classId.classId : classId;
        if (!classId || typeof classId !== 'string') {
            console.error('[Disable Question] Error: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId' });
        }

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            console.error('[Disable Question] Error: Invalid ObjectId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Disable Question] Error: Not associated with class');
            return res.status(400).json({ error: 'Question not associated with class' });
        }

        console.log('[Disable Question] Before update:', classEntry.isDisabled);
        classEntry.isDisabled = true;
        await question.save();
        console.log('[Disable Question] After update:', classEntry.isDisabled);

        req.io.to(`class:${classId}`).emit('questionDisabled', {
            questionId,
            classId,
            isDisabled: true,
        });

        res.status(200).json({ message: 'Question disabled successfully', question });
    } catch (err) {
        console.error('[Disable Question] Error:', err.message);
        res.status(500).json({ error: 'Error disabling question' });
    }
};

exports.enableQuestion = async (req, res) => {
    console.log('[Enable Question] Enabling:', req.params.questionId);
    try {
        const { questionId } = req.params;
        let { classId } = req.body;
        const user = req.user;

        console.log('[Enable Question] User:', user._id, '| Class:', classId);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Enable Question] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can enable' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Enable Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        classId = typeof classId === 'object' && classId.classId ? classId.classId : classId;
        if (!classId || typeof classId !== 'string') {
            console.error('[Enable Question] Error: Invalid classId');
            return res.status(400).json({ error: 'Invalid classId' });
        }

        if (!mongoose.Types.ObjectId.isValid(classId)) {
            console.error('[Enable Question] Error: Invalid ObjectId');
            return res.status(400).json({ error: 'Invalid classId format' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Enable Question] Error: Not associated with class');
            return res.status(400).json({ error: 'Question not associated with class' });
        }

        console.log('[Enable Question] Before update:', classEntry.isDisabled);
        classEntry.isDisabled = false;
        await question.save();
        console.log('[Enable Question] After update:', classEntry.isDisabled);

        req.io.to(`class:${classId}`).emit('questionDisabled', {
            questionId,
            classId,
            isDisabled: false,
        });

        res.status(200).json({ message: 'Question enabled successfully', question });
    } catch (err) {
        console.error('[Enable Question] Error:', err.message);
        res.status(500).json({ error: 'Error enabling question' });
    }
};

exports.getLeaderboard = async (req, res) => {
    console.log('[Get Leaderboard] Fetching leaderboard for class:', req.params.classId);
    try {
        const { classId } = req.params;
        const user = req.user;

        console.log('[Get Leaderboard] User:', user._id);

        if (!['admin', 'teacher', 'student'].includes(user.role)) {
            console.warn('[Get Leaderboard] Error: Not authorized');
            return res.status(403).json({ error: 'Not authorized to view leaderboard' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[Get Leaderboard] Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (user.role === 'student' && !classData.students.includes(user._id)) {
            console.warn('[Get Leaderboard] Error: Student not enrolled');
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }

        const leaderboard = await Leaderboard.find({ classId })
            .populate('studentId', 'name email')
            .lean();

        console.log('[Get Leaderboard] Leaderboard fetched:', leaderboard.length, 'entries');
        res.status(200).json({ leaderboard });
    } catch (err) {
        console.error('[Get Leaderboard] Error:', err.message);
        res.status(500).json({ error: 'Error fetching leaderboard' });
    }
};

exports.getQuestionsByClass = async (req, res) => {
    console.log('[Get Questions By Class] Fetching questions for class:', req.params.classId);
    try {
        const { classId } = req.params;
        const user = req.user;

        console.log('[Get Questions By Class] User:', user._id);

        if (!['admin', 'teacher', 'student'].includes(user.role)) {
            console.warn('[Get Questions By Class] Error: Not authorized');
            return res.status(403).json({ error: 'Not authorized to view questions' });
        }

        const classData = await Class.findById(classId).populate('questions');
        if (!classData) {
            console.error('[Get Questions By Class] Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (user.role === 'student' && !classData.students.includes(user._id)) {
            console.warn('[Get Questions By Class] Error: Student not enrolled');
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }

        const questions = classData.questions.filter(q => {
            const classEntry = q.classes.find(c => c.classId.toString() === classId);
            return user.role !== 'student' || (classEntry.isPublished && !classEntry.isDisabled);
        });

        console.log('[Get Questions By Class] Questions fetched:', questions.length);
        res.status(200).json({ questions });
    } catch (err) {
        console.error('[Get Questions By Class] Error:', err.message);
        res.status(500).json({ error: 'Error fetching questions' });
    }
};

exports.getQuestion = async (req, res) => {
    console.log('[Get Question] Fetching question:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const user = req.user;

        console.log('[Get Question] User:', user._id);

        if (!['admin', 'teacher', 'student'].includes(user.role)) {
            console.warn('[Get Question] Error: Not authorized');
            return res.status(403).json({ error: 'Not authorized to view question' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Get Question] Error: Not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        console.log('[Get Question] Question fetched:', questionId);
        res.status(200).json({ question });
    } catch (err) {
        console.error('[Get Question] Error:', err.message);
        res.status(500).json({ error: 'Error fetching question' });
    }
};

exports.getAllQuestions = async (req, res) => {
    console.log('[Get All Questions] Fetching all questions');
    try {
        const user = req.user;

        console.log('[Get All Questions] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Get All Questions] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view all questions' });
        }

        const questions = await Question.find().lean();
        console.log('[Get All Questions] Questions fetched:', questions.length);
        res.status(200).json({ questions });
    } catch (err) {
        console.error('[Get All Questions] Error:', err.message);
        res.status(500).json({ error: 'Error fetching questions' });
    }
};

exports.assignQuestionToClass = async (req, res) => {
    console.log('[Assign Question To Class] Assigning question:', req.params.questionId);
    try {
        const { questionId } = req.params;
        const { classId } = req.body;
        const user = req.user;

        console.log('[Assign Question To Class] User:', user._id, '| Class:', classId);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Assign Question To Class] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can assign questions' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Assign Question To Class] Error: Question not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        const classData = await Class.findById(classId);
        if (!classData) {
            console.error('[Assign Question To Class] Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (question.classes.some(c => c.classId.toString() === classId)) {
            console.warn('[Assign Question To Class] Error: Already assigned');
            return res.status(400).json({ error: 'Question already assigned to class' });
        }

        question.classes.push({ classId, isPublished: false, isDisabled: false });
        await question.save();

        classData.questions.push(question._id);
        await classData.save();

        req.io.to(`class:${classId}`).emit('questionAssigned', { questionId, classId });

        console.log('[Assign Question To Class] Question assigned:', questionId, 'to class:', classId);
        res.status(200).json({ message: 'Question assigned to class successfully', question });
    } catch (err) {
        console.error('[Assign Question To Class] Error:', err.message);
        res.status(500).json({ error: 'Error assigning question to class' });
    }
};

exports.searchQuestions = async (req, res) => {
    console.log('[Search Questions] Searching questions');
    try {
        const { title, type, classId } = req.query;
        const user = req.user;

        console.log('[Search Questions] User:', user._id, '| Query:', { title, type, classId });

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Search Questions] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can search questions' });
        }

        let query = {};
        if (title) {
            query.title = { $regex: title, $options: 'i' };
        }
        if (type && ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding'].includes(type)) {
            query.type = type;
        }
        if (classId && mongoose.Types.ObjectId.isValid(classId)) {
            query['classes.classId'] = classId;
        }

        const questions = await Question.find(query).lean();
        console.log('[Search Questions] Found:', questions.length, 'questions');
        res.status(200).json({ questions });
    } catch (err) {
        console.error('[Search Questions] Error:', err.message);
        res.status(500).json({ error: 'Error searching questions' });
    }
};

exports.viewSubmissionCode = async (req, res) => {
    console.log('[View Submission Code] Fetching submission:', req.params.submissionId);
    try {
        const { submissionId } = req.params;
        const user = req.user;

        console.log('[View Submission Code] User:', user._id);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[View Submission Code] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view submission code' });
        }

        const submission = await Submission.findById(submissionId)
            .populate('questionId', 'title')
            .populate('studentId', 'name email');
        if (!submission) {
            console.error('[View Submission Code] Error: Submission not found');
            return res.status(404).json({ error: 'Submission not found' });
        }

        console.log('[View Submission Code] Submission fetched:', submissionId);
        res.status(200).json({ 
            code: submission.answer,
            language: submission.language,
            questionTitle: submission.questionId.title,
            studentName: submission.studentId.name,
            studentEmail: submission.studentId.email,
            isCorrect: submission.isCorrect,
            score: submission.score,
            submittedAt: submission.submittedAt,
        });
    } catch (err) {
        console.error('[View Submission Code] Error:', err.message);
        res.status(500).json({ error: 'Error fetching submission code' });
    }
};

exports.getQuestionPerspectiveReport = async (req, res) => {
    console.log('[Get Question Perspective Report] Fetching report for class:', req.params.classId, 'question:', req.params.questionId);
    try {
        const { classId, questionId } = req.params;
        const user = req.user;

        console.log('[Get Question Perspective Report] User:', user._id);

        if (!['admin', 'teacher', 'student'].includes(user.role)) {
            console.warn('[Get Question Perspective Report] Error: Not authorized');
            return res.status(403).json({ error: 'Not authorized to view report' });
        }

        const classData = await Class.findById(classId).populate('students', 'name email');
        if (!classData) {
            console.error('[Get Question Perspective Report] Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        if (user.role === 'student' && !classData.students.some(s => s._id.toString() === user._id.toString())) {
            console.warn('[Get Question Perspective Report] Error: Student not enrolled');
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }

        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Get Question Perspective Report] Error: Question not found');
            return res.status(404).json({ error: 'Question not found' });
        }

        const classEntry = question.classes.find(c => c.classId.toString() === classId);
        if (!classEntry) {
            console.error('[Get Question Perspective Report] Error: Question not associated with class');
            return res.status(400).json({ error: 'Question not associated with this class' });
        }

        const report = await Leaderboard.aggregate([
            { $match: { classId: new mongoose.Types.ObjectId(classId) } },
            {
                $lookup: {
                    from: 'users',
                    localField: 'studentId',
                    foreignField: '_id',
                    as: 'student'
                }
            },
            { $unwind: '$student' },
            { $unwind: { path: '$attempts', preserveNullAndEmptyArrays: true } },
            { $match: { 'attempts.questionId': new mongoose.Types.ObjectId(questionId) } },
            {
                $group: {
                    _id: '$studentId',
                    studentName: { $first: '$student.name' },
                    studentEmail: { $first: '$student.email' },
                    totalAttempts: { $sum: 1 },
                    correctAttempts: { $sum: { $cond: ['$attempts.isCorrect', 1, 0] } },
                    wrongAttempts: { $sum: { $cond: ['$attempts.isCorrect', 0, 1] } },
                    totalRuns: { $sum: { $cond: ['$attempts.isRun', 1, 0] } },
                    totalSubmits: { $sum: { $cond: ['$attempts.isRun', 0, 1] } },
                    highestScore: { $max: '$attempts.score' },
                    latestSubmission: { $max: '$attempts.submittedAt' }
                }
            },
            { $sort: { highestScore: -1, latestSubmission: 1 } },
            {
                $group: {
                    _id: null,
                    studentData: {
                        $push: {
                            studentId: '$_id',
                            studentName: '$studentName',
                            studentEmail: '$studentEmail',
                            totalAttempts: '$totalAttempts',
                            correctAttempts: '$correctAttempts',
                            wrongAttempts: '$wrongAttempts',
                            totalRuns: '$totalRuns',
                            totalSubmits: '$totalSubmits',
                            highestScore: '$highestScore',
                            latestSubmission: '$latestSubmission'
                        }
                    },
                    totalStudentsAttempted: { $sum: { $cond: [{ $gt: ['$totalAttempts', 0] }, 1, 0] } },
                    totalCorrect: { $sum: '$correctAttempts' },
                    totalWrong: { $sum: '$wrongAttempts' },
                    totalRuns: { $sum: '$totalRuns' },
                    totalSubmits: { $sum: '$totalSubmits' },
                    avgScore: { $avg: '$highestScore' }
                }
            },
            {
                $lookup: {
                    from: 'questions',
                    localField: '_id', // This will be null, so we handle it in $project
                    foreignField: '_id',
                    as: 'questionData'
                }
            },
            { $unwind: { path: '$questionData', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 0,
                    question: {
                        _id: question._id,
                        title: question.title,
                        description: question.description,
                        difficulty: question.difficulty,
                        type: question.type,
                        points: question.points,
                        tags: question.tags,
                        isPublished: {
                            $arrayElemAt: [
                                {
                                    $filter: {
                                        input: '$questionData.classes',
                                        as: 'class',
                                        cond: { $eq: ['$$class.classId', new mongoose.Types.ObjectId(classId)] }
                                    }
                                },
                                0
                            ]
                        },
                        isDisabled: {
                            $arrayElemAt: [
                                {
                                    $filter: {
                                        input: '$questionData.classes',
                                        as: 'class',
                                        cond: { $eq: ['$$class.classId', new mongoose.Types.ObjectId(classId)] }
                                    }
                                },
                                0
                            ]
                        }
                    },
                    class: {
                        _id: classData._id,
                        name: classData.name,
                        description: classData.description
                    },
                    studentData: 1,
                    totalStudentsAttempted: 1,
                    totalCorrect: 1,
                    totalWrong: 1,
                    totalRuns: 1,
                    totalSubmits: 1,
                    avgScore: { $ifNull: ['$avgScore', 0] },
                    totalStudentsEnrolled: classData.students.length
                }
            },
            {
                $set: {
                    'question.isPublished': '$question.isPublished.isPublished',
                    'question.isDisabled': '$question.isDisabled.isDisabled'
                }
            }
        ]);

        const reportData = report[0] || {
            question: {
                _id: question._id,
                title: question.title,
                description: question.description,
                difficulty: question.difficulty,
                type: question.type,
                points: question.points,
                tags: question.tags,
                isPublished: classEntry.isPublished,
                isDisabled: classEntry.isDisabled
            },
            class: {
                _id: classData._id,
                name: classData.name,
                description: classData.description
            },
            studentData: [],
            totalStudentsAttempted: 0,
            totalCorrect: 0,
            totalWrong: 0,
            totalRuns: 0,
            totalSubmits: 0,
            avgScore: 0,
            totalStudentsEnrolled: classData.students.length
        };

        if (user.role === 'student') {
            reportData.studentData = reportData.studentData.filter(s => s.studentId.toString() === user._id.toString());
            delete reportData.totalStudentsAttempted;
            delete reportData.totalCorrect;
            delete reportData.totalWrong;
            delete reportData.totalRuns;
            delete reportData.totalSubmits;
            delete reportData.avgScore;
            delete reportData.totalStudentsEnrolled;
        }

        console.log('[Get Question Perspective Report] Report fetched for question:', questionId);
        res.status(200).json({ report: reportData });
    } catch (err) {
        console.error('[Get Question Perspective Report] Error:', err.message);
        res.status(500).json({ error: 'Error fetching question perspective report' });
    }
};