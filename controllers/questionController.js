const mongoose = require('mongoose');
const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const { mergeDriverWithUserAnswer } = require('../utils/codingDriverMerge');
const { normalizeQuestionRichTextFields } = require('../utils/normalizeRichTextField');
const { parseOptionalPoints, resolvePoints } = require('../utils/optionalPoints');
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

/** Only for creating a new question document (assignQuestion). Publish/edit/etc. are not gated by this flag. */
const ensureTeacherCanCreateQuestion = (user, actionLabel, res) => {
    if (user.role === 'teacher' && !user.canCreateQuestion) {
        console.warn(`${actionLabel} Error: Teacher lacks permission to create questions`);
        res.status(403).json({ error: 'Teacher is not permitted to create questions' });
        return false;
    }
    return true;
};

/**
 * Teachers often store test stdin as a bare JSON array, e.g. [1, 5, 3, 9, 2],
 * while LeetCode-style drivers expect one JSON object with an "arr" field:
 * {"arr":[1,5,3,9,2]}. Without this, JSON.parse yields an array, data.arr is undefined,
 * and the solution throws or prints nothing.
 *
 * Only wraps when the parsed value is a flat array of finite numbers (or empty).
 * Nested arrays / non-numeric elements are left unchanged for other problem shapes.
 */
const normalizeLeetcodeStyleStdin = (inputStr) => {
    const s = String(inputStr ?? '').trim();
    if (!s.startsWith('[')) return inputStr;
    let parsed;
    try {
        parsed = JSON.parse(s);
    } catch {
        return inputStr;
    }
    if (!Array.isArray(parsed)) return inputStr;
    const flatNumbers =
        parsed.length === 0 ||
        parsed.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!flatNumbers) return inputStr;
    return JSON.stringify({ arr: parsed });
};

/**
 * True when this question has driver code for the selected language.
 * Used so we still merge driver + student answer if the question was saved as type "coding"
 * by mistake instead of "codingWithDriver" (otherwise only a bare function runs → no stdout).
 */
const shouldMergeDriverForLanguage = (question, language) => {
    if (question.type === 'fillInTheBlanksCoding') return false;
    if (question.type !== 'coding' && question.type !== 'codingWithDriver') return false;
    if (!Array.isArray(question.driverCode) || question.driverCode.length === 0) return false;
    return question.driverCode.some(
        (d) => d.language === language && d.code && String(d.code).trim().length > 0
    );
};

/** Bare-array stdin normalization for LeetCode-style JSON tests */
const shouldWrapBareArrayStdinForQuestion = (question, language) =>
    question.type === 'codingWithDriver' || shouldMergeDriverForLanguage(question, language);

/** Written into the bind-mounted /app dir so each test can report wall time + peak RSS. */
const JUDGE_METRICS_SCRIPT = `#!/bin/bash
set +e
INFILE="$1"
shift

if command -v /usr/bin/time >/dev/null 2>&1; then
  /usr/bin/time -f '___METRICS___ %e %M' "$@" < "$INFILE"
  exit $?
fi

START_NS=$(date +%s%N 2>/dev/null || echo 0)
"$@" < "$INFILE" &
PID=$!
PEAK=0
while kill -0 "$PID" 2>/dev/null; do
  RSS=$(awk '/VmHWM/{print $2}' /proc/$PID/status 2>/dev/null)
  if [ -n "$RSS" ] && [ "$RSS" -gt "$PEAK" ] 2>/dev/null; then
    PEAK=$RSS
  fi
  if [ -f /proc/$PID/task/$PID/children ]; then
    for CPID in $(cat /proc/$PID/task/$PID/children 2>/dev/null); do
      CRSS=$(awk '/VmHWM/{print $2}' /proc/$CPID/status 2>/dev/null)
      if [ -n "$CRSS" ] && [ "$CRSS" -gt "$PEAK" ] 2>/dev/null; then
        PEAK=$CRSS
      fi
    done
  fi
  sleep 0.01
done
wait "$PID"
STATUS=$?
END_NS=$(date +%s%N 2>/dev/null || echo 0)
if [ "$START_NS" != "0" ] && [ "$END_NS" != "0" ]; then
  ELAPSED=$(awk -v s="$START_NS" -v e="$END_NS" 'BEGIN { printf "%.6f", (e-s)/1000000000 }')
else
  ELAPSED="0"
fi
echo "___METRICS___ \${ELAPSED} \${PEAK}" >&2
exit $STATUS
`.replace(/\r\n/g, '\n');

const METRICS_LINE_RE = /___METRICS___\s+([\d.]+)\s+(\d+)/;

const roundTimeMs = (value) => Math.round(Number(value) * 10) / 10;

const parseJudgeMetrics = (stderr, wallMs) => {
    const raw = String(stderr || '');
    const match = raw.match(METRICS_LINE_RE);
    let timeMs = Number.isFinite(Number(wallMs)) ? roundTimeMs(wallMs) : 0;
    let memoryKb = null;
    const error = raw.replace(METRICS_LINE_RE, '').trim() || null;
    if (match) {
        const sec = parseFloat(match[1]);
        if (Number.isFinite(sec) && sec >= 0) {
            timeMs = roundTimeMs(sec * 1000);
        }
        const mem = parseInt(match[2], 10);
        if (Number.isFinite(mem) && mem > 0) {
            memoryKb = mem;
        }
    }
    return { timeMs, memoryKb, error };
};

