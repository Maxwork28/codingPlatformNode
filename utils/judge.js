'use strict';

/**
 * Docker code judge.
 *
 * One container per submission (not per test case): the container's own command is a
 * small POSIX sh runner that compiles once, then executes every test case under
 * `timeout -s KILL`, writing stdout/stderr/metrics for each case into the bind-mounted
 * work directory. The host waits for the container with a hard deadline, kills it if
 * the deadline passes, reads the result files, and force-removes the container.
 *
 * Compared to the previous implementation this removes: the un-bounded hang on infinite
 * loops (no wall-clock timeout existed), the 1-10 s `container.stop()` grace period,
 * one exec round-trip per test case, `go run` recompiling per test case, and the
 * un-hardened HostConfig (no pids limit, swap allowed, writable root fs, all caps).
 */

const Docker = require('dockerode');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { runWithSlot, JudgeBusyError, getJudgeQueueStats } = require('./judgeQueue');

const docker = new Docker();

const supportedLanguages = ['javascript', 'c', 'cpp', 'java', 'python', 'ruby', 'php', 'go'];

/**
 * `compileCmd` runs once; `runCmd` runs per test case. Everything executes as the image's
 * non-root `appuser` inside /app (bind mount of the per-run temp dir).
 */
const languageConfig = {
    javascript: { image: 'javascript-compiler', file: 'code.js', compileCmd: null, runCmd: ['node', '/app/code.js'] },
    c: { image: 'c-compiler', file: 'code.c', compileCmd: ['gcc', '-O2', '-o', '/app/code', '/app/code.c', '-lm'], runCmd: ['/app/code'] },
    cpp: { image: 'cpp-compiler', file: 'code.cpp', compileCmd: ['g++', '-O2', '-std=c++17', '-o', '/app/code', '/app/code.cpp'], runCmd: ['/app/code'] },
    java: { image: 'java-compiler', file: 'Solution.java', compileCmd: ['javac', '-d', '/app', '/app/Solution.java'], runCmd: ['java', '-XX:+UseSerialGC', '-Xss64m', '-cp', '/app', 'Solution'] },
    python: { image: 'python-compiler', file: 'code.py', compileCmd: null, runCmd: ['python', '/app/code.py'] },
    php: { image: 'php-compiler', file: 'code.php', compileCmd: null, runCmd: ['php', '/app/code.php'] },
    ruby: { image: 'ruby-compiler', file: 'code.rb', compileCmd: null, runCmd: ['ruby', '/app/code.rb'] },
    go: { image: 'go-compiler', file: 'code.go', compileCmd: ['go', 'build', '-o', '/app/code', '/app/code.go'], runCmd: ['/app/code'] },
};

const JUDGE_TEMP_ROOT = process.env.JUDGE_TEMP_DIR || path.join(os.tmpdir(), 'algosutra-judge');
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TEST_CASES = 200;
const MAX_REPEATS = 10;
const COMPILE_BUDGET_MS = Number.parseInt(process.env.JUDGE_COMPILE_BUDGET_MS, 10) || 20_000;
const HARD_DEADLINE_CAP_MS = Number.parseInt(process.env.JUDGE_MAX_RUN_MS, 10) || 180_000;

/**
 * Container-side runner. Arguments: <cases> <repeats> <timeLimitSeconds> [compile args...] --RUN-- <run args...>
 * Writes per case: _out_R_I.txt, _err_R_I.txt, _meta_R_I.txt ("<exit> <startNs> <endNs> <peakKb>").
 * Compile failures write _compile.txt and exit 2.
 */
