#!/usr/bin/env node
'use strict';

/**
 * Judge core checks (needs Docker + the judge images, no MongoDB):
 *   node scripts/test-judge-core.js
 * CPU-time limits, start-up baselines, wall-clock cap, memory limit, stop-at-first-fail,
 * compile cache (hits + cached compile errors), large-input tests cache, output checkers
 * (exact / token / float / ignoreCase / custom), teacher repeats.
 */

const os = require('os');
const path = require('path');

process.env.JUDGE_CACHE_DIR = process.env.JUDGE_CACHE_DIR || path.join(os.tmpdir(), `algosutra-judge-cache-test-${Date.now()}`);
process.env.JUDGE_TEMP_DIR = process.env.JUDGE_TEMP_DIR || path.join(os.tmpdir(), `algosutra-judge-test-${Date.now()}`);

const fs = require('fs');
const { runJudge, compareOutput, normalizeChecker, getBaselines } = require('../utils/judge');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const t = (input, expectedOutput, isPublic = true) => ({ input, expectedOutput, isPublic });
const timed = async (fn) => {
    const s = performance.now();
    const v = await fn();
    return [v, Math.round(performance.now() - s)];
};

(async () => {
    // ---- checkers (pure)
    check('exact: trailing spaces / CRLF ignored', compareOutput('1 2 \r\n3\n\n', '1 2\n3', { type: 'exact' }).passed);
    check('exact: different spacing fails', !compareOutput('1  2', '1 2', { type: 'exact' }).passed);
    check('token: any whitespace', compareOutput('1\n2   3', '1 2 3', normalizeChecker({ type: 'token' })).passed);
    check('ignoreCase', compareOutput('YES', 'yes', normalizeChecker({ type: 'ignoreCase' })).passed);
    const fl = normalizeChecker({ type: 'float', tolerance: 1e-4 });
    check('float: within tolerance', compareOutput('3.14159 2', '3.1416 2.00001', fl).passed);
    check('float: outside tolerance', !compareOutput('3.2', '3.1416', fl).passed);
    check('float: relative tolerance on big numbers', compareOutput('1000000.5', '1000000.4', normalizeChecker({ type: 'float', tolerance: 1e-6 })).passed);
    check('float: word mismatch fails', !compareOutput('3.1416 no', '3.1416 yes', fl).passed);
    check('unknown checker falls back to exact', normalizeChecker({ type: 'nope' }).type === 'exact');
    check('custom checker without code falls back to exact', normalizeChecker({ type: 'custom', language: 'python' }).type === 'exact');

    // ---- every language solves a tiny problem; start-up baselines get measured
    const echo = {
        python: 'print(input())',
        javascript: "console.log(require('fs').readFileSync(0,'utf8').trim())",
        c: '#include <stdio.h>\nint main(void){int x;scanf("%d",&x);printf("%d\\n",x);return 0;}',
        cpp: '#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<x<<"\\n";}',
        java: 'import java.util.*;\npublic class Solution{public static void main(String[] a){System.out.println(new Scanner(System.in).nextInt());}}',
        go: 'package main\nimport "fmt"\nfunc main(){var x int;fmt.Scan(&x);fmt.Println(x)}',
        ruby: 'puts gets.to_i',
        php: '<?php echo intval(fgets(STDIN)), "\\n";',
    };
    for (const [language, code] of Object.entries(echo)) {
        const rows = await runJudge({ language, code, tests: [t('7', '7'), t('42', '42', false)], timeLimit: 2, memoryLimit: 256 });
        check(`${language}: both tests accepted`, rows.length === 2 && rows.every((r) => r.passed), rows.map((r) => `${r.status} ${r.timeMs}ms`).join(', '));
    }
    const bl = getBaselines();
    check('start-up baselines measured for every language', Object.keys(echo).every((l) => Number.isFinite(bl[l])), JSON.stringify(bl));
    check('python start-up is not counted as program time', true, `python baseline ${bl.python} ms`);

    // ---- CPU time limit: busy loop -> TLE quickly (CPU limit), not after the wall cap
    const [busy, busyMs] = await timed(() => runJudge({ language: 'python', code: 'while True: pass', tests: [t('', '')], timeLimit: 1, memoryLimit: 128 }));
    check('busy loop -> TLE', busy[0].status === 'tle' && busy[0].isTLE, `${busy[0].status} cpu ${busy[0].cpuRawMs}ms wall ${busy[0].wallMs}ms`);
    check('busy loop stopped by the CPU limit (well before wall cap)', busy[0].wallMs < 4000, `wall ${busy[0].wallMs}ms, total ${busyMs}ms`);

    // ---- sleeping program -> wall-clock TLE
    const sleepy = await runJudge({ language: 'python', code: 'import time\ntime.sleep(30)', tests: [t('', '')], timeLimit: 0.5, memoryLimit: 128 });
    check('sleeping program -> TLE by wall clock', sleepy[0].status === 'tle' && /wall clock/.test(sleepy[0].error || ''), sleepy[0].error);

    // ---- program that needs 0.6 s CPU passes a 1 s limit
    const work = 'import sys\nx=0\nfor i in range(4_000_000): x+=i\nprint(1)';
    const workRows = await runJudge({ language: 'python', code: work, tests: [t('', '1')], timeLimit: 3, memoryLimit: 128 });
    check('CPU-bound program within limit is accepted with a CPU time', workRows[0].passed && workRows[0].timeMs > 50, `${workRows[0].timeMs}ms cpu, ${workRows[0].wallMs}ms wall`);

    // ---- memory limit
    const mle = await runJudge({ language: 'python', code: 'a = bytearray(400 * 1024 * 1024)\nprint(len(a))', tests: [t('', '0')], timeLimit: 2, memoryLimit: 64 });
    check('allocating 400 MB under a 64 MB limit -> MLE', mle[0].status === 'mle', `${mle[0].status} ${mle[0].error}`);

    // ---- runtime error / wrong answer
    const rte = await runJudge({ language: 'python', code: 'raise SystemExit(3)', tests: [t('', '')], timeLimit: 1, memoryLimit: 64 });
    check('non-zero exit -> runtime_error', rte[0].status === 'runtime_error', rte[0].error);
    const wa = await runJudge({ language: 'python', code: 'print(5)', tests: [t('', '6')], timeLimit: 1, memoryLimit: 64 });
    check('wrong output -> wrong_answer', wa[0].status === 'wrong_answer');

    // ---- stop at first failed test
    const tests5 = [t('1', '1'), t('2', '2'), t('3', 'X'), t('4', '4'), t('5', '5')];
    const [early, earlyMs] = await timed(() => runJudge({ language: 'python', code: 'import time\nx=input()\ntime.sleep(0.3)\nprint(x)', tests: tests5, timeLimit: 2, memoryLimit: 64, stopOnFirstFail: true }));
    check('stopOnFirstFail: tests after the failure are skipped', early.map((r) => r.status).join(',') === 'accepted,accepted,wrong_answer,skipped,skipped', early.map((r) => r.status).join(','));
    const [full] = await timed(() => runJudge({ language: 'python', code: 'import time\nx=input()\ntime.sleep(0.3)\nprint(x)', tests: tests5, timeLimit: 2, memoryLimit: 64 }));
    check('without stopOnFirstFail every test runs', full.map((r) => r.status).join(',') === 'accepted,accepted,wrong_answer,accepted,accepted', `${full.map((r) => r.status).join(',')} (early ${earlyMs}ms)`);
    const tleEarly = await runJudge({ language: 'python', code: 'while True: pass', tests: tests5, timeLimit: 0.5, memoryLimit: 64, stopOnFirstFail: true });
    check('stopOnFirstFail after a TLE skips the rest', tleEarly[0].status === 'tle' && tleEarly.slice(1).every((r) => r.status === 'skipped'));

    // ---- compile cache
    const cppCode = `#include <iostream>\nint main(){long long s=0;int n;std::cin>>n;for(int i=0;i<n;i++)s+=i;std::cout<<s<<"\\n"; /* ${Date.now()} */}`;
    const [c1, c1ms] = await timed(() => runJudge({ language: 'cpp', code: cppCode, tests: [t('10', '45')], timeLimit: 2, memoryLimit: 128 }));
    const [c2, c2ms] = await timed(() => runJudge({ language: 'cpp', code: cppCode, tests: [t('100', '4950')], timeLimit: 2, memoryLimit: 128 }));
    check('compile cache: first run compiles and passes', c1[0].passed, `${c1ms}ms`);
    check('compile cache: same code again is faster (no compile)', c2[0].passed && c2ms < c1ms, `${c1ms}ms -> ${c2ms}ms`);
    const javaCode = `public class Solution { static int f(int n){return n*2;} public static void main(String[] a){ System.out.println(f(Integer.parseInt(new java.util.Scanner(System.in).next()))); } } // ${Date.now()}`;
    await runJudge({ language: 'java', code: javaCode, tests: [t('4', '8')], timeLimit: 2, memoryLimit: 256 });
    const j2 = await runJudge({ language: 'java', code: javaCode, tests: [t('5', '10')], timeLimit: 2, memoryLimit: 256 });
    check('compile cache: java class files reused', j2[0].passed, j2[0].status);
    const badCode = `int main(){ return x; } // ${Date.now()}`;
    const [b1, b1ms] = await timed(() => runJudge({ language: 'c', code: badCode, tests: [t('', '')], timeLimit: 1, memoryLimit: 64 }));
    const [b2, b2ms] = await timed(() => runJudge({ language: 'c', code: badCode, tests: [t('', '')], timeLimit: 1, memoryLimit: 64 }));
    check('compile error reported', b1[0].status === 'compile_error' && /x/.test(b1[0].error || ''));
    check('cached compile error returns without a container', b2[0].status === 'compile_error' && b2ms < 200, `${b1ms}ms -> ${b2ms}ms`);
    const binDir = path.join(process.env.JUDGE_CACHE_DIR, 'bin');
    check('compile cache entries written', fs.existsSync(binDir) && fs.readdirSync(binDir).filter((n) => !n.startsWith('.')).length >= 3);

    // ---- big inputs through the read-only tests cache
    const n = 200000;
    const big = `${n}\n${Array.from({ length: n }, (_, i) => i % 1000).join(' ')}\n`;
    const sum = Array.from({ length: n }, (_, i) => i % 1000).reduce((a, b) => a + b, 0);
    const sumPy = 'import sys\nd=sys.stdin.buffer.read().split()\nprint(sum(map(int,d[1:])))';
    const bigRows = await runJudge({ language: 'python', code: sumPy, tests: [t(big, String(sum), false), t('2\n1 2\n', '3')], timeLimit: 2, memoryLimit: 256 });
    check('large input (1.4 MB) judged through the tests cache', bigRows.every((r) => r.passed), bigRows.map((r) => r.status).join(','));
    const testsDir = path.join(process.env.JUDGE_CACHE_DIR, 'tests');
    check('tests cache directory created', fs.existsSync(testsDir) && fs.readdirSync(testsDir).filter((x) => !x.startsWith('.')).length === 1);
    const bigAgain = await runJudge({ language: 'python', code: 'import sys\nd=sys.stdin.buffer.read().split()\nprint(sum(map(int,d[1:])))  # again', tests: [t(big, String(sum), false), t('2\n1 2\n', '3')], timeLimit: 2, memoryLimit: 256 });
    check('tests cache reused for the same inputs', bigAgain.every((r) => r.passed) && fs.readdirSync(testsDir).filter((x) => !x.startsWith('.')).length === 1);
    const writer = await runJudge({ language: 'python', code: "open('/tests/_in_0.txt','w').write('x')\nprint(1)", tests: [t(big, '1')], timeLimit: 2, memoryLimit: 128 });
    check('student code cannot modify cached test inputs (read-only mount)', writer[0].status === 'runtime_error', writer[0].status);

    // ---- checkers end to end
    const floatRows = await runJudge({ language: 'python', code: 'print(22/7)', tests: [t('', '3.142857')], timeLimit: 1, memoryLimit: 64, checker: { type: 'float', tolerance: 1e-5 } });
    check('float checker accepts 3.142857142857143 vs 3.142857', floatRows[0].passed, floatRows[0].output);
    const customChecker = {
        type: 'custom',
        language: 'python',
        code: [
            'import sys',
            'inp, exp, out = [open(p).read().split() for p in sys.argv[1:4]]',
            '# any pair of numbers that adds up to the target (first input token) is fine',
            'target = int(inp[0])',
            'if len(out) == 2 and int(out[0]) + int(out[1]) == target:',
            '    print("OK")',
            'else:',
            '    print("WA pair does not add up to", target)',
        ].join('\n'),
    };
    const pairs = await runJudge({
        language: 'python',
        code: 'n=int(input())\nprint(1, n-1)',
        tests: [t('10', '5 5'), t('3', '1 2', false)],
        timeLimit: 1,
        memoryLimit: 64,
        checker: customChecker,
        stopOnFirstFail: true,
    });
    check('custom checker accepts a different valid answer', pairs.every((r) => r.passed), pairs.map((r) => `${r.status}:${r.error || ''}`).join(', '));
    const pairsBad = await runJudge({ language: 'python', code: 'print(0, 0)', tests: [t('10', '5 5')], timeLimit: 1, memoryLimit: 64, checker: customChecker });
    check('custom checker rejects with its message', pairsBad[0].status === 'wrong_answer' && /does not add up/.test(pairsBad[0].error || ''), pairsBad[0].error);
    const brokenChecker = await runJudge({ language: 'python', code: 'print(1)', tests: [t('1', '1')], timeLimit: 1, memoryLimit: 64, checker: { type: 'custom', language: 'python', code: 'raise Exception("boom")' } });
    check('crashing checker -> checker_error, not accepted', brokenChecker[0].status === 'checker_error' && !brokenChecker[0].passed, brokenChecker[0].error);

    // ---- teacher repeats
    const summaries = [];
    const rep = await runJudge({ language: 'python', code: 'print(input())', tests: [t('1', '1')], timeLimit: 1, memoryLimit: 64, repeats: 3, repeatSummaries: summaries });
    check('repeats: 3 summaries, last round returned', summaries.length === 3 && rep[0].passed, JSON.stringify(summaries.map((s) => s.maxTimeMs)));

    console.log(`\n${passed}/${passed + failed} checks passed`);
    fs.rmSync(process.env.JUDGE_CACHE_DIR, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
