#!/usr/bin/env node
'use strict';

/**
 * Live Run/Submit load test against a DEPLOYED AlgoSutra API (run it ON the API server).
 *
 *   node scripts/live-judge-test.js --yes                       # heavy question (default)
 *   QUESTION=echo node scripts/live-judge-test.js --yes         # tiny echo question instead
 *   LANG_UNDER_TEST=cpp node scripts/live-judge-test.js --yes   # ramp in another language
 *   STUDENTS=60 RUN_LEVELS=1,3,10,30,60 SUBMIT_LEVELS=3,10,30 SLOW_LEVELS=10 node scripts/live-judge-test.js --yes
 *   node scripts/live-judge-test.js --cleanup <runId>     # remove leftovers of an interrupted run
 *   node scripts/live-judge-test.js --cleanup-all         # remove every load-test class / user / question
 *
 * What it does (uses MONGO_URI and JWT_SECRET from .env, sends requests to API_PUBLIC_URL):
 *   1. Creates one temporary class "[LOAD TEST <runId>]" with STUDENTS students (emails
 *      lt-<runId>-sN@loadtest.invalid, NO password - nobody can log in as them) and one coding
 *      question open in all 8 judge languages:
 *        heavy (default): "count pairs with sum K" - 2 small public tests + 5 hidden tests of up
 *                         to 200,000 numbers (~3 MB of test input); needs a hash map or sorting.
 *        echo:            print the input line - 2 public + 2 hidden tiny tests.
 *   2. Preflight: one correct Submit (heavy) / Run (echo) per language, one at a time - shows which
 *      languages work and how fast each one handles the big tests.
 *   3. Ramp: at each level N, N students press Run (or Submit) at the same moment. Heavy also runs
 *      a worst case: N students Submit slow O(n^2) code that hits the time limit on the big tests.
 *      Records wait time per student, wrong verdicts (with reason), "judge busy", judge queue.
 *   4. Deletes everything it created (submissions, leaderboard rows, question, class, users),
 *      also on Ctrl+C or error. Real students, classes and questions are never touched.
 *
 * Results: printed as a table and written to scripts/live-judge-results-<runId>.json.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const Class = require('../models/Class');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Leaderboard = require('../models/Leaderboard');

const args = process.argv.slice(2);
const TAG = '[LOAD TEST';
const EMAIL_DOMAIN = 'loadtest.invalid';
const BASE = (process.env.TARGET || process.env.API_PUBLIC_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const STUDENTS = Number(process.env.STUDENTS) || 60;
const levels = (v, d) => (v ? v.split(',').map(Number).filter((n) => n > 0) : d).map((n) => Math.min(n, STUDENTS));
const RUN_LEVELS = levels(process.env.RUN_LEVELS, [1, 3, 10, 30, 60]);
const SUBMIT_LEVELS = levels(process.env.SUBMIT_LEVELS, [3, 10, 30]);
const SLOW_LEVELS = levels(process.env.SLOW_LEVELS, [10]);
const LANG = process.env.LANG_UNDER_TEST || 'python';
const QUESTION_KIND = (process.env.QUESTION || 'heavy').toLowerCase();
const REQUEST_TIMEOUT_MS = 200_000;

const ECHO_CODE = {
    python: 'print(input())',
    javascript: "const line = require('fs').readFileSync(0, 'utf8').split('\\n')[0];\nconsole.log(line);",
    c: '#include <stdio.h>\nint main(void) { char b[256]; if (fgets(b, sizeof b, stdin)) fputs(b, stdout); return 0; }',
    cpp: '#include <iostream>\n#include <string>\nint main() { std::string s; std::getline(std::cin, s); std::cout << s << std::endl; return 0; }',
    java: 'import java.util.*;\npublic class Solution {\n    public static void main(String[] a) {\n        Scanner sc = new Scanner(System.in);\n        System.out.println(sc.nextLine());\n    }\n}',
    go: 'package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tr := bufio.NewReader(os.Stdin)\n\tline, _ := r.ReadString(\'\\n\')\n\tfmt.Print(line)\n}',
    ruby: 'puts gets',
    php: '<?php echo fgets(STDIN);',
};
const LANGS = Object.keys(ECHO_CODE);

// ---- Heavy question: count pairs i<j with a[i] + a[j] = K. Input "N K\n a1 .. aN\n", output the count.
const PAIRS_CODE = {
    python: String.raw`import sys
def main():
    data = sys.stdin.buffer.read().split()
    n, k = int(data[0]), int(data[1])
    cnt = {}
    ans = 0
    for tok in data[2:2 + n]:
        a = int(tok)
        ans += cnt.get(k - a, 0)
        cnt[a] = cnt.get(a, 0) + 1
    print(ans)
main()`,
    javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8');
let pos = 0;
const next = () => {
    while (pos < data.length && data.charCodeAt(pos) < 48) pos++;
    let x = 0;
    while (pos < data.length && data.charCodeAt(pos) >= 48) { x = x * 10 + (data.charCodeAt(pos) - 48); pos++; }
    return x;
};
const n = next(), k = next();
const cnt = new Map();
let ans = 0;
for (let i = 0; i < n; i++) {
    const a = next();
    ans += cnt.get(k - a) || 0;
    cnt.set(a, (cnt.get(a) || 0) + 1);
}
console.log(String(ans));`,
    c: String.raw`#include <stdio.h>
#include <stdlib.h>
static int cmp(const void *a, const void *b) {
    long long x = *(const long long *)a, y = *(const long long *)b;
    return (x > y) - (x < y);
}
static long long countOf(const long long *v, long long n, long long t) {
    long long lo = 0, hi = n;
    while (lo < hi) { long long m = (lo + hi) / 2; if (v[m] < t) lo = m + 1; else hi = m; }
    long long first = lo;
    hi = n;
    while (lo < hi) { long long m = (lo + hi) / 2; if (v[m] <= t) lo = m + 1; else hi = m; }
    return lo - first;
}
int main(void) {
    long long n, k;
    if (scanf("%lld %lld", &n, &k) != 2) return 0;
    long long *v = malloc(sizeof(long long) * (n > 0 ? n : 1));
    for (long long i = 0; i < n; i++) if (scanf("%lld", &v[i]) != 1) return 1;
    qsort(v, n, sizeof(long long), cmp);
    long long ans = 0;
    for (long long i = 0; i < n;) {
        long long j = i;
        while (j < n && v[j] == v[i]) j++;
        long long c = j - i, w = k - v[i];
        if (v[i] < w) ans += c * countOf(v, n, w);
        else if (v[i] == w) ans += c * (c - 1) / 2;
        i = j;
    }
    printf("%lld\n", ans);
    free(v);
    return 0;
}`,
    cpp: String.raw`#include <bits/stdc++.h>
using namespace std;
int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    long long n, k;
    if (!(cin >> n >> k)) return 0;
    unordered_map<long long, long long> cnt;
    cnt.reserve(n * 2 + 1);
    long long ans = 0;
    for (long long i = 0; i < n; i++) {
        long long a;
        cin >> a;
        auto it = cnt.find(k - a);
        if (it != cnt.end()) ans += it->second;
        cnt[a]++;
    }
    cout << ans << "\n";
    return 0;
}`,
    java: String.raw`import java.io.*;
import java.util.*;
public class Solution {
    public static void main(String[] args) throws IOException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(System.in, 1 << 16));
        int n = (int) readLong(in);
        long k = readLong(in);
        HashMap<Long, Integer> cnt = new HashMap<>(n * 2 + 1);
        long ans = 0;
        for (int i = 0; i < n; i++) {
            long a = readLong(in);
            Integer c = cnt.get(k - a);
            if (c != null) ans += c;
            cnt.merge(a, 1, Integer::sum);
        }
        System.out.println(ans);
    }
    private static long readLong(DataInputStream in) throws IOException {
        int b = in.read();
        while (b != -1 && b < '0') b = in.read();
        long x = 0;
        while (b >= '0') { x = x * 10 + (b - '0'); b = in.read(); }
        return x;
    }
}`,
    go: String.raw`package main

import (
	"bufio"
	"os"
	"strconv"
)

func main() {
	r := bufio.NewReaderSize(os.Stdin, 1<<16)
	readInt := func() int64 {
		c, err := r.ReadByte()
		for err == nil && (c < '0' || c > '9') {
			c, err = r.ReadByte()
		}
		n := int64(0)
		for err == nil && c >= '0' && c <= '9' {
			n = n*10 + int64(c-'0')
			c, err = r.ReadByte()
		}
		return n
	}
	n := readInt()
	k := readInt()
	cnt := make(map[int64]int64, n)
	var ans int64
	for i := int64(0); i < n; i++ {
		a := readInt()
		ans += cnt[k-a]
		cnt[a]++
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	w.WriteString(strconv.FormatInt(ans, 10) + "\n")
}`,
    ruby: String.raw`data = STDIN.read.split.map!(&:to_i)
n, k = data[0], data[1]
cnt = Hash.new(0)
ans = 0
data[2, n].each { |a| ans += cnt[k - a]; cnt[a] += 1 }
puts ans`,
    php: String.raw`<?php
$data = preg_split('/\s+/', trim(stream_get_contents(STDIN)));
$n = (int)$data[0];
$k = (int)$data[1];
$cnt = [];
$ans = 0;
for ($i = 0; $i < $n; $i++) {
    $a = (int)$data[$i + 2];
    $t = $k - $a;
    if (isset($cnt[$t])) $ans += $cnt[$t];
    $cnt[$a] = ($cnt[$a] ?? 0) + 1;
}
echo $ans, "\n";`,
};

/** What a beginner writes: correct but O(n^2) - passes the small tests, hits the time limit on the big ones. */
const PAIRS_SLOW_PYTHON = String.raw`import sys
data = sys.stdin.read().split()
n, k = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))
ans = 0
for i in range(n):
    for j in range(i + 1, n):
        if a[i] + a[j] == k:
            ans += 1
print(ans)`;