const RUN_SENTINEL = '--RUN--';
const RUNNER_SCRIPT = String.raw`#!/bin/sh
set +e
CASES="$1"; REPEATS="$2"; TL="$3"; shift 3
export HOME=/tmp GOCACHE=/tmp/gocache GOPATH=/tmp/go GOTMPDIR=/tmp TMPDIR=/tmp
# largest VmHWM among children of $1 (the program under timeout). Builtins only: no forks,
# so the poll loop does not steal CPU from the judged program.
PEAK=0
peak_of_children() {
  P="$1"
  for d in /proc/[0-9]*; do
    PP=""; HWM=""
    while IFS=' 	' read -r k v _; do
      case "$k" in
        PPid:) PP=$v ;;
        VmHWM:) HWM=$v; break ;;
      esac
    done < "$d/status" 2>/dev/null
    if [ "$PP" = "$P" ] && [ -n "$HWM" ] && [ "$HWM" -gt "$PEAK" ] 2>/dev/null; then PEAK=$HWM; fi
  done
}
COMPILE_ARGS=""; HAVE_COMPILE=0
while [ $# -gt 0 ] && [ "$1" != "--RUN--" ]; do
  HAVE_COMPILE=1
  ESC=$(printf %s "$1" | sed "s/'/'\\\\''/g")
  COMPILE_ARGS="$COMPILE_ARGS '$ESC'"
  shift
done
[ "$1" = "--RUN--" ] && shift
if [ $HAVE_COMPILE -eq 1 ]; then
  # Go: seed the build cache from the image so std packages are not recompiled per run.
  if [ -d /opt/gocache ] && [ ! -d /tmp/gocache ]; then cp -r /opt/gocache /tmp/gocache 2>/dev/null; fi
  eval "timeout -s KILL 20 $COMPILE_ARGS" > /app/_compile.txt 2>&1
  CS=$?
  if [ $CS -ne 0 ]; then echo "compile_failed $CS" > /app/_status.txt; exit 2; fi
fi
HAVE_TIME=0; [ -x /usr/bin/time ] && HAVE_TIME=1
r=0
while [ $r -lt "$REPEATS" ]; do
  i=0
  while [ $i -lt "$CASES" ]; do
    IN="/app/_in_$i.txt"; OUT="/app/_out_$r"_"$i.txt"; ERR="/app/_err_$r"_"$i.txt"; META="/app/_meta_$r"_"$i.txt"
    START=$(date +%s%N 2>/dev/null || echo 0)
    if [ $HAVE_TIME -eq 1 ]; then
      /usr/bin/time -f "%M" -o "/tmp/_m" timeout -s KILL "$TL" "$@" < "$IN" > "$OUT" 2> "$ERR"
      STATUS=$?
      MEM=$(tail -n 1 /tmp/_m 2>/dev/null | tr -dc '0-9')
    else
      timeout -s KILL "$TL" "$@" < "$IN" > "$OUT" 2> "$ERR" &
      PID=$!
      PEAK=0
      while kill -0 "$PID" 2>/dev/null; do
        peak_of_children "$PID"
        sleep 0.02
      done
      wait "$PID"; STATUS=$?
      MEM=$PEAK
    fi
    END=$(date +%s%N 2>/dev/null || echo 0)
    [ -n "$MEM" ] || MEM=0
    echo "$STATUS $START $END $MEM" > "$META"
    i=$((i+1))
  done
  r=$((r+1))
done
echo "done" > /app/_status.txt
exit 0
`;

// ---------------------------------------------------------------------------
// Small helpers shared with controllers
// ---------------------------------------------------------------------------

const roundTimeMs = (value) => Math.round(Number(value) * 10) / 10;

