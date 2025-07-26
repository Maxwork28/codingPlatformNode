const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const { timeout } = require('promise-timeout');

const docker = new Docker();

// Test C code with space-separated input
const testCode = `
#include <stdio.h>

int main() {
    int num1, num2;
    if (scanf("%d %d", &num1, &num2) != 2) {
        fprintf(stderr, "Error: Failed to read input\\n");
        return 1;
    }
    int sum = num1 + num2;
    printf("%d", sum);
    fflush(stdout);
    return 0;
}
`;

// Test cases with space-separated input
const testCases = [
    { input: '1 2', expectedOutput: '3' },
    { input: '2 3', expectedOutput: '5' }
];

const languageConfig = {
       c: { image: 'c-compiler', ext: '.c', compileCmd: ['gcc', '/app/code.c', '-o', '/app/code'], runCmd: ['./code'] },

};

async function testDockerEnvironment() {
    console.log('[Docker Test] Starting Docker environment test for C language');
    const testResults = [];
    const config = languageConfig.c;
    const codeFile = `code${config.ext}`;
    const tempDir = path.join(__dirname, 'temp', Date.now().toString());

    let container;
    try {
        // Create temporary directory
        console.log('[Docker Test] Creating temp directory:', tempDir);
        await fs.mkdir(tempDir, { recursive: true });

        // Write test code to file
        console.log('[Docker Test] Writing code to file:', path.join(tempDir, codeFile));
        await fs.writeFile(path.join(tempDir, codeFile), testCode);

        // Create Docker container
        console.log('[Docker Test] Creating Docker container with image:', config.image);
        container = await docker.createContainer({
            Image: config.image,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            OpenStdin: true,
            StdinOnce: false,
            HostConfig: {
                Memory: 256 * 1024 * 1024, // 256MB
                CpuPeriod: 100000,
                CpuQuota: 300000, // Increased CPU quota
                NetworkMode: 'none',
                Binds: [`${tempDir}:/app:rw`]
            },
            WorkingDir: '/app',
            Cmd: ['sleep', 'infinity']
        });

        // Start container
        console.log('[Docker Test] Starting container');
        await container.start();

        // Test container environment
        console.log('[Docker Test] Checking container environment');
        const envExec = await container.exec({
            Cmd: ['bash', '-c', 'gcc --version && ls -l /app && whoami'],
            AttachStdout: true,
            AttachStderr: true
        });
        const envStream = await envExec.start({});
        let envOutput = '';
        await new Promise((resolve, reject) => {
            envStream.on('data', (data) => envOutput += data.toString('utf8').replace(/[^\x20-\x7E\n]/g, ''));
            envStream.on('error', (err) => reject(err));
            envStream.on('end', resolve);
        });
        console.log('[Docker Test] Environment check output:', envOutput);

        // Compile the code
        console.log('[Docker Test] Compiling code with command:', config.compileCmd.join(' '));
        const compileExec = await container.exec({
            Cmd: config.compileCmd,
            AttachStdout: true,
            AttachStderr: true
        });

        const compileStream = await compileExec.start({});
        let compileOutput = '';
        let compileError = '';
        await new Promise((resolve, reject) => {
            compileStream.on('data', (data) => compileOutput += data.toString('utf8').replace(/[^\x20-\x7E\n]/g, ''));
            compileStream.on('error', (data) => compileError += data.toString('utf8').replace(/[^\x20-\x7E\n]/g, ''));
            compileStream.on('end', resolve);
        });

        if (compileError || compileOutput) {
            console.error('[Docker Test] Compilation output:', compileOutput || 'None');
            console.error('[Docker Test] Compilation error:', compileError || 'None');
            testResults.push({
                status: 'Compilation Failed',
                output: `Compilation Error: ${compileError || compileOutput || 'Unknown'}`
            });
            return testResults;
        }
        console.log('[Docker Test] Compilation successful');

        // Verify compiled binary
        console.log('[Docker Test] Checking compiled binary');
        const lsExec = await container.exec({
            Cmd: ['ls', '-l', '/app/code'],
            AttachStdout: true,
            AttachStderr: true
        });
        const lsStream = await lsExec.start({});
        let lsOutput = '';
        await new Promise((resolve, reject) => {
            lsStream.on('data', (data) => lsOutput += data.toString('utf8').replace(/[^\x20-\x7E\n]/g, ''));
            lsStream.on('error', (data) => lsOutput += data.toString('utf8').replace(/[^\x20-\x7E\n]/g, ''));
            lsStream.on('end', resolve);
        });
        console.log('[Docker Test] Compiled binary check:', lsOutput);

        // Run test cases
        console.log('[Docker Test] Running', testCases.length, 'test cases');
        for (const test of testCases) {
            console.log('[Test Case] Running with input:', test.input, '| Expected:', test.expectedOutput);

            const exec = await container.exec({
                Cmd: ['bash', '-c', `echo "${test.input}" | ${config.runCmd.join(' ')}`],
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                Tty: false
            });

            const stream = await exec.start({ stdin: true, hijack: true });
            let output = '';
            let error = '';

            stream.on('data', (data) => {
                const str = data.toString('utf8').replace(/[^\x20-\x7E\n]/g, '');
                output += str;
                console.log('[Test Case] Stream data received:', str);
            });
            stream.on('error', (err) => {
                const str = err.toString('utf8').replace(/[^\x20-\x7E\n]/g, '');
                error += str;
                console.log('[Test Case] Stream error:', str);
            });

            try {
                await timeout(new Promise((resolve) => stream.on('end', resolve)), 7000);
            } catch (err) {
                error = `Timeout: ${err.message}`;
                console.error('[Test Case] Execution timed out:', err.message);
            }

            // Check exit code
            const execInfo = await exec.inspect();
            console.log('[Test Case] Exec exit code:', execInfo.ExitCode);

            output = output.trim();
            error = error.trim();

            console.log('[Test Case] Raw output:', output || 'No output');
            console.log('[Test Case] Raw error:', error || 'No error');

            const passed = output === test.expectedOutput.trim();
            console.log(`[Test Case] Result: ${passed ? 'PASSED' : 'FAILED'} | Output: ${output || 'No output'} | Error: ${error || 'None'}`);

            testResults.push({
                input: test.input,
                output: error && !passed ? `Error: ${error}` : output || 'No output',
                expected: test.expectedOutput,
                passed
            });
        }

        // Manual execution test
        console.log('[Docker Test] Running manual execution test');
        const manualExec = await container.exec({
            Cmd: ['bash', '-c', 'echo "1 2" | ./code'],
            AttachStdout: true,
            AttachStderr: true
        });
        const manualStream = await manualExec.start({});
        let manualOutput = '';
        let manualError = '';
        await new Promise((resolve, reject) => {
            manualStream.on('data', (data) => {
                const str = data.toString('utf8').replace(/[^\x20-\x7E\n]/g, '');
                manualOutput += str;
            });
            manualStream.on('error', (data) => {
                const str = data.toString('utf8').replace(/[^\x20-\x7E\n]/g, '');
                manualError += str;
            });
            manualStream.on('end', resolve);
        });
        console.log('[Docker Test] Manual execution output:', manualOutput || 'No output');
        console.log('[Docker Test] Manual execution error:', manualError || 'No error');
    } catch (err) {
        console.error('[Docker Test] Error during execution:', err.message, err.stack);
        testResults.push({
            status: 'Error',
            output: `Execution Error: ${err.message}`
        });
    } finally {
        if (container) {
            try {
                console.log('[Docker Test] Stopping and removing container');
                await container.stop();
                await container.remove();
            } catch (err) {
                console.error('[Docker Test] Error cleaning up container:', err.message);
            }
        }
        try {
            console.log('[Docker Test] Cleaning up temp directory');
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch (err) {
            console.error('[Docker Test] Error cleaning up temp directory:', err.message);
        }
    }

    console.log('[Docker Test] Completed with', testResults.filter(t => t.passed).length, 'passed tests out of', testCases.length);
    return testResults;
}

// Run the test and display results
(async () => {
    try {
        const results = await testDockerEnvironment();
        console.log('\n[Docker Test] Final Results:');
        results.forEach((result, index) => {
            if (result.status) {
                console.log(`[${index + 1}] ${result.status}: ${result.output}`);
            } else {
                console.log(`[Test Case ${index + 1}] Input: ${result.input}, Output: ${result.output}, Expected: ${result.expected}, Passed: ${result.passed}`);
            }
        });

        // Check if Docker environment is working
        if (results.every(r => r.passed)) {
            console.log('\n[Docker Test] SUCCESS: Docker environment is working correctly.');
        } else {
            console.log('\n[Docker Test] FAILURE: Docker environment has issues. Check logs for details.');
        }
    } catch (err) {
        console.error('[Docker Test] Fatal error:', err.message, err.stack);
        console.log('\n[Docker Test] FAILURE: Docker environment test failed.');
    }
})();