'use strict';

/**
 * Docker code judge.
 *
 * One container per submission (not per test case): the container's own command is a small
 * POSIX sh runner that compiles once, then executes every test case under a CPU-time limit
 * (ulimit -t) and a wall-clock cap (timeout -s KILL), writing stdout/stderr/metrics for each
 * case into the bind-mounted work directory. The host watches that directory while the
 * container runs, so it can
 *   - copy freshly compiled artifacts into the compile cache BEFORE any student code runs
 *     (runner waits for the host's go-ahead), and
 *   - stop the container at the first failed test (stopOnFirstFail).
 * It enforces a hard deadline, reads the results and force-removes the container.
 *
 * Timing: a test's time is the program's own CPU time (user + system) minus the language's
 * measured start-up cost (interpreter / JVM boot), so a busy server or a slow-starting runtime
 * never turns a correct program into "time limit exceeded". The wall-clock cap (JUDGE_WALL_FACTOR
 * x limit + 1 s) only catches programs that sleep or block.
 *
 * Caches (host side, JUDGE_CACHE_DIR):
 *   bin/<sha>    compiled artifacts (or the compile error) per language image + exact program
 *   tests/<sha>  large test inputs, bind-mounted read-only instead of re-written for every run
 */

const Docker = require('dockerode');
const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { runWithSlot, JudgeBusyError, getJudgeQueueStats } = require('./judgeQueue');

const docker = new Docker();

const supportedLanguages = ['javascript', 'c', 'cpp', 'java', 'python', 'ruby', 'php', 'go'];

/**
 * `compileCmd` runs once; `runCmd` runs per test case. Everything executes as the image's
 * non-root `appuser` inside /app (bind mount of the per-run temp dir).
 * `artifacts`: what a successful compile leaves in /app (cached and reused).
 */
const languageConfig = {
    javascript: { image: 'javascript-compiler', file: 'code.js', compileCmd: null, runCmd: ['node', '/app/code.js'], baselineCode: '' },
    c: { image: 'c-compiler', file: 'code.c', compileCmd: ['gcc', '-O2', '-o', '/app/code', '/app/code.c', '-lm'], runCmd: ['/app/code'], artifacts: ['code'], baselineCode: 'int main(void){return 0;}' },
    cpp: { image: 'cpp-compiler', file: 'code.cpp', compileCmd: ['g++', '-O2', '-std=c++17', '-o', '/app/code', '/app/code.cpp'], runCmd: ['/app/code'], artifacts: ['code'], baselineCode: 'int main(){return 0;}' },
    java: { image: 'java-compiler', file: 'Solution.java', compileCmd: ['javac', '-d', '/app', '/app/Solution.java'], runCmd: ['java', '-XX:+UseSerialGC', '-Xss64m', '-cp', '/app', 'Solution'], artifacts: '*.class', baselineCode: 'public class Solution { public static void main(String[] a) {} }' },
    python: { image: 'python-compiler', file: 'code.py', compileCmd: null, runCmd: ['python', '/app/code.py'], baselineCode: 'pass' },
    php: { image: 'php-compiler', file: 'code.php', compileCmd: null, runCmd: ['php', '/app/code.php'], baselineCode: '<?php' },
    ruby: { image: 'ruby-compiler', file: 'code.rb', compileCmd: null, runCmd: ['ruby', '/app/code.rb'], baselineCode: '' },
    go: { image: 'go-compiler', file: 'code.go', compileCmd: ['go', 'build', '-o', '/app/code', '/app/code.go'], runCmd: ['/app/code'], artifacts: ['code'], baselineCode: 'package main\nfunc main() {}' },
};

/**
 * The Java class to run: the public top-level class (javac needs the file named after it), else the
 * class that declares main, else Solution. Comments, strings and char literals are ignored.
 */
