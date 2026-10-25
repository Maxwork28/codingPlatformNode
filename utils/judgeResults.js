'use strict';

/** Student-facing test result rows with stable numbering and hidden I/O for private cases. */
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

/** Staff view of stored results: every test with its I/O. */
const staffTestResultRows = (rawResults = []) =>
    rawResults.map((r, index) => ({
        testCaseNumber: r.testCaseNumber ?? index + 1,
        passed: !!r.passed,
        isPublic: r.isPublic !== false,
        status: r.status,
        isTLE: !!r.isTLE,
        isMLE: !!r.isMLE,
        timeMs: r.timeMs ?? null,
        wallMs: r.wallMs ?? null,
        memoryKb: r.memoryKb ?? null,
        input: r.input,
        output: r.output,
        expected: r.expected,
        error: r.error || null,
    }));

/** Overall verdict of a judged submission: the first failing test's status, or accepted. */
const overallStatus = (testResults = []) => {
    const firstFail = testResults.find((t) => !t.passed && t.status !== 'skipped');
    if (!firstFail) return testResults.length ? 'accepted' : 'wrong_answer';
    return firstFail.status === 'pending_check' ? 'wrong_answer' : firstFail.status || 'wrong_answer';
};

module.exports = { sanitizeTestResultsForStudent, staffTestResultRows, overallStatus };