/** Deterministic test data (same every run); expected answers are computed here. */
const buildPairsTests = () => {
    let seed = 20261008;
    const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const make = (arr, k, isPublic) => {
        const cnt = new Map();
        let ans = 0;
        for (const a of arr) {
            ans += cnt.get(k - a) || 0;
            cnt.set(a, (cnt.get(a) || 0) + 1);
        }
        return { input: `${arr.length} ${k}\n${arr.join(' ')}\n`, expectedOutput: String(ans), isPublic };
    };
    const randomArr = (n, max) => Array.from({ length: n }, () => Math.floor(rand() * max));
    const big = randomArr(100000, 1e9);
    return [
        make([1, 6, 3, 4, 2, 5], 7, true),
        make(randomArr(12, 20), 20, true),
        make(randomArr(1000, 1000), 1000, false),
        make(randomArr(50000, 100000), 100000, false),
        make(big, big[17] + big[99991], false),
        make(randomArr(200000, 200000), 200000, false),
        make(new Array(200000).fill(7), 14, false), // answer 19,999,900,000 - needs 64-bit integers
    ];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const secs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);

const api = async (method, url, { token, body } = {}) => {
    const t0 = performance.now();
    try {
        const res = await fetch(`${BASE}${url}`, {
            method,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'AlgoSutra-live-judge-test/1.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: res.status, json, ms: performance.now() - t0 };
    } catch (err) {
        return { status: err.name === 'TimeoutError' ? 'timeout' : 'neterr', json: null, ms: performance.now() - t0, error: err.message };
    }
};
/** Why a 200 response was graded wrong (e.g. "Time limit exceeded (2s)"), null when correct. */
const wrongReason = (r) => {
    if (r.status !== 200) return null;
    const bad = (r.json?.testResults || []).find((t) => t && t.passed === false);
    if (!bad) return null;
    if (bad.isTLE || bad.status === 'tle') return 'time limit exceeded';
    if (bad.isMLE || bad.status === 'mle') return 'memory limit exceeded';
    return String(bad.error || bad.status || 'wrong output').slice(0, 80);
};
const health = async () => (await api('GET', '/health')).json || {};

/** Delete everything a run created. With runId=null: every load-test record ever created. */
const cleanup = async (runId) => {
    const nameRe = runId ? new RegExp(`^\\[LOAD TEST ${runId}\\]`) : /^\[LOAD TEST /;
    const emailRe = runId ? new RegExp(`^lt-${runId}-s\\d+@${EMAIL_DOMAIN.replace('.', '\\.')}$`) : new RegExp(`^lt-[a-z0-9]+-s\\d+@${EMAIL_DOMAIN.replace('.', '\\.')}$`);
    const classes = await Class.find({ name: nameRe }).select('_id').lean();
    const classIds = classes.map((c) => c._id);
    const questions = await Question.find({ title: nameRe }).select('_id').lean();
    const questionIds = questions.map((q) => q._id);
    const users = await User.find({ email: emailRe, role: 'student' }).select('_id').lean();
    const userIds = users.map((u) => u._id);
    const out = {
        submissions: (await Submission.deleteMany({ $or: [{ classId: { $in: classIds } }, { questionId: { $in: questionIds } }] })).deletedCount,
        leaderboardRows: (await Leaderboard.deleteMany({ classId: { $in: classIds } })).deletedCount,
        questions: (await Question.deleteMany({ _id: { $in: questionIds } })).deletedCount,
        classes: (await Class.deleteMany({ _id: { $in: classIds } })).deletedCount,
        users: (await User.deleteMany({ _id: { $in: userIds } })).deletedCount,
    };
    console.log(`cleanup${runId ? ` ${runId}` : ' (all load-test data)'}: ${JSON.stringify(out)}`);
    return out;
};

/** N students fire one request each at the same moment. */
const wave = async (students, n, makeRequest) => {
    const h0 = await health();
    // Sample the judge while the wave runs (its own peak counters are since API start).
    let done = false;
    const seen = { active: 0, queued: 0 };
    const sampler = (async () => {
        while (!done) {
            const j = (await health()).judge;
            if (j) { seen.active = Math.max(seen.active, j.active || 0); seen.queued = Math.max(seen.queued, j.queued || 0); }
            await sleep(500);
        }
    })();
    const t0 = performance.now();
    const samples = await Promise.all(students.slice(0, n).map((s) => makeRequest(s)));
    const wallMs = performance.now() - t0;
    done = true;
    await sampler;
    const h1 = await health();
    const ok = samples.filter((s) => s.status === 200);
    const lat = ok.map((s) => s.ms);
    const codes = {};
    for (const s of samples) codes[s.status] = (codes[s.status] || 0) + 1;
    return {
        students: n,
        ok: ok.length,
        correct: ok.filter((s) => s.correct).length,
        wrongReasons: ok.filter((s) => !s.correct).reduce((m, s) => { const k = s.reason || 'graded wrong'; m[k] = (m[k] || 0) + 1; return m; }, {}),
        busy429: samples.filter((s) => s.status === 429).length,
        failed: samples.filter((s) => s.status !== 200 && s.status !== 429).length,
        p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? Math.round(Math.max(...lat)) : null,
        fastest: lat.length ? Math.round(Math.min(...lat)) : null,
        wallMs: Math.round(wallMs),
        codes,
        firstError: samples.find((s) => s.status !== 200)?.json?.error || samples.find((s) => s.status !== 200)?.error || null,
        judge: {
            maxActive: seen.active, maxQueued: seen.queued,
            rejected: (h1?.judge?.rejected || 0) - (h0?.judge?.rejected || 0),
            timedOutWaiting: (h1?.judge?.timedOutWaiting || 0) - (h0?.judge?.timedOutWaiting || 0),
        },
    };
};

/** Let the judge drain between levels so each level starts from an idle judge. */
const waitIdle = async () => {
    for (let i = 0; i < 120; i += 1) {
        const h = await health();
        if (!h.judge || (h.judge.active === 0 && h.judge.queued === 0)) return;
        await sleep(1000);
    }
};

const printRow = (kind, r) => console.log(
    `${kind.padEnd(7)} ${String(r.students).padStart(3)} at once | ok ${String(r.ok).padStart(3)}/${r.students}` +
    ` | first ${secs(r.fastest).padStart(6)} | typical ${secs(r.p50).padStart(6)} | 95% ${secs(r.p95).padStart(6)} | last ${secs(r.max).padStart(6)}` +
    ` | correct ${r.correct} busy ${r.busy429} failed ${r.failed} | judge running ${r.judge.maxActive} waiting ${r.judge.maxQueued}` +
    (r.firstError ? ` | error: ${r.firstError}` : '') +
    (Object.keys(r.wrongReasons).length ? ` | graded wrong: ${JSON.stringify(r.wrongReasons)}` : ''),
);

(async () => {
    if (!process.env.MONGO_URI || !process.env.JWT_SECRET) {
        console.error('MONGO_URI and JWT_SECRET must be set (.env next to package.json).');
        process.exit(2);
    }
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

    const cleanupIdx = args.indexOf('--cleanup');
    if (cleanupIdx !== -1) {
        const id = args[cleanupIdx + 1];
        if (!id || !/^[a-z0-9]+$/.test(id)) { console.error('usage: --cleanup <runId>'); process.exit(2); }
        await cleanup(id);
        return mongoose.disconnect();
    }
    if (args.includes('--cleanup-all')) {
        await cleanup(null);
        return mongoose.disconnect();
    }
    if (!args.includes('--yes')) {
        console.error(`This creates a temporary test class with ${STUDENTS} students in the database from .env,`);
        console.error(`sends Run/Submit requests to ${BASE}, then deletes all of it. Re-run with --yes to start.`);
        process.exit(2);
    }

    const h = await health();
    if (h.status !== 'ok') { console.error(`API ${BASE}/health is not ok: ${JSON.stringify(h)}`); process.exit(1); }
    if (!process.env.FORCE && h.judge && (h.judge.active > 0 || h.judge.queued > 0)) {
        console.error(`The judge is busy right now (active ${h.judge.active}, queued ${h.judge.queued}) - students may be using it. Try later or set FORCE=1.`);
        process.exit(1);
    }

    const runId = Date.now().toString(36);
    const label = `${TAG} ${runId}]`;
    const results = { runId, target: BASE, startedAt: new Date().toISOString(), judgeConfig: h.judge, judgeMode: h.judgeMode, language: LANG, preflight: [], run: [], submit: [] };
    let cleaned = false;
    const finish = async () => {
        if (cleaned) return;
        cleaned = true;
        try { results.cleanup = await cleanup(runId); } catch (err) { console.error(`CLEANUP FAILED - run: node scripts/live-judge-test.js --cleanup ${runId}\n`, err.message); }
    };
    process.on('SIGINT', async () => { console.log('\ninterrupted - cleaning up'); await finish(); await mongoose.disconnect(); process.exit(130); });

    try {
        console.log(`run ${runId}: target ${BASE}, judge ${h.judgeMode} concurrency ${h.judge?.concurrency} maxQueue ${h.judge?.maxQueue}`);
        const students = await User.insertMany(Array.from({ length: STUDENTS }, (_, i) => ({
            name: `${label} Student ${i + 1}`, email: `lt-${runId}-s${i + 1}@${EMAIL_DOMAIN}`, role: 'student',
        })));
        const owner = await User.findOne({ role: { $in: ['admin', 'superAdmin'] } }).select('_id').lean();
        if (!owner) throw new Error('No admin account found to own the temporary class');
        const cls = await Class.create({ name: `${label} Run/Submit test`, description: 'Temporary - deleted automatically', createdBy: owner._id, students: students.map((s) => s._id) });
        const heavy = QUESTION_KIND !== 'echo';
        const testCases = heavy
            ? buildPairsTests()
            : [
                { input: 'alpha', expectedOutput: 'alpha', isPublic: true },
                { input: '42', expectedOutput: '42', isPublic: true },
                { input: 'hidden one', expectedOutput: 'hidden one', isPublic: false },
                { input: '7', expectedOutput: '7', isPublic: false },
            ];
        const inputMb = testCases.reduce((n, t) => n + t.input.length, 0) / 1e6;
        const question = await Question.create({
            title: heavy ? `${label} Pair Sum Count` : `${label} Echo`,
            description: heavy
                ? '<p>Given N integers and K, print how many pairs i &lt; j have a[i] + a[j] = K. Input: "N K" then N integers.</p>'
                : '<p>Print the input line.</p>',
            difficulty: heavy ? 'medium' : 'easy', type: 'coding',
            createdBy: owner._id, points: 10, languages: LANGS, timeLimit: 2, memoryLimit: 256,
            testCases,
            classes: [{ classId: cls._id, isPublished: true }],
        });
        cls.questions = [question._id];
        await cls.save();
        const pub = testCases.filter((t) => t.isPublic).length;
        results.question = { kind: heavy ? 'heavy' : 'echo', tests: testCases.length, publicTests: pub, hiddenTests: testCases.length - pub, inputMb: Math.round(inputMb * 100) / 100, timeLimitSec: 2, memoryLimitMb: 256 };
        console.log(`created class ${cls._id}, ${students.length} students (no passwords)`);
        console.log(`question "${question.title}": ${testCases.length} tests (${pub} public, ${testCases.length - pub} hidden), ${inputMb.toFixed(1)} MB of test input, 2 s / 256 MB per test\n`);

        const ctx = students.map((s) => ({ id: String(s._id), token: jwt.sign({ id: s._id, role: 'student', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '2h', algorithm: 'HS256' }) }));
        const codeFor = (lang) => (heavy ? PAIRS_CODE : ECHO_CODE)[lang];
        const body = (code, lang) => ({ answer: code, classId: String(cls._id), language: lang });
        const doRun = (lang, code = codeFor(lang)) => async (s) => {
            const r = await api('POST', `/questions/${question._id}/run`, { token: s.token, body: body(code, lang) });
            return { ...r, correct: r.json?.isCorrect === true, reason: wrongReason(r) };
        };
        const doSubmit = (lang, code = codeFor(lang)) => async (s) => {
            const r = await api('POST', `/questions/${question._id}/submit`, { token: s.token, body: body(code, lang) });
            return { ...r, correct: r.json?.submission?.isCorrect === true, reason: wrongReason(r) };
        };

        // Heavy: a full Submit per language (all hidden big tests) shows real per-language speed.
        console.log(`--- Preflight: one correct ${heavy ? 'Submit (all tests)' : 'Run'} per language, one at a time`);
        for (const lang of LANGS) {
            const r = await (heavy ? doSubmit(lang) : doRun(lang))(ctx[0]);
            const slowest = Math.max(0, ...(r.json?.testResults || []).map((t) => t.timeMs || 0));
            const row = { language: lang, status: r.status, ms: Math.round(r.ms), slowestTestMs: slowest || null, correct: r.correct, error: r.status === 200 ? (r.correct ? null : r.reason || 'graded wrong') : (r.json?.error || r.error) };
            results.preflight.push(row);
            console.log(`${lang.padEnd(11)} ${r.status === 200 && r.correct ? 'OK  ' : 'FAIL'} total ${secs(r.ms).padStart(6)}${slowest ? ` | slowest test ${slowest} ms` : ''}${row.error ? `  ${row.error}` : ''}`);
        }
        const langOk = results.preflight.find((p) => p.language === LANG);
        if (!langOk || langOk.status !== 200 || !langOk.correct) throw new Error(`${LANG} does not work on the judge - fix that first (see preflight above)`);

        console.log(`\n--- Run (${LANG}, ${pub} public tests): N students press Run at the same moment`);
        for (const n of RUN_LEVELS) {
            await waitIdle(); await sleep(2000);
            const row = await wave(ctx, n, doRun(LANG));
            results.run.push(row); printRow('Run', row);
        }
        console.log(`\n--- Submit (${LANG}, all ${testCases.length} tests): N students press Submit at the same moment`);
        for (const n of SUBMIT_LEVELS) {
            await waitIdle(); await sleep(2000);
            const row = await wave(ctx, n, doSubmit(LANG));
            results.submit.push(row); printRow('Submit', row);
        }
        if (heavy && SLOW_LEVELS.length) {
            results.slowSubmit = [];
            console.log('\n--- Worst case: N students Submit slow O(n^2) Python at the same moment (time limit on the big tests; expected "graded wrong")');
            for (const n of SLOW_LEVELS) {
                await waitIdle(); await sleep(2000);
                const row = await wave(ctx, n, doSubmit('python', PAIRS_SLOW_PYTHON));
                results.slowSubmit.push(row); printRow('Slow', row);
            }
        }
        results.healthAfter = await health();
        console.log(`\nAPI health after: ${results.healthAfter.status}, mongo ${results.healthAfter.mongo}, docker ${results.healthAfter.docker}`);
    } catch (err) {
        results.error = err.message;
        console.error(`\nSTOPPED: ${err.message}`);
    } finally {
        await finish();
        results.finishedAt = new Date().toISOString();
        const out = path.join(__dirname, `live-judge-results-${runId}.json`);
        fs.writeFileSync(out, JSON.stringify(results, null, 2));
        console.log(`results: ${out}`);
        await mongoose.disconnect();
    }
})().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