const javaMainClass = (code) => {
    const src = String(code ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/g, ' ');
    const pub = src.match(/\bpublic\s+(?:(?:final|abstract|strictfp)\s+)*class\s+([A-Za-z_$][\w$]*)/);
    if (pub) return pub[1];
    const mainAt = src.search(/\bstatic\s+void\s+main\s*\(/);
    let name = null;
    if (mainAt >= 0) {
        const re = /\bclass\s+([A-Za-z_$][\w$]*)/g;
        let m;
        while ((m = re.exec(src)) && m.index < mainAt) name = m[1];
    }
    return name || 'Solution';
};

/** languageConfig for one program: Java file and run class follow the class the code declares (Main, Codechef, ...). */
const configForCode = (language, code) => {
    const config = languageConfig[language];
    if (language !== 'java' || !config) return config;
    const name = javaMainClass(code);
    if (name === 'Solution') return config;
    return {
        ...config,
        file: `${name}.java`,
        compileCmd: ['javac', '-d', '/app', `/app/${name}.java`],
        runCmd: [...config.runCmd.slice(0, -1), name],
    };
};

const intEnv = (name, fallback) => {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const floatEnv = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const JUDGE_TEMP_ROOT = process.env.JUDGE_TEMP_DIR || path.join(os.tmpdir(), 'algosutra-judge');
const JUDGE_CACHE_ROOT = process.env.JUDGE_CACHE_DIR || path.join(os.tmpdir(), 'algosutra-judge-cache');
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TEST_CASES = 200;
const MAX_REPEATS = 10;
const COMPILE_BUDGET_MS = intEnv('JUDGE_COMPILE_BUDGET_MS', 20_000);
const HARD_DEADLINE_CAP_MS = intEnv('JUDGE_MAX_RUN_MS', 180_000) || 180_000;
/** Wall-clock cap per test = factor x time limit + 1 s (covers a busy CPU; CPU time decides TLE). */
const WALL_FACTOR = floatEnv('JUDGE_WALL_FACTOR', 3);
const COMPILE_CACHE_ON = process.env.JUDGE_COMPILE_CACHE !== '0';
const COMPILE_CACHE_MAX_ENTRIES = intEnv('JUDGE_COMPILE_CACHE_ENTRIES', 400);
const COMPILE_CACHE_MAX_BYTES = intEnv('JUDGE_COMPILE_CACHE_MB', 256) * 1024 * 1024;
/**
 * Container memory while compiling (g++ with <bits/stdc++.h> needs ~150-300 MB). The question's
 * limit still applies to each test: its measured peak decides MLE.
 */
const COMPILE_MEMORY_MB = intEnv('JUDGE_COMPILE_MEMORY_MB', 512);
/** Lowest per-test memory limit per language (a JVM alone takes ~40-60 MB). */
const MIN_MEMORY_MB = { java: 256 };
/** Inputs at least this large (all tests together) go through the read-only tests cache. */
const TESTS_CACHE_MIN_BYTES = intEnv('JUDGE_TESTS_CACHE_MIN_KB', 32) * 1024;
const TESTS_CACHE_MAX_BYTES = intEnv('JUDGE_TESTS_CACHE_MB', 512) * 1024 * 1024;
const WATCH_INTERVAL_MS = 40;

const CHECKER_TYPES = ['exact', 'token', 'float', 'ignoreCase', 'custom'];
const DEFAULT_FLOAT_TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------
// Container-side scripts
// ---------------------------------------------------------------------------

/**
 * Runner. Arguments:
 *   <cases> <repeats> <cpuSeconds> <wallSeconds> <testDir> <handshake 0|1> [compile args...] --RUN-- <run args...>
 * Writes per case: _out_R_I.txt, _err_R_I.txt, _meta_R_I.txt
 *   "<exit> <startNs> <endNs> <peakKb> <userSec> <sysSec>"
 * Compile failures write _compile.txt and exit 2. With handshake=1 a successful compile writes
 * _compiled and waits (max 10 s) for the host to create _go before running anything.
 */
const RUN_SENTINEL = '--RUN--';
const RUNNER_SCRIPT = String.raw`#!/bin/sh
set +e
CASES="$1"; REPEATS="$2"; CPUS="$3"; WALL="$4"; TESTDIR="$5"; HANDSHAKE="$6"; shift 6
export HOME=/tmp GOCACHE=/tmp/gocache GOPATH=/tmp/go GOTMPDIR=/tmp TMPDIR=/tmp
# largest VmHWM among children of $1 (fallback when /usr/bin/time is missing). Builtins only.
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
  # Go: link (not copy) the image's prebuilt std cache, so 146 MB never lands in the memory-backed /tmp.
  if [ -d /opt/gocache ] && [ ! -d /tmp/gocache ]; then
    cp -rs /opt/gocache /tmp/gocache 2>/dev/null && rm -f /tmp/gocache/trim.txt || cp -r /opt/gocache /tmp/gocache 2>/dev/null
  fi
  eval "timeout -s KILL 20 $COMPILE_ARGS" > /app/_compile.txt 2>&1
  CS=$?
  if [ $CS -ne 0 ]; then echo "compile_failed $CS" > /app/_status.txt; exit 2; fi
  if [ "$HANDSHAKE" = "1" ]; then
    : > /app/_compiled
    n=0
    while [ ! -f /app/_go ] && [ $n -lt 500 ]; do sleep 0.02; n=$((n+1)); done
  fi
fi
HAVE_TIME=0; [ -x /usr/bin/time ] && HAVE_TIME=1
r=0
while [ $r -lt "$REPEATS" ]; do
  i=0
  while [ $i -lt "$CASES" ]; do
    IN="$TESTDIR/_in_$i.txt"; OUT="/app/_out_$r"_"$i.txt"; ERR="/app/_err_$r"_"$i.txt"; META="/app/_meta_$r"_"$i.txt"
    U=""; S=""
    START=$(date +%s%N 2>/dev/null || echo 0)
    if [ $HAVE_TIME -eq 1 ]; then
      /usr/bin/time -f "%e %U %S %M" -o /tmp/_m timeout -s KILL "$WALL" sh -c 'ulimit -t '"$CPUS"' 2>/dev/null; exec "$@"' judged "$@" < "$IN" > "$OUT" 2> "$ERR"
      STATUS=$?
      LINE=$(tail -n 1 /tmp/_m 2>/dev/null)
      U=$(echo "$LINE" | awk '{print $2}'); S=$(echo "$LINE" | awk '{print $3}'); MEM=$(echo "$LINE" | awk '{print $4}' | tr -dc '0-9')
    else
      timeout -s KILL "$WALL" "$@" < "$IN" > "$OUT" 2> "$ERR" &
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
    [ -n "$U" ] || U=-1
    [ -n "$S" ] || S=-1
    echo "$STATUS $START $END $MEM $U $S" > "$META"
    i=$((i+1))
  done
  r=$((r+1))
done
echo "done" > /app/_status.txt
exit 0
`;

/**
 * Custom checker runner. Arguments: <list of case indexes "0 2 5"> <testDir> <wallSeconds> [compile...] --RUN-- <run...>
 * For each case: <run...> <input> <expected> <contestant output>. Writes _cst_I.txt (exit code) and
 * _cout_I.txt (what the checker printed); see runCustomChecker for the verdict contract.
 */
const CHECKER_SCRIPT = String.raw`#!/bin/sh
set +e
LIST="$1"; TESTDIR="$2"; WALL="$3"; shift 3
export HOME=/tmp GOCACHE=/tmp/gocache GOPATH=/tmp/go GOTMPDIR=/tmp TMPDIR=/tmp
COMPILE_ARGS=""; HAVE_COMPILE=0
while [ $# -gt 0 ] && [ "$1" != "--RUN--" ]; do
  HAVE_COMPILE=1
  ESC=$(printf %s "$1" | sed "s/'/'\\\\''/g")
  COMPILE_ARGS="$COMPILE_ARGS '$ESC'"
  shift
done
[ "$1" = "--RUN--" ] && shift
if [ $HAVE_COMPILE -eq 1 ]; then
  if [ -d /opt/gocache ] && [ ! -d /tmp/gocache ]; then
    cp -rs /opt/gocache /tmp/gocache 2>/dev/null && rm -f /tmp/gocache/trim.txt || cp -r /opt/gocache /tmp/gocache 2>/dev/null
  fi
  eval "timeout -s KILL 20 $COMPILE_ARGS" > /app/_compile.txt 2>&1
  if [ $? -ne 0 ]; then exit 2; fi
fi
for i in $LIST; do
  timeout -s KILL "$WALL" "$@" "$TESTDIR/_in_$i.txt" "/app/_exp_$i.txt" "/app/_sol_$i.txt" > "/app/_cout_$i.txt" 2>&1 < /dev/null
  echo $? > "/app/_cst_$i.txt"
done
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
 * still acceptable) student code:
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

// ---------------------------------------------------------------------------
// Output checkers
// ---------------------------------------------------------------------------

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const tokensOf = (s) => String(s ?? '').split(/\s+/).filter(Boolean);

/** Normalise a question's checker setting (anything unknown means the default exact compare). */
const normalizeChecker = (checker) => {
    const type = CHECKER_TYPES.includes(checker?.type) ? checker.type : 'exact';
    const out = { type };
    if (type === 'float') {
        const tol = Number(checker?.tolerance);
        out.tolerance = Number.isFinite(tol) && tol > 0 && tol < 1 ? tol : DEFAULT_FLOAT_TOLERANCE;
    }
    if (type === 'custom') {
        out.language = supportedLanguages.includes(checker?.language) ? checker.language : null;
        out.code = typeof checker?.code === 'string' ? checker.code : '';
        if (!out.language || !out.code.trim()) return { type: 'exact' };
    }
    return out;
};

/**
 * Built-in comparison of a program's output with the expected output.
 *   exact       line-by-line, ignoring trailing spaces, CRLF and leading/trailing blank lines (default)
 *   ignoreCase  as exact, case-insensitive
 *   token       same whitespace-separated tokens (any spacing / line breaks)
 *   float       as token, numbers equal within an absolute OR relative tolerance
 * Returns { passed, message? }. `custom` is judged by runCustomChecker instead.
 */
const compareOutput = (actual, expected, checker = { type: 'exact' }) => {
    switch (checker.type) {
        case 'ignoreCase':
            return { passed: normalizeOutput(actual).toLowerCase() === normalizeOutput(expected).toLowerCase() };
        case 'token': {
            const a = tokensOf(actual);
            const b = tokensOf(expected);
            return { passed: a.length === b.length && a.every((t, i) => t === b[i]) };
        }
        case 'float': {
            const a = tokensOf(actual);
            const b = tokensOf(expected);
            if (a.length !== b.length) return { passed: false, message: `Expected ${b.length} values, got ${a.length}` };
            const tol = checker.tolerance || DEFAULT_FLOAT_TOLERANCE;
            for (let i = 0; i < b.length; i += 1) {
                if (NUMBER_RE.test(a[i]) && NUMBER_RE.test(b[i])) {
                    const x = Number(a[i]);
                    const y = Number(b[i]);
                    const diff = Math.abs(x - y);
                    if (!(diff <= tol || diff <= tol * Math.abs(y))) {
                        return { passed: false, message: `Value ${i + 1}: expected ${b[i]}, got ${a[i]}` };
                    }
                } else if (a[i] !== b[i]) {
                    return { passed: false, message: `Value ${i + 1}: expected ${b[i]}, got ${a[i]}` };
                }
            }
            return { passed: true };
        }
        default:
            return { passed: normalizeOutput(actual) === normalizeOutput(expected) };
    }
};

/**
 * Checker setting from a question form / API body -> what is stored on the question.
 * Invalid or incomplete input falls back to the default exact compare.
 */
const MAX_CHECKER_CODE = 100 * 1024;
const checkerFromInput = (raw) => {
    if (raw == null || typeof raw !== 'object') return { type: 'exact' };
    const type = CHECKER_TYPES.includes(raw.type) ? raw.type : 'exact';
    if (type === 'float') {
        const tol = Number(raw.tolerance);
        return { type, tolerance: Number.isFinite(tol) && tol > 0 && tol < 1 ? tol : DEFAULT_FLOAT_TOLERANCE };
    }
    if (type === 'custom') {
        const language = supportedLanguages.includes(raw.language) ? raw.language : null;
        const code = typeof raw.code === 'string' ? raw.code.slice(0, MAX_CHECKER_CODE) : '';
        return language && code.trim() ? { type, language, code } : { type: 'exact' };
    }
    return { type };
};

// ---------------------------------------------------------------------------
// File / cache helpers
// ---------------------------------------------------------------------------

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

const exists = (p) => fs.access(p).then(() => true, () => false);
const sha256 = (...parts) => {
    const h = crypto.createHash('sha256');
    for (const p of parts) {
        h.update(String(p.length));
        h.update(':');
        h.update(p);
    }
    return h.digest('hex');
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
    wallMs: null,
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

/** Image id per language image (part of the compile-cache key: a rebuilt image never reuses old binaries). */
const imageIds = new Map();
const IMAGE_ID_TTL_MS = 10 * 60 * 1000;
const imageIdOf = async (image) => {
    const hit = imageIds.get(image);
    if (hit && Date.now() - hit.at < IMAGE_ID_TTL_MS) return hit.id;
    try {
        const info = await docker.getImage(image).inspect();
        imageIds.set(image, { id: info.Id, at: Date.now() });
        return info.Id;
    } catch {
        return null;
    }
};

const pruneState = { bin: 0, tests: 0 };
/** Keep a cache directory under its entry / byte budget (oldest-used first). Throttled to once a minute. */
const pruneCache = async (kind, maxEntries, maxBytes) => {
    if (Date.now() - pruneState[kind] < 60_000) return;
    pruneState[kind] = Date.now();
    const dir = path.join(JUDGE_CACHE_ROOT, kind);
    try {
        const names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.'));
        const entries = [];
        for (const name of names) {
            const p = path.join(dir, name);
            try {
                const st = await fs.stat(p);
                let bytes = 0;
                for (const f of await fs.readdir(p)) bytes += (await fs.stat(path.join(p, f)).catch(() => ({ size: 0 }))).size;
                entries.push({ p, used: st.mtimeMs, bytes });
            } catch {
                /* vanished */
            }
        }
        entries.sort((a, b) => b.used - a.used);
        let total = 0;
        for (let i = 0; i < entries.length; i += 1) {
            total += entries[i].bytes;
            if (i >= maxEntries || total > maxBytes) await fs.rm(entries[i].p, { recursive: true, force: true }).catch(() => {});
        }
    } catch {
        /* cache dir not created yet */
    }
};

const touch = (p) => {
    const now = new Date();
    return fs.utimes(p, now, now).catch(() => {});
};

/** Artifact file names a successful compile left in `dir`. */
const listArtifacts = async (config, dir) => {
    if (config.artifacts === '*.class') return (await fs.readdir(dir)).filter((f) => f.endsWith('.class'));
    const out = [];
    for (const f of config.artifacts || []) if (await exists(path.join(dir, f))) out.push(f);
    return out;
};

const compileCacheKey = async (language, config, code) => {
    if (!COMPILE_CACHE_ON || !config.compileCmd) return null;
    const imageId = await imageIdOf(config.image);
    if (!imageId) return null;
    return sha256('bin-v1', language, imageId, config.compileCmd.join(' '), String(code ?? ''));
};

/** { ok: true, files } | { ok: false, message } | null */
const readCompileCache = async (key) => {
    if (!key) return null;
    const dir = path.join(JUDGE_CACHE_ROOT, 'bin', key);
    try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, '_meta.json'), 'utf8'));
        await touch(dir);
        return { ...meta, dir };
    } catch {
        return null;
    }
};

const writeCompileCache = async (key, meta, fromDir) => {
    if (!key) return;
    const root = path.join(JUDGE_CACHE_ROOT, 'bin');
    const staging = path.join(root, `.tmp-${key}-${process.pid}-${Date.now()}`);
    try {
        await fs.mkdir(staging, { recursive: true });
        for (const f of meta.files || []) await fs.copyFile(path.join(fromDir, f), path.join(staging, f));
        await fs.writeFile(path.join(staging, '_meta.json'), JSON.stringify(meta));
        await fs.rename(staging, path.join(root, key)).catch(async () => {
            await fs.rm(staging, { recursive: true, force: true }); // another run cached the same program first
        });
        pruneCache('bin', COMPILE_CACHE_MAX_ENTRIES, COMPILE_CACHE_MAX_BYTES);
    } catch {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * Large inputs live in a content-addressed directory that is bind-mounted read-only at /tests,
 * so a 3 MB test set is written once instead of on every Run / Submit.
 * Returns the host directory, or null when the inputs are small (written into the work dir).
 */
const ensureTestsDir = async (payloads) => {
    const total = payloads.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0);
    if (total < TESTS_CACHE_MIN_BYTES) return null;
    const key = sha256('tests-v1', ...payloads);
    const root = path.join(JUDGE_CACHE_ROOT, 'tests');
    const dir = path.join(root, key);
    if (await exists(path.join(dir, '_done'))) {
        await touch(dir);
        return dir;
    }
    const staging = path.join(root, `.tmp-${key}-${process.pid}-${Date.now()}`);
    await fs.mkdir(staging, { recursive: true });
    await Promise.all(payloads.map((p, i) => fs.writeFile(path.join(staging, `_in_${i}.txt`), p, 'utf8')));
    await fs.writeFile(path.join(staging, '_done'), '');
    await fs.chmod(staging, 0o755).catch(() => {});
    await fs.rename(staging, dir).catch(async () => {
        await fs.rm(staging, { recursive: true, force: true });
    });
    pruneCache('tests', 10_000, TESTS_CACHE_MAX_BYTES);
    return dir;
};

// ---------------------------------------------------------------------------
// Language start-up baselines (subtracted from measured CPU time)
// ---------------------------------------------------------------------------

const baselines = new Map(); // language -> { ms, at } | { pending: Promise }
const BASELINE_RETRY_MS = 5 * 60 * 1000;

const measureBaseline = async (language) => {
    const config = languageConfig[language];
    const samples = [];
    for (let k = 0; k < 2; k += 1) {
        const rows = await runJudge({
            language,
            code: config.baselineCode,
            tests: [{ input: '', expectedOutput: '', isPublic: true }],
            timeLimit: 5,
            memoryLimit: 256,
            calibration: true,
        });
        const cpu = rows[0]?.cpuRawMs;
        if (Number.isFinite(cpu)) samples.push(cpu);
    }
    return samples.length ? Math.min(...samples) : 0;
};

/** Start-up CPU cost of a language (ms). Measured once per process; 0 until known or if it fails. */
const getBaselineMs = async (language) => {
    const entry = baselines.get(language);
    if (entry?.ms != null && (entry.ok || Date.now() - entry.at < BASELINE_RETRY_MS)) return entry.ms;
    if (entry?.pending) return entry.pending;
    const pending = measureBaseline(language)
        .then((ms) => {
            baselines.set(language, { ms, ok: true, at: Date.now() });
            return ms;
        })
        .catch(() => {
            baselines.set(language, { ms: 0, ok: false, at: Date.now() });
            return 0;
        });
    baselines.set(language, { pending });
    return pending;
};

/** Warm the baselines in the background (call at worker start). */
const calibrateLanguages = async (languages = supportedLanguages) => {
    for (const lang of languages) {
        await getBaselineMs(lang).catch(() => 0);
    }
    return Object.fromEntries([...baselines.entries()].map(([k, v]) => [k, v.ms ?? null]));
};

const getBaselines = () => Object.fromEntries([...baselines.entries()].map(([k, v]) => [k, v.ms ?? null]));

// ---------------------------------------------------------------------------
// Container plumbing
// ---------------------------------------------------------------------------

const createContainer = async (language, config, { cmd, binds, memMb }) => {
    try {
        return await docker.createContainer({
            Image: config.image,
            Cmd: cmd,
            WorkingDir: '/app',
            Env: ['HOME=/tmp', 'GOCACHE=/tmp/gocache', 'GOPATH=/tmp/go', 'TMPDIR=/tmp'],
            AttachStdout: false,
            AttachStderr: false,
            Tty: false,
            NetworkDisabled: true,
            HostConfig: {
                Binds: binds,
                NetworkMode: 'none',
                Memory: memMb * 1024 * 1024,
                MemorySwap: memMb * 1024 * 1024, // no swap
                CpuPeriod: 100000,
                CpuQuota: 100000, // at most one CPU per submission
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
        if (err?.statusCode === 404 || /no such image/i.test(err?.message || '')) throw imageMissingError(language, config);
        throw err;
    }
};

/**
 * Start a container and wait for it, calling `onTick()` every WATCH_INTERVAL_MS while it runs.
 * onTick may return 'stop' to kill the container early. Always force-removes the container.
 */
const runContainer = async (container, deadlineMs, onTick) => {
    let deadlineHit = false;
    let stopped = false;
    try {
        await container.start();
        const waitPromise = container.wait();
        let finished = null;
        waitPromise.then((v) => (finished = v ?? { StatusCode: -1 }), () => (finished = { StatusCode: -1 }));
        const started = Date.now();
        while (!finished) {
            await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
            if (finished) break;
            if (Date.now() - started > deadlineMs) {
                deadlineHit = true;
                await container.kill().catch(() => {});
                await waitPromise.catch(() => {});
                break;
            }
            if (onTick && !stopped) {
                const verdict = await onTick().catch(() => null);
                if (verdict === 'stop') {
                    stopped = true;
                    await container.kill().catch(() => {});
                    await waitPromise.catch(() => {});
                    break;
                }
            }
        }
        if (onTick && !stopped && !deadlineHit) await onTick().catch(() => null); // last look (handshake files etc.)
        return { exitCode: finished?.StatusCode ?? -1, deadlineHit, stopped };
    } finally {
        await container.remove({ force: true, v: true }).catch(() => {});
    }
};

// ---------------------------------------------------------------------------
// Per-case evaluation
// ---------------------------------------------------------------------------

const parseMeta = (meta) => {
    if (!meta) return null;
    const parts = meta.trim().split(/\s+/);
    if (parts.length < 4) return null;
    const [statusStr, startNs, endNs, memKbStr, u, s] = parts;
    const status = Number.parseInt(statusStr, 10);
    if (!Number.isFinite(status)) return null;
    const wallMs = startNs && endNs && startNs !== '0' && endNs !== '0' ? Number(BigInt(endNs) - BigInt(startNs)) / 1e6 : null;
    const memoryKb = Number.parseInt(memKbStr, 10) > 0 ? Number.parseInt(memKbStr, 10) : null;
    const user = Number(u);
    const sys = Number(s);
    const cpuRawMs = Number.isFinite(user) && Number.isFinite(sys) && user >= 0 && sys >= 0 ? (user + sys) * 1000 : null;
    return { status, wallMs, memoryKb, cpuRawMs };
};

/**
 * Turn one case's files into a result row.
 * ctx: { tlSec, memMb, wallSec, baselineMs, checker }
 */
const evaluateCase = (test, parsed, stdout, stderrRaw, ctx) => {
    const { status, wallMs, memoryKb, cpuRawMs } = parsed;
    const stderr = (stderrRaw ?? '').trim();
    const tlMs = ctx.tlSec * 1000;
    const cpuMs = cpuRawMs != null ? Math.max(0, cpuRawMs - (ctx.baselineMs || 0)) : wallMs;
    const killed = status === 137 || status === 124 || status === 143 || status === 152;
    const cpuOver = cpuMs != null && cpuMs > tlMs;
    const wallOver = wallMs != null && wallMs >= ctx.wallSec * 1000 - 50;
    const overMemory = memoryKb != null && memoryKb >= ctx.memMb * 1024 * 0.97;
    const memText = /out of memory|OutOfMemoryError|MemoryError|bad_alloc|Cannot allocate memory/i.test(stderr);

    let isTLE = false;
    let isMLE = false;
    let wallOnly = false;
    if (cpuOver || status === 152) isTLE = true;
    else if (killed && wallOver) {
        isTLE = true;
        wallOnly = true;
    } else if (overMemory || memText || status === 137) isMLE = true; // SIGKILL without a time overrun = OOM killer

    let passed = false;
    let checkMessage = null;
    if (status === 0 && !isTLE && !isMLE && ctx.checker.type !== 'custom') {
        const verdict = compareOutput(stdout, test.expectedOutput, ctx.checker);
        passed = verdict.passed;
        checkMessage = verdict.message || null;
    }

    let errorText = null;
    if (isTLE) errorText = wallOnly ? `Time limit exceeded (${ctx.tlSec}s wall clock: the program waited or slept)` : `Time limit exceeded (${ctx.tlSec}s)`;
    else if (isMLE) errorText = `Memory limit exceeded (${ctx.memMb} MB)`;
    else if (status !== 0) errorText = stderr || `Process exited with code ${status}`;
    else if (stderr) errorText = stderr;
    else if (!passed && checkMessage) errorText = checkMessage;

    const resultStatus = passed
        ? 'accepted'
        : isTLE ? 'tle' : isMLE ? 'mle' : status !== 0 ? 'runtime_error' : ctx.checker.type === 'custom' ? 'pending_check' : 'wrong_answer';

    return resultRow(test, {
        output: String(stdout ?? '').trimEnd(),
        passed,
        error: errorText,
        status: resultStatus,
        isTLE,
        isMLE,
        timeMs: cpuMs == null ? null : roundTimeMs(Math.min(cpuMs, tlMs)),
        wallMs: wallMs == null ? null : roundTimeMs(wallMs),
        memoryKb,
        cpuRawMs: cpuRawMs == null ? null : roundTimeMs(cpuRawMs),
    });
};

const skippedRow = (test) => resultRow(test, { status: 'skipped', error: 'Not run: an earlier test failed' });

// ---------------------------------------------------------------------------
// Custom checker
// ---------------------------------------------------------------------------

/**
 * Judge outputs with a teacher-written checker program. Mutates `rows` (only rows whose program
 * exited normally are checked). Checker contract:
 *   argv = <input file> <expected output file> <student output file>
 *   print "OK" (or "AC") as the first word  -> accepted
 *   print anything else, e.g. "WA reason"    -> wrong answer, the line is shown as the reason
 *   exit with a non-zero code (crash)        -> checker error (never counted as accepted)
 */
const runCustomChecker = async (checker, cases, rows, payloads, testsDir, outputs) => {
    const indexes = rows.map((r, i) => (r.status === 'pending_check' ? i : -1)).filter((i) => i >= 0);
    if (!indexes.length) return;
    const config = configForCode(checker.language, checker.code);
    const markAll = (status, error) => {
        for (const i of indexes) Object.assign(rows[i], { status, passed: false, error });
    };
    if (!config) return markAll('checker_error', 'Checker language is not supported');

    const tempDir = await fs.mkdtemp(path.join(JUDGE_TEMP_ROOT, 'chk-'));
    await fs.chmod(tempDir, 0o777).catch(() => {});
    try {
        const writes = [
            fs.writeFile(path.join(tempDir, config.file), checker.code, 'utf8'),
            fs.writeFile(path.join(tempDir, '_check.sh'), CHECKER_SCRIPT, { encoding: 'utf8', mode: 0o755 }),
        ];
        for (const i of indexes) {
            writes.push(fs.writeFile(path.join(tempDir, `_exp_${i}.txt`), String(cases[i].expectedOutput ?? ''), 'utf8'));
            writes.push(fs.writeFile(path.join(tempDir, `_sol_${i}.txt`), outputs[i] ?? '', 'utf8'));
            if (!testsDir) writes.push(fs.writeFile(path.join(tempDir, `_in_${i}.txt`), payloads[i], 'utf8'));
        }
        await Promise.all(writes);

        // Reuse a cached compile of the checker when there is one.
        const key = await compileCacheKey(checker.language, config, checker.code);
        const cached = await readCompileCache(key);
        let compileArgs = config.compileCmd || [];
        if (cached?.ok) {
            for (const f of cached.files) await fs.copyFile(path.join(cached.dir, f), path.join(tempDir, f));
            await Promise.all(cached.files.map((f) => fs.chmod(path.join(tempDir, f), 0o755).catch(() => {})));
            compileArgs = [];
        } else if (cached && !cached.ok) {
            return markAll('checker_error', `Checker does not compile: ${cached.message}`.slice(0, 500));
        }

        const cmd = ['/bin/sh', '/app/_check.sh', indexes.join(' '), testsDir ? '/tests' : '/app', '10', ...compileArgs, RUN_SENTINEL, ...config.runCmd];
        const binds = [`${tempDir}:/app:rw`, ...(testsDir ? [`${testsDir}:/tests:ro`] : [])];
        const container = await createContainer(checker.language, config, { cmd, binds, memMb: 512 });
        const { exitCode } = await runContainer(container, COMPILE_BUDGET_MS + indexes.length * 10_400 + 5_000);
        if (exitCode === 2) {
            const msg = ((await readCapped(path.join(tempDir, '_compile.txt'), MAX_STDERR_BYTES)) || 'Compilation failed').trim();
            if (key) await writeCompileCache(key, { ok: false, message: msg }, tempDir);
            return markAll('checker_error', `Checker does not compile: ${msg}`.slice(0, 500));
        }
        if (key && !cached && compileArgs.length) {
            const files = await listArtifacts(config, tempDir);
            if (files.length) await writeCompileCache(key, { ok: true, files }, tempDir);
        }
        for (const i of indexes) {
            const st = Number.parseInt((await readCapped(path.join(tempDir, `_cst_${i}.txt`), 64)) ?? '', 10);
            const msg = ((await readCapped(path.join(tempDir, `_cout_${i}.txt`), 2048)) || '').trim().split('\n')[0].slice(0, 300);
            const word = (msg.split(/\s+/)[0] || '').toUpperCase();
            if (st === 0 && (word === 'OK' || word === 'AC' || word === 'ACCEPTED')) {
                Object.assign(rows[i], { status: 'accepted', passed: true, error: null });
            } else if (st === 0) {
                const reason = msg.replace(/^(WA|WRONG(_ANSWER)?)\b[:\s-]*/i, '').trim();
                Object.assign(rows[i], { status: 'wrong_answer', passed: false, error: reason || 'Wrong answer' });
            } else {
                Object.assign(rows[i], { status: 'checker_error', passed: false, error: `Checker error${Number.isFinite(st) ? ` (exit ${st})` : ''}${msg ? `: ${msg}` : ''}` });
            }
        }
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
};

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * @param {object} spec
 * @param {string} spec.language
 * @param {string} spec.code                 final program (driver / template already merged)
 * @param {Array<{input:string, expectedOutput:string, isPublic?:boolean}>} spec.tests
 * @param {number} spec.timeLimit            CPU seconds per test (0.1..10)
 * @param {number} spec.memoryLimit          MB per test (16..2048; Java at least 256)
 * @param {boolean} [spec.wrapStdin]         wrap bare JSON arrays for LeetCode-style drivers
 * @param {number} [spec.repeats]            teacher benchmark: run every test N times
 * @param {Array}  [spec.repeatSummaries]    filled with one summary per repeat round
 * @param {boolean} [spec.stopOnFirstFail]   stop at the first failing test (rest = 'skipped')
 * @param {object} [spec.checker]            { type: exact|token|float|ignoreCase|custom, tolerance, language, code }
 * @returns {Promise<Array>} one result row per test case (last repeat round)
 */
const runJudge = async (spec) => {
    const { language } = spec;
    const config = configForCode(language, spec.code);
    if (!config) throw new Error(`Unsupported language: ${language}`);

    const cases = Array.isArray(spec.tests) ? spec.tests.slice(0, MAX_TEST_CASES) : [];
    if (cases.length === 0) return [];

    const code = String(spec.code ?? '');
    const tlSec = clamp(Number(spec.timeLimit) || 2, 0.1, 10);
    const memMb = clamp(Math.max(Math.round(Number(spec.memoryLimit) || 256), MIN_MEMORY_MB[language] || 0), 16, 2048);
    let repeats = Number.parseInt(spec.repeats, 10);
    if (!Number.isFinite(repeats) || repeats < 1) repeats = 1;
    repeats = Math.min(MAX_REPEATS, repeats);
    const checker = normalizeChecker(spec.checker);
    const stopOnFirstFail = !!spec.stopOnFirstFail && repeats === 1 && checker.type !== 'custom';
    const baselineMs = spec.calibration ? 0 : await getBaselineMs(language);
    const baselineSec = baselineMs / 1000;

    const wallSec = Math.min(60, Math.ceil((tlSec * WALL_FACTOR + 1 + baselineSec) * 10) / 10);
    // RLIMIT_CPU is whole seconds and counts start-up too; the measured time decides TLE precisely.
    const cpuSec = Math.max(1, Math.ceil(tlSec + baselineSec + 0.5));
    const ctx = { tlSec, memMb, wallSec, baselineMs, checker };

    const payloads = cases.map((t) => {
        const raw = String(t.input ?? '');
        return spec.wrapStdin ? normalizeLeetcodeStyleStdin(raw) : raw;
    });

    // ---- compile cache
    const cacheKey = await compileCacheKey(language, config, code);
    const cached = await readCompileCache(cacheKey);
    if (cached && cached.ok === false) {
        const msg = cached.message || 'Compilation failed';
        return cases.map((test) => resultRow(test, { output: `Compilation Error: ${msg}`, error: msg, status: 'compile_error' }));
    }

    const deadlineMs = Math.min(
        HARD_DEADLINE_CAP_MS,
        (config.compileCmd && !cached ? COMPILE_BUDGET_MS : 0) + repeats * cases.length * (wallSec * 1000 + 400) + 5_000
    );

    await fs.mkdir(JUDGE_TEMP_ROOT, { recursive: true });
    const testsDir = await ensureTestsDir(payloads).catch(() => null);
    const tempDir = await fs.mkdtemp(path.join(JUDGE_TEMP_ROOT, 'run-'));
    // The image user (appuser) must be able to write results into the bind mount.
    await fs.chmod(tempDir, 0o777).catch(() => {});

    try {
        const writes = [
            fs.writeFile(path.join(tempDir, config.file), code, 'utf8'),
            fs.writeFile(path.join(tempDir, '_run.sh'), RUNNER_SCRIPT, { encoding: 'utf8', mode: 0o755 }),
        ];
        if (!testsDir) payloads.forEach((p, i) => writes.push(fs.writeFile(path.join(tempDir, `_in_${i}.txt`), p, 'utf8')));
        if (cached?.ok) {
            for (const f of cached.files) writes.push(fs.copyFile(path.join(cached.dir, f), path.join(tempDir, f)));
        }
        await Promise.all(writes);
        if (cached?.ok) await Promise.all(cached.files.map((f) => fs.chmod(path.join(tempDir, f), 0o755).catch(() => {})));

        const compiling = !!config.compileCmd && !cached;
        const handshake = compiling && !!cacheKey;
        const cmd = [
            '/bin/sh', '/app/_run.sh',
            String(cases.length), String(repeats), String(cpuSec), String(wallSec), testsDir ? '/tests' : '/app', handshake ? '1' : '0',
            ...(compiling ? config.compileCmd : []),
            RUN_SENTINEL,
            ...config.runCmd,
        ];
        const binds = [`${tempDir}:/app:rw`, ...(testsDir ? [`${testsDir}:/tests:ro`] : [])];

        // Compiling gets its own headroom; tests are still held to memMb by their measured peak (evaluateCase).
        const containerMb = compiling ? Math.max(memMb, COMPILE_MEMORY_MB) : memMb;
        const container = await createContainer(language, config, { cmd, binds, memMb: containerMb });

        // ---- watch the work dir while the container runs
        let handshakeDone = !handshake;
        const early = new Map(); // case index -> row (stopOnFirstFail, round 0)
        let nextCase = 0;
        const onTick = async () => {
            if (!handshakeDone && (await exists(path.join(tempDir, '_compiled')))) {
                handshakeDone = true;
                // Artifacts are copied before any student code has run, so the cache can't be tampered with.
                const files = await listArtifacts(config, tempDir).catch(() => []);
                if (files.length) await writeCompileCache(cacheKey, { ok: true, files }, tempDir);
                await fs.writeFile(path.join(tempDir, '_go'), '');
            }
            if (!stopOnFirstFail || !handshakeDone) return null;
            while (nextCase < cases.length) {
                const parsed = parseMeta(await readCapped(path.join(tempDir, `_meta_0_${nextCase}.txt`), 256));
                if (!parsed) return null; // not finished yet
                const [out, err] = await Promise.all([
                    readCapped(path.join(tempDir, `_out_0_${nextCase}.txt`), MAX_STDOUT_BYTES),
                    readCapped(path.join(tempDir, `_err_0_${nextCase}.txt`), MAX_STDERR_BYTES),
                ]);
                const row = evaluateCase(cases[nextCase], parsed, out ?? '', err, ctx);
                early.set(nextCase, row);
                nextCase += 1;
                if (!row.passed) return 'stop';
            }
            return null;
        };

        const { exitCode, deadlineHit, stopped } = await runContainer(container, deadlineMs, onTick);

        // Compile failure
        if (exitCode === 2 && !stopped && !deadlineHit && (await exists(path.join(tempDir, '_compile.txt')))) {
            const compileOut = (await readCapped(path.join(tempDir, '_compile.txt'), MAX_STDERR_BYTES)) || 'Compilation failed';
            const msg = compileOut.trim() || 'Compilation failed';
            if (cacheKey) await writeCompileCache(cacheKey, { ok: false, message: msg, files: [] }, tempDir);
            return cases.map((test) => resultRow(test, { output: `Compilation Error: ${msg}`, error: msg, status: 'compile_error' }));
        }

        if (stopped) {
            return cases.map((test, i) => early.get(i) || skippedRow(test));
        }

        const results = [];
        const lastOutputs = [];
        for (let r = 0; r < repeats; r += 1) {
            const roundResults = [];
            for (let i = 0; i < cases.length; i += 1) {
                const test = cases[i];
                if (r === 0 && early.has(i)) {
                    roundResults.push(early.get(i));
                    if (repeats === 1) lastOutputs[i] = (await readCapped(path.join(tempDir, `_out_0_${i}.txt`), MAX_STDOUT_BYTES)) ?? '';
                    continue;
                }
                const [out, err, meta] = await Promise.all([
                    readCapped(path.join(tempDir, `_out_${r}_${i}.txt`), MAX_STDOUT_BYTES),
                    readCapped(path.join(tempDir, `_err_${r}_${i}.txt`), MAX_STDERR_BYTES),
                    readCapped(path.join(tempDir, `_meta_${r}_${i}.txt`), 256),
                ]);
                const parsed = parseMeta(meta);
                if (!parsed) {
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
                if (r === repeats - 1) lastOutputs[i] = out ?? '';
                roundResults.push(evaluateCase(test, parsed, out ?? '', err, ctx));
            }
            if (Array.isArray(spec.repeatSummaries)) {
                const summary = summarizeRunCaseMetrics(roundResults);
                spec.repeatSummaries.push({
                    run: r + 1,
                    maxTimeMs: summary.maxTimeMs,
                    maxMemoryKb: summary.maxMemoryKb,
                    passed: roundResults.every((row) => row.passed),
                });
            }
            results.length = 0;
            results.push(...roundResults);
        }

        if (checker.type === 'custom') {
            await runCustomChecker(checker, cases, results, payloads, testsDir, lastOutputs);
        }
        return results;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * Legacy positional signature, gated by the in-process semaphore (scripts / tools).
 * Judge jobs call runJudge directly: the job worker owns concurrency.
 */
const runJudgeDirect = (language, code, testCases, timeLimit, memoryLimit, options = {}) =>
    runWithSlot(() =>
        runJudge({
            language,
            code,
            tests: testCases,
            timeLimit,
            memoryLimit,
            wrapStdin: !!options.wrapBareArrayStdinForDriver,
            repeats: options.repeats,
            repeatSummaries: options.repeatSummaries,
            stopOnFirstFail: options.stopOnFirstFail,
            checker: options.checker,
        })
    );

/** Best-effort cleanup of leftover judge containers/dirs from a previous crash. Call at boot. */
const cleanupStaleJudgeArtifacts = async () => {
    try {
        const images = new Set(Object.values(languageConfig).map((c) => c.image));
        const containers = await docker.listContainers({ all: true });
        await Promise.all(
            containers
                .filter((c) => images.has(String(c.Image).replace(/:latest$/, '')) && /_run\.sh|_check\.sh/.test(c.Command || ''))
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
    for (const kind of ['bin', 'tests']) {
        try {
            const root = path.join(JUDGE_CACHE_ROOT, kind);
            const names = (await fs.readdir(root)).filter((n) => n.startsWith('.tmp-'));
            await Promise.all(names.map((n) => fs.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {})));
        } catch {
            /* no cache yet */
        }
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

/**
 * Judge results as stored on Submission / ExamAttempt. A test's full stdin and expected output
 * already live on the question; copying multi-MB test data into every submission bloats MongoDB
 * and can exceed the 16 MB document limit, so large values keep only a preview.
 */
const STORED_TEXT_CAP = 4096;
const capStoredText = (value) =>
    typeof value === 'string' && value.length > STORED_TEXT_CAP
        ? `${value.slice(0, STORED_TEXT_CAP)}\n... [truncated: ${value.length} characters]`
        : value;
const compactTestResultsForStorage = (results) =>
    (Array.isArray(results) ? results : []).map((r) => ({
        ...r,
        ...('input' in r ? { input: capStoredText(r.input) } : {}),
        ...('expected' in r ? { expected: capStoredText(r.expected) } : {}),
        ...('output' in r ? { output: capStoredText(r.output) } : {}),
    }));

module.exports = {
    CHECKER_TYPES,
    checkerFromInput,
    compactTestResultsForStorage,
    compareOutput,
    normalizeChecker,
    runJudge,
    runJudgeDirect,
    calibrateLanguages,
    getBaselines,
    supportedLanguages,
    languageConfig,
    javaMainClass,
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