const parseOptionalJudgeLimit = (value, min, max, { integer = true } = {}) => {
    if (value == null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const rounded = integer ? Math.round(n) : Math.round(n * 10) / 10;
    if (rounded < min || rounded > max) return null;
    return rounded;
};

const summarizeRunCaseMetrics = (results) => {
    const times = (results || []).map((row) => Number(row.timeMs)).filter((n) => Number.isFinite(n) && n >= 0);
    const mems = (results || []).map((row) => Number(row.memoryKb)).filter((n) => Number.isFinite(n) && n > 0);
    return {
        maxTimeMs: times.length ? Math.max(...times) : null,
        maxMemoryKb: mems.length ? Math.max(...mems) : null,
    };
};

const averageNumbers = (values) => {
    const nums = (values || []).filter((n) => Number.isFinite(n));
    if (!nums.length) return null;
    return nums.reduce((sum, n) => sum + n, 0) / nums.length;
};

/**
 * Suggested per-test limits from a measured reference solution, with headroom for slower (but
 * still acceptable) student code and a busy judge:
 *   time   = 3 × average + 0.3 s, at least 0.5 s, rounded up to 0.1 s, at most 5 s
 *   memory = 2 × average + 32 MB, at least 64 MB, rounded up to 16 MB, at most 1024 MB
 * Keep in sync with limitsFromAverageMetrics in codingPlatformReact TestSolutionLimitControls.jsx.
 */
const LIMIT_TIME_FACTOR = 3;
const LIMIT_TIME_PAD_S = 0.3;
const LIMIT_TIME_MIN_S = 0.5;
const LIMIT_MEM_FACTOR = 2;
const LIMIT_MEM_PAD_MB = 32;
const LIMIT_MEM_MIN_MB = 64;

const fieldLimitsFromAverages = (avgTimeMs, avgMemoryKb) => {
    const avgS = Math.max(0, Number(avgTimeMs) || 0) / 1000;
    const avgMb = Math.max(0, Number(avgMemoryKb) || 0) / 1024;
    const rawTime = avgS * LIMIT_TIME_FACTOR + LIMIT_TIME_PAD_S;
    const timeLimit = Math.min(5, Math.max(LIMIT_TIME_MIN_S, Math.ceil(rawTime * 10) / 10));
    const rawMem = avgMb * LIMIT_MEM_FACTOR + LIMIT_MEM_PAD_MB;
    const memoryLimit = Math.min(1024, Math.max(LIMIT_MEM_MIN_MB, Math.ceil(rawMem / 16) * 16));
    return { timeLimit, memoryLimit };
};

/**
 * Teachers often store test stdin as a bare JSON array, e.g. [1, 5, 3], while LeetCode-style
 * drivers expect {"arr":[1,5,3]}. Only wraps flat arrays of finite numbers (or empty arrays).
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
    const flatNumbers = parsed.length === 0 || parsed.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!flatNumbers) return inputStr;
    return JSON.stringify({ arr: parsed });
};

/** Compare ignoring CRLF, trailing whitespace on each line, and leading/trailing blank lines. */
const normalizeOutput = (s) =>
    String(s ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .trim();

const readCapped = async (file, cap) => {
    let handle;
    try {
        handle = await fs.open(file, 'r');
        const stat = await handle.stat();
        const size = Math.min(stat.size, cap);
        const buf = Buffer.alloc(size);
        if (size > 0) await handle.read(buf, 0, size, 0);
        let text = buf.toString('utf8');
        if (stat.size > cap) text += `\n... [output truncated at ${cap} bytes]`;
        return text;
    } catch {
        return null;
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const resultRow = (test, fields) => ({
    input: test.input,
    expected: test.expectedOutput,
    isPublic: test.isPublic,
    output: '',
    passed: false,
    error: null,
    status: 'runtime_error',
    isTLE: false,
    isMLE: false,
    timeMs: null,
    memoryKb: null,
    ...fields,
});

const imageMissingError = (language, config) =>
    new Error(
        `Docker image '${config.image}' not found. Build the judge images first:\n` +
        `  Windows: build-docker-images.bat\n` +
        `  Linux/Mac: ./build-docker-images.sh\n` +
        `  Or manually: docker build -t ${config.image}:latest docker/${language}`
    );

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * @param {string} language
 * @param {string} code
 * @param {Array<{input:string, expectedOutput:string, isPublic?:boolean}>} testCases
 * @param {number} timeLimit seconds per test case (0.1..10)
 * @param {number} memoryLimit MB per container (16..2048)
 * @param {{wrapBareArrayStdinForDriver?:boolean, repeats?:number, repeatSummaries?:Array}} options
 * @returns {Promise<Array>} one result row per test case (last repeat round)
 */
const runJudge = async (language, code, testCases, timeLimit, memoryLimit, options = {}) => {
    const config = languageConfig[language];
    if (!config) throw new Error(`Unsupported language: ${language}`);

    const cases = Array.isArray(testCases) ? testCases.slice(0, MAX_TEST_CASES) : [];
    if (cases.length === 0) return [];

    const tlSec = clamp(Number(timeLimit) || 2, 0.1, 10);
    const memMb = clamp(Math.round(Number(memoryLimit) || 256), 16, 2048);
    let repeats = Number.parseInt(options.repeats, 10);
    if (!Number.isFinite(repeats) || repeats < 1) repeats = 1;
    repeats = Math.min(MAX_REPEATS, repeats);
    const wrapStdin = !!options.wrapBareArrayStdinForDriver;

    // Per-case ceiling the runner enforces inside the container (timeout -s KILL).
    const perCaseTimeoutSec = Math.ceil((tlSec + 0.5) * 10) / 10;
    // Host-side hard deadline: compile budget + every case at its ceiling + process startup slack.
    const deadlineMs = Math.min(
        HARD_DEADLINE_CAP_MS,
        (config.compileCmd ? COMPILE_BUDGET_MS : 0) + repeats * cases.length * (perCaseTimeoutSec * 1000 + 400) + 5_000
    );

    await fs.mkdir(JUDGE_TEMP_ROOT, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(JUDGE_TEMP_ROOT, 'run-'));
    // The image user (appuser) must be able to write results into the bind mount.
    await fs.chmod(tempDir, 0o777).catch(() => {});

    const writes = [
        fs.writeFile(path.join(tempDir, config.file), String(code ?? ''), 'utf8'),
        fs.writeFile(path.join(tempDir, '_run.sh'), RUNNER_SCRIPT, { encoding: 'utf8', mode: 0o755 }),
    ];
    cases.forEach((test, i) => {
        const raw = String(test.input ?? '');
        const payload = wrapStdin ? normalizeLeetcodeStyleStdin(raw) : raw;
        writes.push(fs.writeFile(path.join(tempDir, `_in_${i}.txt`), payload, 'utf8'));
    });
    await Promise.all(writes);

    const cmd = [
        '/bin/sh', '/app/_run.sh',
        String(cases.length), String(repeats), String(perCaseTimeoutSec),
        ...(config.compileCmd || []),
        RUN_SENTINEL,
        ...config.runCmd,
    ];

    let container;
    let deadlineHit = false;
    let deadlineTimer = null;
    try {
        try {
            container = await docker.createContainer({
                Image: config.image,
                Cmd: cmd,
                WorkingDir: '/app',
                Env: ['HOME=/tmp', 'GOCACHE=/tmp/gocache', 'GOPATH=/tmp/go', 'TMPDIR=/tmp'],
                AttachStdout: false,
                AttachStderr: false,
                Tty: false,
                NetworkDisabled: true,
                HostConfig: {
                    Binds: [`${tempDir}:/app:rw`],
                    NetworkMode: 'none',
                    Memory: memMb * 1024 * 1024,
                    MemorySwap: memMb * 1024 * 1024, // no swap
                    CpuPeriod: 100000,
                    CpuQuota: 100000, // exactly one CPU; time is enforced by `timeout`, not by CPU share
                    PidsLimit: 64,
                    CapDrop: ['ALL'],
                    SecurityOpt: ['no-new-privileges'],
                    ReadonlyRootfs: true,
                    Tmpfs: { '/tmp': 'rw,nosuid,size=512m' },
                    Ulimits: [
                        { Name: 'fsize', Soft: 32 * 1024 * 1024, Hard: 32 * 1024 * 1024 },
                        { Name: 'nofile', Soft: 1024, Hard: 1024 },
                        { Name: 'core', Soft: 0, Hard: 0 },
                    ],
                    AutoRemove: false,
                },
            });
        } catch (err) {
            if (err?.statusCode === 404 || /no such image/i.test(err?.message || '')) {
                throw imageMissingError(language, config);
            }
            throw err;
        }

        await container.start();

        const waitPromise = container.wait();
        const deadlinePromise = new Promise((resolve) => {
            deadlineTimer = setTimeout(() => {
                deadlineHit = true;
                resolve({ StatusCode: -1, deadline: true });
            }, deadlineMs);
        });
        const waited = await Promise.race([waitPromise, deadlinePromise]);
        if (deadlineHit) {
            await container.kill().catch(() => {});
            await waitPromise.catch(() => {});
        }
        const exitCode = waited?.StatusCode ?? -1;

        // Compile failure
        if (exitCode === 2) {
            const compileOut = (await readCapped(path.join(tempDir, '_compile.txt'), MAX_STDERR_BYTES)) || 'Compilation failed';
            const msg = compileOut.trim() || 'Compilation failed';
            return cases.map((test) =>
                resultRow(test, { output: `Compilation Error: ${msg}`, error: msg, status: 'compile_error' })
            );
        }

        const results = [];
        for (let r = 0; r < repeats; r += 1) {
            const roundResults = [];
            for (let i = 0; i < cases.length; i += 1) {
                const test = cases[i];
                const [out, err, meta] = await Promise.all([
                    readCapped(path.join(tempDir, `_out_${r}_${i}.txt`), MAX_STDOUT_BYTES),
                    readCapped(path.join(tempDir, `_err_${r}_${i}.txt`), MAX_STDERR_BYTES),
                    readCapped(path.join(tempDir, `_meta_${r}_${i}.txt`), 256),
                ]);
                if (meta == null) {
                    // Runner never reached this case: the host deadline killed the container.
                    roundResults.push(
                        resultRow(test, {
                            output: deadlineHit ? 'Time Limit Exceeded (judge deadline)' : 'Execution Error: judge terminated unexpectedly',
                            error: deadlineHit ? 'Time limit exceeded' : `Judge exited with code ${exitCode}`,
                            status: deadlineHit ? 'tle' : 'runtime_error',
                            isTLE: deadlineHit,
                        })
                    );
                    continue;
                }
                const [statusStr, startNs, endNs, memKbStr] = meta.trim().split(/\s+/);
                const status = Number.parseInt(statusStr, 10);
                const elapsedMs =
                    startNs && endNs && startNs !== '0' && endNs !== '0'
                        ? Number(BigInt(endNs) - BigInt(startNs)) / 1e6
                        : null;
                const memoryKb = Number.parseInt(memKbStr, 10) > 0 ? Number.parseInt(memKbStr, 10) : null;
                const stdout = out ?? '';
                let stderr = (err ?? '').trim();

                const killedBySignal = status === 137 || status === 124 || status === 143;
                const overTime = elapsedMs != null && elapsedMs >= tlSec * 1000 - 5;
                const overMemory = memoryKb != null && memoryKb >= memMb * 1024 * 0.97;
                const isTLE = killedBySignal ? overTime || !overMemory : overTime && status !== 0;
                const isMLE = !isTLE && (overMemory || (killedBySignal && !overTime) || /out of memory|OutOfMemoryError|MemoryError|bad_alloc|Killed/i.test(stderr));
                const passed = status === 0 && !isTLE && !isMLE && normalizeOutput(stdout) === normalizeOutput(test.expectedOutput);

                let errorText = null;
                if (isTLE) errorText = `Time limit exceeded (${tlSec}s)`;
                else if (isMLE) errorText = `Memory limit exceeded (${memMb} MB)`;
                else if (status !== 0) errorText = stderr || `Process exited with code ${status}`;
                else if (stderr) errorText = stderr;

                const resultStatus = passed
                    ? 'accepted'
                    : isTLE ? 'tle' : isMLE ? 'mle' : status !== 0 ? 'runtime_error' : 'wrong_answer';

                roundResults.push(
                    resultRow(test, {
                        output: stdout.trimEnd(),
                        passed,
                        error: errorText,
                        status: resultStatus,
                        isTLE: !!isTLE,
                        isMLE: !!isMLE,
                        timeMs: elapsedMs == null ? null : roundTimeMs(Math.min(elapsedMs, tlSec * 1000)),
                        memoryKb,
                    })
                );
            }
            if (Array.isArray(options.repeatSummaries)) {
                const summary = summarizeRunCaseMetrics(roundResults);
                options.repeatSummaries.push({
                    run: r + 1,
                    maxTimeMs: summary.maxTimeMs,
                    maxMemoryKb: summary.maxMemoryKb,
                    passed: roundResults.every((row) => row.passed),
                });
            }
            results.length = 0;
            results.push(...roundResults);
        }
        return results;
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (container) {
            // force-remove kills if still running; no 10 s SIGTERM grace like container.stop()
            await container.remove({ force: true, v: true }).catch(() => {});
        }
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
};

/** Runs the judge in THIS process, gated by the local semaphore. Used by local mode and judge workers. */
const runJudgeDirect = (language, code, testCases, timeLimit, memoryLimit, options = {}) =>
    runWithSlot(() => runJudge(language, code, testCases, timeLimit, memoryLimit, options));

/**
 * Host-side deadline runJudge will apply to this run (same math as inside runJudge; keep in sync).
 * The queue producer uses it to size how long it waits for a worker's answer.
 */
const estimateJudgeDeadlineMs = (language, testCases, timeLimit, options = {}) => {
    const config = languageConfig[language];
    const caseCount = Math.min(Array.isArray(testCases) ? testCases.length : 0, MAX_TEST_CASES);
    const tlSec = clamp(Number(timeLimit) || 2, 0.1, 10);
    let repeats = Number.parseInt(options?.repeats, 10);
    if (!Number.isFinite(repeats) || repeats < 1) repeats = 1;
    repeats = Math.min(MAX_REPEATS, repeats);
    const perCaseTimeoutSec = Math.ceil((tlSec + 0.5) * 10) / 10;
    return Math.min(
        HARD_DEADLINE_CAP_MS,
        (config?.compileCmd ? COMPILE_BUDGET_MS : 0) + repeats * caseCount * (perCaseTimeoutSec * 1000 + 400) + 5_000
    );
};

/**
 * Public entry point (unchanged signature/contract). JUDGE_MODE=queue + REDIS_URL sends the run to
 * BullMQ judge workers; otherwise it runs here exactly as before.
 */
const executeDockerCode = (language, code, testCases, timeLimit, memoryLimit, options = {}) => {
    const remote = require('./judgeRemote');
    if (remote.getJudgeMode() !== 'queue') {
        return runJudgeDirect(language, code, testCases, timeLimit, memoryLimit, options);
    }
    if (!languageConfig[language]) return Promise.reject(new Error(`Unsupported language: ${language}`));
    if (!Array.isArray(testCases) || testCases.length === 0) return Promise.resolve([]);
    return remote.executeViaQueue(
        language,
        code,
        testCases,
        timeLimit,
        memoryLimit,
        options,
        estimateJudgeDeadlineMs(language, testCases, timeLimit, options)
    );
};

/** Best-effort cleanup of leftover judge containers/dirs from a previous crash. Call at boot. */
const cleanupStaleJudgeArtifacts = async () => {
    try {
        const images = new Set(Object.values(languageConfig).map((c) => c.image));
        const containers = await docker.listContainers({ all: true });
        await Promise.all(
            containers
                .filter((c) => images.has(String(c.Image).replace(/:latest$/, '')) && (c.Command || '').includes('_run.sh'))
                .map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => {}))
        );
    } catch {
        /* docker not reachable yet; the first run will surface a clear error */
    }
    try {
        const entries = await fs.readdir(JUDGE_TEMP_ROOT);
        await Promise.all(entries.map((e) => fs.rm(path.join(JUDGE_TEMP_ROOT, e), { recursive: true, force: true }).catch(() => {})));
    } catch {
        /* nothing to clean */
    }
};

/** Resolves true when the Docker daemon answers; used by /health. */
const dockerHealthy = async () => {
    try {
        await docker.ping();
        return true;
    } catch {
        return false;
    }
};

module.exports = {
    executeDockerCode,
    runJudgeDirect,
    estimateJudgeDeadlineMs,
    supportedLanguages,
    languageConfig,
    parseOptionalJudgeLimit,
    summarizeRunCaseMetrics,
    averageNumbers,
    fieldLimitsFromAverages,
    normalizeLeetcodeStyleStdin,
    normalizeOutput,
    cleanupStaleJudgeArtifacts,
    dockerHealthy,
    getJudgeQueueStats,
    JudgeBusyError,
};