const executeDockerCode = async (language, code, testCases, timeLimit, memoryLimit, options = {}) => {
    const wrapBareArrayStdin = !!options.wrapBareArrayStdinForDriver;
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
    await fs.writeFile(path.join(tempDir, '_judge_metrics.sh'), JUDGE_METRICS_SCRIPT, 'utf8');

    let container;
    try {
        container = await docker.createContainer({
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
    } catch (err) {
        console.error(`[executeDockerCode] Error creating container for ${language}:`, err.message);
        // Check if the error is about missing image
        if (err.message && (err.message.includes('No such image') || err.message.includes('no such container'))) {
            throw new Error(
                `Docker image '${config.image}' not found. Please build the Docker images first by running:\n` +
                `  Windows: build-docker-images.bat\n` +
                `  Linux/Mac: ./build-docker-images.sh\n` +
                `  Or manually: docker build -t ${config.image}:latest docker/${language}`
            );
        }
        throw err;
    }
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
                        error: compileError,
                        status: 'compile_error',
                        isTLE: false,
                        isMLE: false,
                        timeMs: null,
                        memoryKb: null,
                    });
                }
                return testResults;
            }
        }

        for (const test of testCases) {
            const inputStr = String(test.input ?? '');
            const stdinPayload = wrapBareArrayStdin ? normalizeLeetcodeStyleStdin(inputStr) : inputStr;
            if (wrapBareArrayStdin && stdinPayload !== inputStr) {
                console.log('[executeDockerCode] Normalized bare array stdin to {"arr":[...]} for driver compatibility');
            }
            console.log('[executeDockerCode] Running test case with input:', inputStr.substring(0, 50));
            await fs.writeFile(path.join(tempDir, '_stdin.txt'), stdinPayload, 'utf8');
            const startedAt = process.hrtime.bigint();
            const exec = await container.exec({
                Cmd: ['bash', '/app/_judge_metrics.sh', '/app/_stdin.txt', ...config.runCmd],
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
            const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const metrics = parseJudgeMetrics(error, wallMs);
            console.log('[executeDockerCode] Test output:', output.substring(0, 100));
            const passed = output.trim() === String(test.expectedOutput ?? '').trim();
            const errStr = metrics.error;
            const isTLE = errStr && (errStr.toLowerCase().includes('timeout') || errStr.toLowerCase().includes('timed out'));
            const isMLE = errStr && (errStr.toLowerCase().includes('memory') || errStr.toLowerCase().includes('oom') || (errStr.toLowerCase().includes('killed') && !isTLE));
            const status = passed ? 'accepted' : (isTLE ? 'tle' : isMLE ? 'mle' : 'wrong_answer');
            testResults.push({
                input: test.input,
                output: output.trim(),
                expected: test.expectedOutput,
                passed,
                isPublic: test.isPublic,
                error: errStr,
                status,
                isTLE: !!isTLE,
                isMLE: !!isMLE,
                timeMs: metrics.timeMs,
                memoryKb: metrics.memoryKb,
            });
        }
    } catch (err) {
        console.error('[executeDockerCode] Execution error:', err.message, err.stack);
        const errMsg = err.message || '';
        const isTLE = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('timed out');
        const isMLE = errMsg.toLowerCase().includes('memory') || errMsg.toLowerCase().includes('oom') || errMsg.toLowerCase().includes('killed');
        const status = isTLE ? 'tle' : isMLE ? 'mle' : 'runtime_error';
        for (const test of testCases) {
            testResults.push({
                input: test.input,
                output: `Execution Error: ${errMsg}`,
                expected: test.expectedOutput,
                passed: false,
                isPublic: test.isPublic,
                error: errMsg,
                status,
                isTLE: !!isTLE,
                isMLE: !!isMLE,
                timeMs: null,
                memoryKb: null,
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

// Export executeDockerCode for use in exam controller
exports.executeDockerCode = executeDockerCode;
exports.shouldMergeDriverForLanguage = shouldMergeDriverForLanguage;
exports.shouldWrapBareArrayStdinForQuestion = shouldWrapBareArrayStdinForQuestion;

/** Student-facing test result rows with stable numbering and hidden I/O for private cases */
const sanitizeTestResultsForStudent = (testResults = []) =>
    testResults.map((r, index) => ({
        testCaseNumber: index + 1,
        passed: !!r.passed,
        isPublic: r.isPublic !== false,
        status: r.status,
        isTLE: !!r.isTLE,
        isMLE: !!r.isMLE,
        timeMs: r.timeMs ?? null,
        memoryKb: r.memoryKb ?? null,
        ...(r.isPublic !== false
            ? {
                input: r.input,
                output: r.output,
                expected: r.expected,
                error: r.error || null,
            }
            : {}),
    }));

exports.sanitizeTestResultsForStudent = sanitizeTestResultsForStudent;

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
        let testResultsForResponse = null;

        console.log('[Submission] Processing question type:', question.type);
        if (question.type === 'singleCorrectMcq') {
            isCorrect = parseInt(answer) === question.correctOption;
            score = isCorrect ? resolvePoints(question.points) : 0;
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
            score = isCorrect ? resolvePoints(question.points) : 0;
            output = JSON.stringify(submittedOptions);
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
            console.log('[Submission] multipleCorrectMcq result:', isCorrect ? 'Correct' : 'Incorrect');
        } else if (question.type === 'fillInTheBlanks') {
            isCorrect = answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
            score = isCorrect ? resolvePoints(question.points) : 0;
            output = answer;
            passedTestCases = isCorrect ? 1 : 0;
            totalTestCases = 1;
            console.log('[Submission] fillInTheBlanks result:', isCorrect ? 'Correct' : 'Incorrect');
        } else if (question.type === 'fillInTheBlanksCoding' || question.type === 'coding' || question.type === 'codingWithDriver') {
            let submissionStatus = 'wrong_answer';
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
                } else if (shouldMergeDriverForLanguage(question, language)) {
                    const driverCodeObj = question.driverCode.find(d => d.language === language);
                    if (driverCodeObj && driverCodeObj.code) {
                        codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                        console.log('[Submission] Combined driver + user code for execution');
                    }
                }
                const testResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    question.testCases,
                    question.timeLimit,
                    question.memoryLimit,
                    { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
                );
                testResultsForResponse = testResults;
                totalTestCases = testResults.length;
                passedTestCases = testResults.filter(test => test.passed).length;
                isCorrect = testResults.every(test => test.passed);
                score = isCorrect ? resolvePoints(question.points) : Math.floor((passedTestCases / totalTestCases) * resolvePoints(question.points));
                const firstFail = testResults.find(t => !t.passed);
                submissionStatus = isCorrect ? 'accepted' : (firstFail?.status || 'wrong_answer');
                output = JSON.stringify(sanitizeTestResultsForStudent(testResults));
                console.log('[Submission] Coding test results:', testResults);
            } catch (err) {
                console.error('[Submission] Error: Code execution failed:', err.message);
                isCorrect = false;
                score = 0;
                const errLower = (err.message || '').toLowerCase();
                submissionStatus = errLower.includes('timeout') ? 'tle' : errLower.includes('memory') || errLower.includes('oom') || errLower.includes('killed') ? 'mle' : 'runtime_error';
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
            totalTestCases,
            status: typeof submissionStatus !== 'undefined' ? submissionStatus : (isCorrect ? 'accepted' : 'wrong_answer')
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

        req.io.to(`class:${classId}`).emit('analyticsUpdated', { classId });
        req.io.to(`class:${classId}`).emit('submissionUpdate', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            isCorrect,
            passedTestCases,
            totalTestCases
        });

        console.log('[Submission] Successfully processed');
        const responsePayload = {
            message: 'Answer submitted successfully',
            submission,
            passedTestCases,
            totalTestCases,
            explanation: question.explanation,
        };
        if (testResultsForResponse) {
            responsePayload.testResults = sanitizeTestResultsForStudent(testResultsForResponse);
            responsePayload.publicTestCases = testResultsForResponse.filter((t) => t.isPublic).length;
            responsePayload.hiddenTestCases = testResultsForResponse.filter((t) => !t.isPublic).length;
        }
        res.status(200).json(responsePayload);
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

        if (question.type !== 'coding' && question.type !== 'fillInTheBlanksCoding' && question.type !== 'codingWithDriver') {
            console.error('[Run Question] Error: Not a coding question');
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be run' });
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
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                console.log('[Run Question] Combined driver + user code for execution');
            }
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
                question.memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
            console.log('[Run Question] Test results:', testResults);
        } catch (err) {
            console.error('[Run Question] Error: Code execution failed:', err.message);
            return res.status(500).json({ error: `Code execution failed: ${err.message}` });
        }

        const isCorrect = testResults.every(test => test.passed);
        const firstFail = testResults.find(t => !t.passed);
        const runStatus = isCorrect ? 'accepted' : (firstFail?.status || 'wrong_answer');
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
            totalTestCases: testResults.length,
            status: runStatus
        });
        await submission.save();
        console.log('[Run Question] Saved submission (run):', submission._id);

        classData.totalRuns += 1;
        await classData.save();
        console.log('[Run Question] Updated class totalRuns');

        req.io.to(`class:${classId}`).emit('analyticsUpdated', { classId });
        req.io.to(`class:${classId}`).emit('codeRun', {
            classId,
            studentId: user._id,
            submissionId: submission._id,
            isCorrect,
            passedTestCases: testResults.filter(test => test.passed).length,
            totalTestCases: testResults.length
        });

        console.log('[Run Question] Successfully processed');
        const sanitizedRunResults = sanitizeTestResultsForStudent(testResults);
        res.status(200).json({ 
            message: 'Code run successfully', 
            submission, 
            testResults: sanitizedRunResults,
            passedTestCases: testResults.filter(test => test.passed).length,
            totalTestCases: testResults.length,
            publicTestCases: testResults.filter((t) => t.isPublic).length,
            hiddenTestCases: testResults.filter((t) => !t.isPublic).length,
            isCorrect,
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

        if (question.type !== 'coding' && question.type !== 'fillInTheBlanksCoding' && question.type !== 'codingWithDriver') {
            console.error('[Run With Custom Input] Error: Not a coding question');
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be run' });
        }

        if (!language || !question.languages.includes(language)) {
            console.error('[Run With Custom Input] Error: Invalid or unsupported language:', language);
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }

        if (!customInput || typeof customInput !== 'string' || !customInput.trim()) {
            console.error('[Run With Custom Input] Error: Invalid custom input');
            return res.status(400).json({ error: 'Valid custom input is required' });
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
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                console.log('[Run With Custom Input] Combined driver + user code for execution');
            }
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
                question.memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
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
        const customResult = testResults[0];
        res.status(200).json({
            message: 'Code run with custom input successfully',
            submission,
            testResults: customResult,
            actualOutput: customResult.output,
            timeMs: customResult.timeMs ?? null,
            memoryKb: customResult.memoryKb ?? null,
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
        if (!ensureTeacherCanCreateQuestion(user, '[Question Assignment]', res)) {
            return;
        }

        if (!questionData || !questionData.type || !questionData.title) {
            console.error('[Question Assignment] Error: Type or title missing');
            return res.status(400).json({ error: 'Question type and title required' });
        }

        if (!['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'].includes(questionData.type)) {
            console.error('[Question Assignment] Error: Invalid type');
            return res.status(400).json({ error: 'Invalid question type' });
        }

        if (questionData.type === 'coding' || questionData.type === 'fillInTheBlanksCoding' || questionData.type === 'codingWithDriver') {
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
            if (questionData.type === 'codingWithDriver') {
                if (!Array.isArray(questionData.driverCode) || questionData.driverCode.length === 0) {
                    console.error('[Question Assignment] Error: Driver code required for codingWithDriver');
                    return res.status(400).json({ error: 'Driver code required for LeetCode-style questions' });
                }
                const hasPlaceholder = questionData.driverCode.every(dc =>
                    dc.code && (dc.code.includes('{{USER_CODE}}') || dc.code.includes('// USER_CODE_HERE') || dc.code.includes('# USER_CODE_HERE'))
                );
                if (!hasPlaceholder) {
                    console.warn('[Question Assignment] Driver code should contain {{USER_CODE}} or // USER_CODE_HERE or # USER_CODE_HERE');
                }
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

        normalizeQuestionRichTextFields(questionData);

        const question = new Question({
            ...questionData,
            createdBy: user._id,
            points: parseOptionalPoints(questionData.points),
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

        if (questionData.type === 'coding' || questionData.type === 'fillInTheBlanksCoding' || questionData.type === 'codingWithDriver') {
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
            if (questionData.type === 'codingWithDriver' && questionData.driverCode) {
                const hasPlaceholder = questionData.driverCode.every(dc =>
                    dc.code && (dc.code.includes('{{USER_CODE}}') || dc.code.includes('// USER_CODE_HERE') || dc.code.includes('# USER_CODE_HERE'))
                );
                if (!hasPlaceholder && questionData.driverCode.length > 0) {
                    console.warn('[Edit Question] Driver code should contain {{USER_CODE}} or // USER_CODE_HERE or # USER_CODE_HERE');
                }
            }
        }

        normalizeQuestionRichTextFields(questionData);
        questionData.points = parseOptionalPoints(questionData.points);
        if (questionData.points === undefined) {
            return res.status(400).json({ error: 'Points must be a non-negative number when provided' });
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
            type: question.type,
            title: question.title,
            description: question.description,
            constraints: question.constraints,
            inputFormat: question.inputFormat,
            outputFormat: question.outputFormat,
            sampleIo: question.sampleIo,
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
        classEntry.publishedAt = new Date();
        await question.save();
        console.log('[Publish Question] After update:', classEntry.isPublished);

        req.io.to(`class:${classId}`).emit('questionPublished', {
            questionId,
            classId,
            isPublished: true,
            publishedAt: classEntry.publishedAt,
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

        let leaderboard = await Leaderboard.find({ classId })
            .populate('studentId', 'name email isBlocked profilePicture')
            .lean();

        console.log('[Get Leaderboard] Raw leaderboard fetched:', leaderboard.length, 'entries');

        // Rank by first-solved: more unique correct solves first, then earlier finish time
        const ranked = leaderboard.map((entry) => {
            const firstSolveByQuestion = {};
            (entry.attempts || []).forEach((attempt) => {
                if (attempt.isRun || !attempt.isCorrect || !attempt.questionId) return;
                const qId = String(attempt.questionId);
                const submittedAt = attempt.submittedAt ? new Date(attempt.submittedAt).getTime() : Infinity;
                if (!firstSolveByQuestion[qId] || submittedAt < firstSolveByQuestion[qId]) {
                    firstSolveByQuestion[qId] = submittedAt;
                }
            });

            // Fallback to highestScores if attempts missing first-correct data
            (entry.highestScores || []).forEach((hs) => {
                if (!hs.isCorrect || !hs.questionId) return;
                const qId = String(hs.questionId);
                const submittedAt = hs.submittedAt ? new Date(hs.submittedAt).getTime() : Infinity;
                if (!firstSolveByQuestion[qId] || submittedAt < firstSolveByQuestion[qId]) {
                    firstSolveByQuestion[qId] = submittedAt;
                }
            });

            const firstSolveTimes = Object.values(firstSolveByQuestion).filter((t) => Number.isFinite(t));
            const problemsSolved = firstSolveTimes.length;
            // Time when the student completed their last first-solve (earlier = better for same solve count)
            const firstSolvedAt = problemsSolved > 0 ? Math.max(...firstSolveTimes) : Infinity;

            const isBlockedForClass = entry.studentId?.isBlocked
                ? (entry.studentId.isBlocked[classId] || false)
                : false;

            return {
                ...entry,
                isBlocked: isBlockedForClass,
                problemsSolved,
                firstSolvedAt: Number.isFinite(firstSolvedAt) ? new Date(firstSolvedAt) : null,
                firstSolvedAtMs: firstSolvedAt,
            };
        });

        ranked.sort((a, b) => {
            if (b.problemsSolved !== a.problemsSolved) return b.problemsSolved - a.problemsSolved;
            if (a.firstSolvedAtMs !== b.firstSolvedAtMs) return a.firstSolvedAtMs - b.firstSolvedAtMs;
            return (b.totalScore || 0) - (a.totalScore || 0);
        });

        leaderboard = ranked.slice(0, 10).map((entry, index) => {
            const { firstSolvedAtMs, ...rest } = entry;
            return {
                ...rest,
                rank: index + 1,
            };
        });

        console.log('[Get Leaderboard] ✅ Returning top 10 ranked by first-solved');
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

        const classData = await Class.findById(classId)
            .populate('questions')
            .populate('teachers', '_id');
        if (!classData) {
            console.error('[Get Questions By Class] Error: Class not found');
            return res.status(404).json({ error: 'Class not found' });
        }

        // Authorization checks
        if (user.role === 'student' && !classData.students.some((id) => String(id) === String(user._id))) {
            console.warn('[Get Questions By Class] Error: Student not enrolled');
            return res.status(403).json({ error: 'Student not enrolled in class' });
        }
        
        if (user.role === 'teacher') {
            const isAssignedTeacher = classData.teachers.some(t => String(t._id || t) === String(user._id));
            const isCreator = String(classData.createdBy) === String(user._id);
            
            if (!isAssignedTeacher && !isCreator) {
                console.warn('[Get Questions By Class] Error: Teacher not assigned to class');
                return res.status(403).json({ error: 'Teacher not assigned to this class' });
            }
            console.log('[Get Questions By Class] Teacher authorized:', { isAssignedTeacher, isCreator });
        }

        // Collect every question id tied to this class: Class.questions, Class.assignments, and Question.classes.
        // Assignments often list all "assigned" work while class.questions can be shorter or stale.
        if (!mongoose.Types.ObjectId.isValid(classId)) {
            return res.status(400).json({ error: 'Invalid class ID' });
        }
        const classOid = new mongoose.Types.ObjectId(classId);
        const idSet = new Set();

        for (const q of classData.questions || []) {
            const id = q && q._id ? q._id : q;
            if (id) idSet.add(String(id));
        }
        for (const a of classData.assignments || []) {
            const qid = a.questionId;
            const id = qid && qid._id ? qid._id : qid;
            if (id) idSet.add(String(id));
        }

        const linkedByClassField = await Question.find({ 'classes.classId': classOid });
        for (const q of linkedByClassField) {
            if (q && q._id) idSet.add(String(q._id));
        }

        const objectIds = [...idSet]
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        let questions = objectIds.length
            ? await Question.find({ _id: { $in: objectIds } })
            : [];

        const getClassEntry = (q) =>
            q.classes?.find((c) => String(c.classId?._id || c.classId) === String(classId));

        questions = questions.filter((q) => {
            const classEntry = getClassEntry(q);
            if (user.role === 'student') {
                // Students see all published questions; disabled only blocks submit/run (enforced elsewhere).
                return Boolean(classEntry && classEntry.isPublished);
            }
            return true;
        });

        questions.sort((a, b) => {
            const strip = (t) => (t || '').replace(/<[^>]*>/g, '');
            const cmp = strip(a.title).localeCompare(strip(b.title));
            return cmp !== 0 ? cmp : String(a._id).localeCompare(String(b._id));
        });

        // For students: attach attempt status (attempted / wrong / not_viewed)
        let responseQuestions = questions;
        if (user.role === 'student') {
            const Leaderboard = require('../models/Leaderboard');
            const lb = await Leaderboard.findOne({ classId, studentId: user._id }).lean();
            const statusByQuestion = {};
            (lb?.highestScores || []).forEach((hs) => {
                const qId = String(hs.questionId);
                if (hs.isCorrect) statusByQuestion[qId] = 'attempted';
                else if (!statusByQuestion[qId]) statusByQuestion[qId] = 'wrong';
            });
            (lb?.attempts || []).forEach((att) => {
                if (att.isRun) return;
                const qId = String(att.questionId);
                if (att.isCorrect) statusByQuestion[qId] = 'attempted';
                else if (statusByQuestion[qId] !== 'attempted') statusByQuestion[qId] = 'wrong';
            });

            responseQuestions = questions.map((q) => {
                const obj = q.toObject ? q.toObject() : { ...q };
                obj.studentAttemptStatus = statusByQuestion[String(q._id)] || 'not_viewed';
                return obj;
            });
        }

        console.log('[Get Questions By Class] Questions fetched:', responseQuestions.length, {
            classQuestionsRef: (classData.questions || []).length,
            assignments: (classData.assignments || []).length,
            linkedByQuestionClasses: linkedByClassField.length,
            uniqueIds: objectIds.length
        });
        res.status(200).json({ questions: responseQuestions });
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
    console.log('[Get All Questions] Fetching questions');
    try {
        const user = req.user;

        console.log('[Get All Questions] User:', user._id, 'Role:', user.role);

        if (!['admin', 'teacher'].includes(user.role)) {
            console.warn('[Get All Questions] Error: Not authorized');
            return res.status(403).json({ error: 'Only admin or teacher can view questions' });
        }

        let questions;
        
        // For admin: return all questions
        // For teacher: return only questions created by that teacher
        if (user.role === 'admin') {
            console.log('[Get All Questions] ===== ADMIN MODE =====');
            console.log('[Get All Questions] Admin user - fetching ALL questions (no filter)');
            const questionCount = await Question.countDocuments();
            console.log('[Get All Questions] Total questions in database:', questionCount);
            questions = await Question.find().populate('createdBy', 'name email _id').lean();
            console.log('[Get All Questions] ✅ All questions fetched:', questions.length);
            console.log('[Get All Questions] Questions fetched match database count:', questions.length === questionCount ? 'YES' : 'NO');
        } else {
            // Teacher: their own questions + questions assigned to classes they're assigned to
            console.log('[Get All Questions] ===== TEACHER MODE =====');
            console.log('[Get All Questions] Teacher user - fetching questions created by:', user._id);
            
            // First, find all classes where this teacher is assigned
            const teacherClasses = await Class.find({
                $or: [
                    { teachers: user._id },
                    { createdBy: user._id }
                ]
            }).select('_id');
            
            const teacherClassIds = teacherClasses.map(c => c._id);
            console.log('[Get All Questions] Teacher is assigned to classes:', teacherClassIds.length, teacherClassIds.map(id => id.toString()));
            
            // Find questions that are either:
            // 1. Created by the teacher, OR
            // 2. Assigned to classes the teacher is assigned to
            const questionQuery = {
                $or: [
                    { createdBy: user._id },
                    { 'classes.classId': { $in: teacherClassIds } }
                ]
            };
            
            questions = await Question.find(questionQuery)
                .populate('createdBy', 'name email _id')
                .lean();
            
            console.log('[Get All Questions] ✅ Teacher questions fetched:', questions.length, '(own + assigned to their classes)');
            
            // Log breakdown
            const ownQuestions = questions.filter(q => String(q.createdBy?._id || q.createdBy) === String(user._id));
            const assignedQuestions = questions.filter(q => {
                const creatorId = String(q.createdBy?._id || q.createdBy);
                return creatorId !== String(user._id) && q.classes?.some(c => teacherClassIds.some(tcId => String(tcId) === String(c.classId)));
            });
            console.log('[Get All Questions] 📊 Breakdown - Own questions:', ownQuestions.length, '| Assigned questions:', assignedQuestions.length);
        }
        
        // Log question details for debugging
        if (questions.length > 0) {
            console.log('[Get All Questions] 📋 Sample questions (first 10):');
            questions.slice(0, 10).forEach((q, idx) => {
                const creatorId = q.createdBy?._id?.toString() || q.createdBy?.toString() || 'N/A';
                const creatorName = q.createdBy?.name || 'N/A';
                console.log(`  [${idx + 1}] ID: ${q._id}, Title: ${q.title?.substring(0, 50)}..., CreatedBy: ${creatorId} (${creatorName}), Type: ${q.type}`);
            });
            
            // Count questions by creator
            const questionsByCreator = {};
            questions.forEach(q => {
                const creatorId = q.createdBy?._id?.toString() || q.createdBy?.toString() || 'unknown';
                questionsByCreator[creatorId] = (questionsByCreator[creatorId] || 0) + 1;
            });
            console.log('[Get All Questions] 📊 Questions by creator:', JSON.stringify(questionsByCreator, null, 2));
            console.log('[Get All Questions] 📊 Total unique creators:', Object.keys(questionsByCreator).length);
            
            if (user.role === 'admin') {
                console.log('[Get All Questions] ✅ ADMIN: All questions from all creators are included');
            } else {
                console.log(`[Get All Questions] ✅ TEACHER: Questions created by requesting teacher (${user._id}):`, questionsByCreator[user._id.toString()] || 0);
            }
        } else {
            console.log('[Get All Questions] ⚠️ No questions found');
        }
        
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
        let classId = req.body.classId;
        const user = req.user;

        console.log('[Assign Question To Class] Request body:', req.body);
        console.log('[Assign Question To Class] Extracted classId:', classId);
        console.log('[Assign Question To Class] User:', user._id, '| Class:', classId);

        // Validate classId
        if (!classId || typeof classId !== 'string') {
            console.error('[Assign Question To Class] Error: Invalid classId', classId);
            return res.status(400).json({ error: 'Invalid classId provided' });
        }

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
        if (type && ['singleCorrectMcq', 'multipleCorrectMcq', 'fillInTheBlanks', 'fillInTheBlanksCoding', 'coding', 'codingWithDriver'].includes(type)) {
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
            .populate('questionId', 'title type testCases codeSnippet driverCode languages timeLimit memoryLimit')
            .populate('studentId', 'name email');
        if (!submission) {
            console.error('[View Submission Code] Error: Submission not found');
            return res.status(404).json({ error: 'Submission not found' });
        }

        console.log('[View Submission Code] Submission fetched:', submissionId);
        const qId = submission.questionId?._id || submission.questionId;
        const question =
            submission.questionId?._id
                ? submission.questionId
                : await Question.findById(qId);
        const isCorrect = Boolean(submission.isCorrect);
        const language = submission.language || 'javascript';
        const payload = {
            questionId: qId,
            classId: submission.classId,
            code: submission.answer,
            language,
            questionTitle: question?.title || 'Question',
            studentName: submission.studentId?.name || 'Student',
            studentEmail: submission.studentId?.email || '',
            isCorrect,
            score: submission.score,
            submittedAt: submission.submittedAt,
            status: submission.status || (isCorrect ? 'accepted' : 'wrong_answer'),
            passedTestCases: submission.passedTestCases ?? 0,
            totalTestCases: submission.totalTestCases ?? 0,
            output: submission.output,
            testResults: null,
        };

        const codingTypes = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'];
        if (
            question &&
            codingTypes.includes(question.type) &&
            submission.answer &&
            question.testCases?.length
        ) {
            try {
                let codeToExecute = submission.answer;
                if (question.type === 'fillInTheBlanksCoding' && question.codeSnippet) {
                    codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', submission.answer);
                } else if (shouldMergeDriverForLanguage(question, language)) {
                    const driverCodeObj = question.driverCode?.find((d) => d.language === language);
                    if (driverCodeObj?.code) {
                        codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, submission.answer, {
                            language,
                        });
                    }
                }
                const timeLimit = question.timeLimit || 2;
                const memoryLimit = question.memoryLimit || 256;
                const rawResults = await executeDockerCode(
                    language,
                    codeToExecute,
                    question.testCases,
                    timeLimit,
                    memoryLimit,
                    { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
                );
                payload.testResults = rawResults.map((r, index) => ({
                    testCaseNumber: index + 1,
                    passed: !!r.passed,
                    isPublic: r.isPublic !== false,
                    status: r.status,
                    isTLE: !!r.isTLE,
                    isMLE: !!r.isMLE,
                    timeMs: r.timeMs ?? null,
                    memoryKb: r.memoryKb ?? null,
                    input: r.input,
                    output: r.output,
                    expected: r.expected,
                    error: r.error || null,
                }));
            } catch (rerunErr) {
                console.warn('[View Submission Code] Teacher full test re-run failed:', rerunErr.message);
            }
        }

        res.status(200).json(payload);
    } catch (err) {
        console.error('[View Submission Code] Error:', err.message);
        res.status(500).json({ error: 'Error fetching submission code' });
    }
};

exports.markSubmissionCorrect = async (req, res) => {
    console.log('[Mark Submission Correct] Submission:', req.params.submissionId);
    try {
        const { submissionId } = req.params;
        const user = req.user;

        if (!['admin', 'teacher'].includes(user.role)) {
            return res.status(403).json({ error: 'Only admin or teacher can mark submissions correct' });
        }

        const submission = await Submission.findById(submissionId).populate('questionId', 'points testCases');
        if (!submission) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        if (submission.isRun) {
            return res.status(400).json({ error: 'Test runs cannot be marked as correct' });
        }

        if (submission.isCorrect) {
            return res.status(200).json({
                message: 'Submission is already marked correct',
                submission: {
                    _id: submission._id,
                    isCorrect: true,
                    score: submission.score,
                    status: submission.status,
                },
            });
        }

        const question = submission.questionId;
        const totalTestCases =
            submission.totalTestCases ||
            (question?.testCases?.length ?? 0);

        submission.isCorrect = true;
        submission.score = resolvePoints(question?.points) || submission.score || 0;
        submission.status = 'accepted';
        if (totalTestCases > 0) {
            submission.passedTestCases = totalTestCases;
            submission.totalTestCases = totalTestCases;
        }
        await submission.save();

        const leaderboard = await Leaderboard.findOne({
            classId: submission.classId,
            studentId: submission.studentId,
        });

        if (leaderboard) {
            const att = leaderboard.attempts.find(
                (a) => a.submissionId && a.submissionId.toString() === submissionId
            );
            if (att) {
                att.isCorrect = true;
                att.score = submission.score;
                if (totalTestCases > 0) {
                    att.passedTestCases = totalTestCases;
                    att.totalTestCases = totalTestCases;
                }
            }
            leaderboard.correctAttempts = (leaderboard.correctAttempts || 0) + 1;
            leaderboard.wrongAttempts = Math.max(0, (leaderboard.wrongAttempts || 0) - 1);
            await leaderboard.save();
        }

        if (req.io) {
            req.io.to(`class:${submission.classId}`).emit('analyticsUpdated', {
                classId: submission.classId,
            });
        }

        res.status(200).json({
            message: 'Submission marked as correct',
            submission: {
                _id: submission._id,
                isCorrect: submission.isCorrect,
                score: submission.score,
                status: submission.status,
                passedTestCases: submission.passedTestCases,
                totalTestCases: submission.totalTestCases,
            },
        });
    } catch (err) {
        console.error('[Mark Submission Correct] Error:', err.message);
        res.status(500).json({ error: 'Error marking submission as correct' });
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

        const classData = await Class.findById(classId).populate('students', 'name email isBlocked');
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

        const submissions = await Submission.find({ classId, questionId })
            .sort({ submittedAt: -1 })
            .lean();

        const attemptsByStudent = new Map();
        for (const sub of submissions) {
            const sid = sub.studentId.toString();
            if (!attemptsByStudent.has(sid)) attemptsByStudent.set(sid, []);
            attemptsByStudent.get(sid).push({
                submissionId: sub._id,
                isCorrect: Boolean(sub.isCorrect),
                score: sub.score ?? 0,
                submittedAt: sub.submittedAt,
                isRun: Boolean(sub.isRun),
                isCustomInput: Boolean(sub.isCustomInput),
                passedTestCases: sub.passedTestCases ?? 0,
                totalTestCases: sub.totalTestCases ?? 0,
                status: sub.status || (sub.isCorrect ? 'accepted' : 'wrong_answer'),
            });
        }

        const statusOrder = { correct: 0, incorrect: 1, not_attempted: 2 };
        const studentData = classData.students.map((student) => {
            const sid = student._id.toString();
            const attempts = attemptsByStudent.get(sid) || [];
            const submits = attempts.filter((a) => !a.isRun);

            let status = 'not_attempted';
            if (submits.length > 0) {
                status = submits.some((a) => a.isCorrect) ? 'correct' : 'incorrect';
            }

            const correctAttempts = submits.filter((a) => a.isCorrect).length;
            const wrongAttempts = submits.filter((a) => !a.isCorrect).length;
            const totalRuns = attempts.filter((a) => a.isRun).length;
            const highestScore = submits.length ? Math.max(...submits.map((a) => a.score)) : 0;

            let isBlocked = false;
            if (student.isBlocked) {
                if (typeof student.isBlocked.get === 'function') {
                    isBlocked = Boolean(student.isBlocked.get(String(classId)));
                } else {
                    isBlocked = Boolean(student.isBlocked[String(classId)]);
                }
            }

            return {
                studentId: student._id,
                studentName: student.name,
                studentEmail: student.email,
                isBlocked,
                status,
                totalAttempts: attempts.length,
                correctAttempts,
                wrongAttempts,
                totalRuns,
                totalSubmits: submits.length,
                highestScore,
                latestSubmission: attempts[0]?.submittedAt || null,
                attempts,
            };
        });

        studentData.sort(
            (a, b) =>
                statusOrder[a.status] - statusOrder[b.status] ||
                (a.studentName || '').localeCompare(b.studentName || '')
        );

        const totalStudentsCorrect = studentData.filter((s) => s.status === 'correct').length;
        const totalStudentsIncorrect = studentData.filter((s) => s.status === 'incorrect').length;
        const totalStudentsNotAttempted = studentData.filter((s) => s.status === 'not_attempted').length;
        const totalStudentsAttempted = totalStudentsCorrect + totalStudentsIncorrect;
        const totalCorrect = studentData.reduce((sum, s) => sum + s.correctAttempts, 0);
        const totalWrong = studentData.reduce((sum, s) => sum + s.wrongAttempts, 0);
        const totalRuns = studentData.reduce((sum, s) => sum + s.totalRuns, 0);
        const totalSubmits = studentData.reduce((sum, s) => sum + s.totalSubmits, 0);
        const scored = studentData.filter((s) => s.totalSubmits > 0);
        const avgScore = scored.length
            ? scored.reduce((sum, s) => sum + s.highestScore, 0) / scored.length
            : 0;

        const reportData = {
            question: {
                _id: question._id,
                title: question.title,
                description: question.description,
                difficulty: question.difficulty,
                type: question.type,
                points: question.points,
                tags: question.tags,
                inputFormat: question.inputFormat,
                outputFormat: question.outputFormat,
                sampleIo: question.sampleIo || [],
                isPublished: classEntry.isPublished,
                isDisabled: classEntry.isDisabled,
            },
            class: {
                _id: classData._id,
                name: classData.name,
                description: classData.description,
            },
            studentData,
            totalStudentsAttempted,
            totalStudentsCorrect,
            totalStudentsIncorrect,
            totalStudentsNotAttempted,
            totalCorrect,
            totalWrong,
            totalRuns,
            totalSubmits,
            avgScore,
            totalStudentsEnrolled: classData.students.length,
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

// Teacher-specific testing endpoint - ALL test cases visible, no leaderboard impact
exports.teacherTestQuestion = async (req, res) => {
    console.log('========================================');
    console.log('[Teacher Test Question] ====== START ======');
    console.log('[Teacher Test Question] Request received at:', new Date().toISOString());
    console.log('[Teacher Test Question] Request params:', req.params);
    console.log('[Teacher Test Question] Request body:', JSON.stringify(req.body, null, 2));
    console.log('[Teacher Test Question] Request headers:', {
        'content-type': req.headers['content-type'],
        'authorization': req.headers['authorization'] ? 'present' : 'missing'
    });
    
    try {
        const { questionId } = req.params;
        const { answer, classId, language } = req.body;
        const user = req.user;

        console.log('[Teacher Test Question] Extracted data:', {
            questionId,
            answer: answer ? `${answer.substring(0, 100)}... (length: ${answer.length})` : 'MISSING',
            classId: classId || 'null (draft question)',
            language,
            userId: user?._id,
            userRole: user?.role
        });

        // Validate request data
        if (!questionId) {
            console.error('[Teacher Test Question] ERROR: questionId is missing');
            return res.status(400).json({ error: 'questionId is required' });
        }

        if (!answer) {
            console.error('[Teacher Test Question] ERROR: answer (solution code) is missing');
            return res.status(400).json({ error: 'Solution code is required' });
        }

        if (!language) {
            console.error('[Teacher Test Question] ERROR: language is missing');
            return res.status(400).json({ error: 'Language is required' });
        }

        if (!user) {
            console.error('[Teacher Test Question] ERROR: User is not authenticated');
            return res.status(401).json({ error: 'User not authenticated' });
        }

        // Authorization check - only teachers and admins
        if (!['teacher', 'admin'].includes(user.role)) {
            console.warn('[Teacher Test Question] ERROR: User is not teacher/admin. Role:', user.role);
            return res.status(403).json({ error: 'Only teachers and admins can test questions' });
        }

        console.log('[Teacher Test Question] Authorization passed. User role:', user.role);

        // Get question
        console.log('[Teacher Test Question] Fetching question from database:', questionId);
        const question = await Question.findById(questionId);
        
        if (!question) {
            console.error('[Teacher Test Question] ERROR: Question not found in database:', questionId);
            return res.status(404).json({ error: 'Question not found' });
        }

        console.log('[Teacher Test Question] Question found:', {
            id: question._id,
            type: question.type,
            title: question.title?.substring(0, 50),
            languages: question.languages,
            testCasesCount: question.testCases?.length || 0,
            timeLimit: question.timeLimit,
            memoryLimit: question.memoryLimit,
            isDraft: question.isDraft,
            status: question.status
        });

        // Verify question is associated with class (optional check)
        // For drafts, classId might not be provided or question might not be assigned to classes yet
        if (classId) {
            console.log('[Teacher Test Question] Checking class association:', classId);
            const classEntry = question.classes?.find(c => c.classId.toString() === classId);
            if (!classEntry) {
                console.warn('[Teacher Test Question] WARNING: Question not associated with class, but allowing teacher test (draft question)');
            } else {
                console.log('[Teacher Test Question] Question is associated with class');
            }
        } else {
            // For drafts, classId is optional
            console.log('[Teacher Test Question] No classId provided - testing draft question (this is OK)');
        }

        // Only coding questions can be tested
        if (question.type !== 'coding' && question.type !== 'fillInTheBlanksCoding' && question.type !== 'codingWithDriver') {
            console.error('[Teacher Test Question] ERROR: Not a coding question. Type:', question.type);
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be tested' });
        }

        console.log('[Teacher Test Question] Question type is valid:', question.type);

        // Validate language
        if (!question.languages || !Array.isArray(question.languages) || question.languages.length === 0) {
            console.error('[Teacher Test Question] ERROR: Question has no languages defined');
            return res.status(400).json({ error: 'Question has no supported languages' });
        }

        if (!question.languages.includes(language)) {
            console.error('[Teacher Test Question] ERROR: Invalid or unsupported language:', {
                requested: language,
                supported: question.languages
            });
            return res.status(400).json({ 
                error: `Language ${language} is not supported for this question. Supported languages: ${question.languages.join(', ')}` 
            });
        }

        console.log('[Teacher Test Question] Language is valid:', language);

        // Validate test cases
        if (!question.testCases || !Array.isArray(question.testCases) || question.testCases.length === 0) {
            console.error('[Teacher Test Question] ERROR: Question has no test cases');
            return res.status(400).json({ error: 'Question has no test cases. Please add at least one test case.' });
        }

        console.log('[Teacher Test Question] Test cases found:', {
            total: question.testCases.length,
            public: question.testCases.filter(tc => tc.isPublic).length,
            hidden: question.testCases.filter(tc => !tc.isPublic).length,
            testCases: question.testCases.map(tc => ({
                input: tc.input?.substring(0, 50),
                expectedOutput: tc.expectedOutput?.substring(0, 50),
                isPublic: tc.isPublic
            }))
        });

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            console.log('[Teacher Test Question] Processing fillInTheBlanksCoding question');
            if (!question.codeSnippet) {
                console.error('[Teacher Test Question] ERROR: Missing codeSnippet for fillInTheBlanksCoding question');
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
            codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
            console.log('[Teacher Test Question] Combined code for execution (length:', codeToExecute.length, ')');
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                console.log('[Teacher Test Question] Combined driver + user code (LeetCode-style)');
            }
        } else {
            console.log('[Teacher Test Question] Processing coding question. Code length:', codeToExecute.length);
        }

        // Validate time and memory limits
        const timeLimit = question.timeLimit || 2;
        const memoryLimit = question.memoryLimit || 256;
        console.log('[Teacher Test Question] Execution limits:', {
            timeLimit,
            memoryLimit
        });

        // Execute with ALL test cases (public + hidden)
        let testResults;
        try {
            console.log('[Teacher Test Question] ====== EXECUTING CODE ======');
            console.log('[Teacher Test Question] Calling executeDockerCode with:', {
                language,
                codeLength: codeToExecute.length,
                testCasesCount: question.testCases.length,
                timeLimit,
                memoryLimit
            });
            
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                question.testCases, // ALL test cases
                timeLimit,
                memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
            
            console.log('[Teacher Test Question] ====== CODE EXECUTION COMPLETE ======');
            console.log('[Teacher Test Question] Test results received:', {
                count: testResults?.length || 0,
                results: testResults?.map((result, idx) => ({
                    index: idx,
                    passed: result.passed,
                    input: result.input?.substring(0, 30),
                    output: result.output?.substring(0, 30),
                    expected: result.expected?.substring(0, 30),
                    error: result.error?.substring(0, 50)
                }))
            });
        } catch (err) {
            console.error('[Teacher Test Question] ====== CODE EXECUTION FAILED ======');
            console.error('[Teacher Test Question] Error type:', err.constructor.name);
            console.error('[Teacher Test Question] Error message:', err.message);
            console.error('[Teacher Test Question] Error stack:', err.stack);
            console.error('[Teacher Test Question] Full error object:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
            
            // Provide more detailed error message
            let errorMessage = err.message || 'Unknown error';
            if (errorMessage.includes('No such image') || errorMessage.includes('no such container')) {
                errorMessage = `Docker image not found. Please build Docker images first. Original error: ${errorMessage}`;
            }
            
            return res.status(500).json({ 
                error: `Code execution failed: ${errorMessage}`,
                details: process.env.NODE_ENV === 'development' ? err.stack : undefined
            });
        }

        if (!testResults || !Array.isArray(testResults) || testResults.length === 0) {
            console.error('[Teacher Test Question] ERROR: Test results are empty or invalid');
            return res.status(500).json({ error: 'Code execution returned no test results' });
        }

        const passedTestCases = testResults.filter(test => test.passed).length;
        const totalTestCases = testResults.length;
        const isCorrect = testResults.every(test => test.passed);
        const publicTestCases = testResults.filter(test => test.isPublic).length;
        const hiddenTestCases = testResults.filter(test => !test.isPublic).length;

        console.log('[Teacher Test Question] Test summary:', {
            passedTestCases,
            totalTestCases,
            isCorrect,
            publicTestCases,
            hiddenTestCases
        });

        // NO DATABASE SAVE - this is just for testing
        // NO LEADERBOARD UPDATE
        // NO SOCKET.IO EMISSION

        const responseData = {
            message: 'Code tested successfully (teacher mode - no submission saved)',
            testResults,
            passedTestCases,
            totalTestCases,
            publicTestCases,
            hiddenTestCases,
            isCorrect,
            explanation: question.explanation,
            teacherMode: true
        };

        console.log('[Teacher Test Question] ====== SUCCESS ======');
        console.log('[Teacher Test Question] Sending response:', {
            status: 200,
            testResultsCount: responseData.testResults.length,
            passedTestCases: responseData.passedTestCases,
            totalTestCases: responseData.totalTestCases,
            isCorrect: responseData.isCorrect
        });
        console.log('========================================');

        res.status(200).json(responseData);
    } catch (err) {
        console.error('[Teacher Test Question] ====== UNEXPECTED ERROR ======');
        console.error('[Teacher Test Question] Error type:', err.constructor.name);
        console.error('[Teacher Test Question] Error message:', err.message);
        console.error('[Teacher Test Question] Error stack:', err.stack);
        console.error('[Teacher Test Question] Full error object:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
        console.error('========================================');
        
        res.status(500).json({ 
            error: 'Error testing code',
            message: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
};

// Teacher-specific custom input testing - no validation on input format
exports.teacherTestWithCustomInput = async (req, res) => {
    console.log('[Teacher Test With Custom Input] Teacher testing with custom input');
    try {
        const { questionId } = req.params;
        const { answer, classId, language, customInput, expectedOutput } = req.body;
        const user = req.user;

        console.log('[Teacher Test With Custom Input] User:', user._id, '| Question:', questionId, '| Language:', language);

        // Authorization check - only teachers and admins
        if (!['teacher', 'admin'].includes(user.role)) {
            console.warn('[Teacher Test With Custom Input] Error: User is not teacher/admin');
            return res.status(403).json({ error: 'Only teachers and admins can test questions' });
        }

        // Get question
        const question = await Question.findById(questionId);
        if (!question) {
            console.error('[Teacher Test With Custom Input] Error: Question not found:', questionId);
            return res.status(404).json({ error: 'Question not found' });
        }

        // Only coding questions can be tested
        if (question.type !== 'coding' && question.type !== 'fillInTheBlanksCoding' && question.type !== 'codingWithDriver') {
            console.error('[Teacher Test With Custom Input] Error: Not a coding question');
            return res.status(400).json({ error: 'Only coding, fillInTheBlanksCoding, or codingWithDriver questions can be tested' });
        }

        // Validate language
        if (!language || !question.languages.includes(language)) {
            console.error('[Teacher Test With Custom Input] Error: Invalid or unsupported language:', language);
            return res.status(400).json({ error: `Language ${language} is not supported for this question` });
        }

        // Validate custom input exists
        if (!customInput || typeof customInput !== 'string' || !customInput.trim()) {
            console.error('[Teacher Test With Custom Input] Error: Invalid custom input');
            return res.status(400).json({ error: 'Valid custom input is required' });
        }

        let codeToExecute = answer;
        if (question.type === 'fillInTheBlanksCoding') {
            if (!question.codeSnippet) {
                console.error('[Teacher Test With Custom Input] Error: Missing codeSnippet');
                return res.status(400).json({ error: 'Question is missing code snippet' });
            }
            codeToExecute = question.codeSnippet.replace('// FILL_IN_THE_BLANK', answer);
            console.log('[Teacher Test With Custom Input] Combined code for execution');
        } else if (shouldMergeDriverForLanguage(question, language)) {
            const driverCodeObj = question.driverCode.find(d => d.language === language);
            if (driverCodeObj && driverCodeObj.code) {
                codeToExecute = mergeDriverWithUserAnswer(driverCodeObj.code, answer, { language });
                console.log('[Teacher Test With Custom Input] Combined driver + user code (LeetCode-style)');
            }
        }

        // Create custom test case - NO FORMAT VALIDATION for teachers
        const customTestCase = [{
            input: customInput.trim(),
            expectedOutput: expectedOutput ? expectedOutput.trim() : '',
            isPublic: true
        }];

        // Execute with custom input
        let testResults;
        try {
            console.log('[Teacher Test With Custom Input] Executing code with custom input');
            testResults = await executeDockerCode(
                language,
                codeToExecute,
                customTestCase,
                question.timeLimit,
                question.memoryLimit,
                { wrapBareArrayStdinForDriver: shouldWrapBareArrayStdinForQuestion(question, language) }
            );
            console.log('[Teacher Test With Custom Input] Test results:', testResults);
        } catch (err) {
            console.error('[Teacher Test With Custom Input] Error: Code execution failed:', err.message);
            return res.status(500).json({ error: `Code execution failed: ${err.message}` });
        }

        const testResult = testResults[0];
        const passed = expectedOutput ? testResult.passed : null; // Only check if expected output provided

        // NO DATABASE SAVE
        // NO LEADERBOARD UPDATE
        // NO SOCKET.IO EMISSION

        console.log('[Teacher Test With Custom Input] Successfully processed (no DB save)');
        res.status(200).json({
            message: 'Code tested with custom input successfully (teacher mode)',
            testResult,
            customInput: customInput.trim(),
            expectedOutput: expectedOutput ? expectedOutput.trim() : null,
            actualOutput: testResult.output,
            passed,
            error: testResult.error,
            timeMs: testResult.timeMs ?? null,
            memoryKb: testResult.memoryKb ?? null,
            explanation: question.explanation,
            teacherMode: true
        });
    } catch (err) {
        console.error('[Teacher Test With Custom Input] Error processing test:', err.message);
        res.status(500).json({ error: 'Error testing code with custom input' });
    }
};