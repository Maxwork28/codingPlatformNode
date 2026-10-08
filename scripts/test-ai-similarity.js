#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the AI-detection similarity engine (no framework, no DB):
 *   node scripts/test-ai-similarity.js
 */

const path = require('path');
const { compareCode } = require(path.join(__dirname, '..', 'utils', 'aiDetection', 'similarity'));
const { tokenize } = require(path.join(__dirname, '..', 'utils', 'aiDetection', 'tokenizer'));
const { extractCode } = require(path.join(__dirname, '..', 'utils', 'aiDetection', 'prompts'));

let failed = 0;
let passed = 0;
const check = (name, ok, extra = '') => {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const pct = (r) => (r.status === 'ok' ? `${r.percent}%` : r.status);

// ---------------------------------------------------------------------------
// Python: maximum subarray sum
// ---------------------------------------------------------------------------
const PY_STARTER = `import sys

def max_subarray(nums):
    # write your code here
    pass

def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    nums = [int(v) for v in data[1:n + 1]]
    print(max_subarray(nums))

if __name__ == "__main__":
    main()
`;

const PY_REF = `import sys

def max_subarray(nums):
    """Kadane's algorithm: O(n) time, O(1) space."""
    best = nums[0]
    current = 0
    for x in nums:
        current = max(x, current + x)
        best = max(best, current)
        if current < 0:
            current = 0
    return best

def read_input():
    data = sys.stdin.read().split()
    n = int(data[0])
    values = [int(v) for v in data[1:n + 1]]
    return values

def main():
    values = read_input()
    result = max_subarray(values)
    print(result)

if __name__ == "__main__":
    main()
`;

// Same code: renamed identifiers, reformatted, different comments, single quotes.
const PY_RENAMED = `import sys
# my solution
def maxSum(arr):
    ans = arr[0]   # answer so far
    cur = 0
    for el in arr:
        cur = max(el,   cur + el)
        ans = max(ans, cur)
        if cur < 0: cur = 0
    return ans


def getNums():
    tokens = sys.stdin.read().split()
    size = int(tokens[0])
    lst = [int(t) for t in tokens[1:size + 1]]
    return lst

def main():
    lst = getNums()
    res = maxSum(lst)
    print(res)

if __name__ == '__main__':
    main()
`;

// Same algorithm (Kadane), written differently.
const PY_SAME_ALGO = `n = int(input())
a = list(map(int, input().split()))
best = a[0]
running = 0
i = 0
while i < n:
    running += a[i]
    if running > best:
        best = running
    if running < 0:
        running = 0
    i += 1
print(best)
`;

// Different algorithm: O(n^2) brute force over all start/end pairs.
const PY_DIFFERENT = `n = int(input())
arr = list(map(int, input().split()))
answer = arr[0]
for start in range(n):
    total = 0
    for end in range(start, n):
        total += arr[end]
        if total > answer:
            answer = total
print(answer)
`;

// Different algorithm: divide and conquer.
const PY_DIVIDE = `import sys
sys.setrecursionlimit(10000)

def solve(arr, lo, hi):
    if lo == hi:
        return arr[lo]
    mid = (lo + hi) // 2
    left_best = solve(arr, lo, mid)
    right_best = solve(arr, mid + 1, hi)
    s = 0
    cross_left = float('-inf')
    for k in range(mid, lo - 1, -1):
        s += arr[k]
        cross_left = max(cross_left, s)
    s = 0
    cross_right = float('-inf')
    for k in range(mid + 1, hi + 1):
        s += arr[k]
        cross_right = max(cross_right, s)
    return max(left_best, right_best, cross_left + cross_right)

n = int(input())
arr = list(map(int, input().split()))
print(solve(arr, 0, n - 1))
`;

{
    const bp = { language: 'python', boilerplate: [PY_STARTER] };
    const ident = compareCode(PY_REF, PY_REF, bp);
    check('python: identical code ≥ 95', ident.status === 'ok' && ident.percent >= 95, pct(ident));
    const renamed = compareCode(PY_RENAMED, PY_REF, bp);
    check('python: renamed vars + reformatting + different comments ≥ 85', renamed.status === 'ok' && renamed.percent >= 85, pct(renamed));
    const same = compareCode(PY_SAME_ALGO, PY_REF, bp);
    check('python: same algorithm written differently → moderate (15–75)', same.status === 'ok' && same.percent >= 15 && same.percent <= 75, pct(same));
    const diff = compareCode(PY_DIFFERENT, PY_REF, bp);
    check('python: different algorithm (brute force) < 35', diff.status === 'ok' && diff.percent < 35, pct(diff));
    const dc = compareCode(PY_DIVIDE, PY_REF, bp);
    check('python: different algorithm (divide & conquer) < 35', dc.status === 'ok' && dc.percent < 35, pct(dc));
    const starter = compareCode(PY_STARTER, PY_REF, bp);
    check('python: only starter code → too_short', starter.status === 'too_short', pct(starter));
    const starterFilledTiny = compareCode(PY_STARTER.replace('pass', 'return max(nums)'), PY_REF, bp);
    check('python: starter + one-line body → too_short', starterFilledTiny.status === 'too_short', pct(starterFilledTiny));
    check('python: renamed scores higher than same-algorithm, which beats different', renamed.percent > same.percent && same.percent > diff.percent, `${renamed.percent} > ${same.percent} > ${diff.percent}`);
    check(
        'python: matches carry ranges in both texts',
        renamed.matches.length > 0 && renamed.matches.every((m) => m.a.end > m.a.start && m.b.end > m.b.start && m.a.lineStart >= 1),
        `${renamed.matches.length} ranges`
    );
    const symmetric = compareCode(PY_REF, PY_RENAMED, bp);
    check('python: score is (near) symmetric', Math.abs(symmetric.percent - renamed.percent) <= 3, `${symmetric.percent} vs ${renamed.percent}`);
}

// ---------------------------------------------------------------------------
// JavaScript: two sum (indices of two numbers adding to target)
// ---------------------------------------------------------------------------
const JS_REF = `const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');
const nums = lines[1].trim().split(/\\s+/).map(Number);
const target = Number(lines[2]);

/**
 * Hash map lookup: for every value remember its index and check whether the
 * complement has already been seen.
 */
function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) {
      return [seen.get(need), i];
    }
    seen.set(nums[i], i);
  }
  return [-1, -1];
}

const [a, b] = twoSum(nums, target);
console.log(a + ' ' + b);
`;

const JS_RENAMED = `var input = require("fs").readFileSync(0, "utf8").trim().split("\\n")
var arr = input[1].trim().split(/\\s+/).map(Number)
var t = Number(input[2])

// find pair
function solve(arr, t) {
  let m = new Map()
  for (let idx = 0; idx < arr.length; idx++)
  {
    let other = t - arr[idx]
    if (m.has(other)) return [m.get(other), idx]
    m.set(arr[idx], idx)
  }
  return [-1, -1]
}

let [x, y] = solve(arr, t)
console.log(x + " " + y)
`;

const JS_DIFFERENT = `const data = require('fs').readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean).map(Number);
const n = data[0];
const values = data.slice(1, n + 1);
const goal = data[n + 1];
let found = '-1 -1';
outer: for (let p = 0; p < n; p++) {
  for (let q = p + 1; q < n; q++) {
    if (values[p] + values[q] === goal) {
      found = p + ' ' + q;
      break outer;
    }
  }
}
console.log(found);
`;

const JS_STARTER = `const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');
const nums = lines[1].trim().split(/\\s+/).map(Number);
const target = Number(lines[2]);

function twoSum(nums, target) {
  // your code here
}

const [a, b] = twoSum(nums, target);
console.log(a + ' ' + b);
`;

{
    const ident = compareCode(JS_REF, JS_REF, { language: 'javascript' });
    check('javascript: identical code ≥ 95', ident.status === 'ok' && ident.percent >= 95, pct(ident));
    const renamed = compareCode(JS_RENAMED, JS_REF, { language: 'javascript' });
    check('javascript: renamed + no semicolons + var/let + reformat ≥ 85', renamed.status === 'ok' && renamed.percent >= 85, pct(renamed));
    const diff = compareCode(JS_DIFFERENT, JS_REF, { language: 'javascript' });
    check('javascript: different algorithm (brute force) < 35', diff.status === 'ok' && diff.percent < 35, pct(diff));
    const starter = compareCode(JS_STARTER, JS_REF, { language: 'javascript', boilerplate: [JS_STARTER] });
    check('javascript: only starter code → too_short', starter.status === 'too_short', pct(starter));
    const withStarter = compareCode(JS_RENAMED, JS_REF, { language: 'javascript', boilerplate: [JS_STARTER] });
    check('javascript: renamed still ≥ 80 after boilerplate removal', withStarter.status === 'ok' && withStarter.percent >= 80, pct(withStarter));
}

// ---------------------------------------------------------------------------
// C++ / Java sanity
// ---------------------------------------------------------------------------
{
    const cppA = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (auto &x : a) cin >> x;
    long long best = a[0], cur = 0;
    for (int i = 0; i < n; i++) {
        cur = max(a[i], cur + a[i]);
        best = max(best, cur);
    }
    cout << best << endl;
    return 0;
}`;
    const cppB = `#include <iostream>
#include <vector>
using namespace std;
/* renamed */
int main(){int len;cin>>len;vector<long long> v(len);for(auto &e:v)cin>>e;
long long res=v[0],run=0;for(int k=0;k<len;k++){run=max(v[k],run+v[k]);res=max(res,run);}
cout<<res<<endl;return 0;}`;
    const r = compareCode(cppB, cppA, { language: 'cpp' });
    check('cpp: minified + renamed + different includes ≥ 85', r.status === 'ok' && r.percent >= 85, pct(r));
    const javaA = `import java.util.*;
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        long best = Long.MIN_VALUE, cur = 0;
        for (int i = 0; i < n; i++) {
            long x = sc.nextLong();
            cur = Math.max(x, cur + x);
            best = Math.max(best, cur);
        }
        System.out.println(best);
    }
}`;
    const javaB = javaA.replace(/\bcur\b/g, 'running').replace(/\bbest\b/g, 'answer').replace(/\bsc\b/g, 'in2');
    const rj = compareCode(javaB, javaA, { language: 'java' });
    check('java: renamed ≥ 95', rj.status === 'ok' && rj.percent >= 95, pct(rj));
}

// ---------------------------------------------------------------------------
// Tokenizer details
// ---------------------------------------------------------------------------
{
    const t = tokenize('x = 1 # comment\ns = f"hi {x}" + \'a\'\n"""doc"""\n', 'python').map((k) => k.t);
    check('tokenizer: python comments/docstrings dropped, f-strings → STR', JSON.stringify(t) === JSON.stringify(['ID', '=', 'NUM', 'ID', '=', 'STR', '+', 'STR']), t.join(' '));
    const j = tokenize('let a = 0x1F; // c\n/* b */ const s = `t${a}`; console.log(a === s)', 'javascript').map((k) => k.t);
    check('tokenizer: js comments dropped, === normalized, let/const → var', JSON.stringify(j) === JSON.stringify(['var', 'ID', '=', 'NUM', 'var', 'ID', '=', 'STR', 'console', '.', 'log', '(', 'ID', '==', 'ID', ')']), j.join(' '));
    const g = tokenize('package main\nimport (\n "fmt"\n)\nfunc main() { fmt.Println(`raw`) }', 'go').map((k) => k.t);
    check('tokenizer: go package/import block dropped', JSON.stringify(g) === JSON.stringify(['func', 'main', '(', ')', 'fmt', '.', 'Println', '(', 'STR', ')']), g.join(' '));
    const rb = tokenize('=begin\nblock\n=end\nputs gets.to_i # hi\n', 'ruby').map((k) => k.t);
    check('tokenizer: ruby =begin/=end and # comments dropped', JSON.stringify(rb) === JSON.stringify(['puts', 'gets', '.', 'to_i']), rb.join(' '));
    const php = tokenize('<?php\n# c\n$n = intval(trim(fgets(STDIN))); // x\necho $n * 2;\n?>', 'php').map((k) => k.t);
    check('tokenizer: php tags/comments dropped, $vars → ID', JSON.stringify(php) === JSON.stringify(['ID', '=', 'intval', '(', 'trim', '(', 'fgets', '(', 'STDIN', ')', ')', ')', 'echo', 'ID', '*', 'NUM']), php.join(' '));
    const py2 = tokenize('a = b // 2\n', 'python').map((k) => k.t);
    check('tokenizer: python // is floor division, not a comment', py2.join(' ') === 'ID = ID // NUM', py2.join(' '));
}

// ---------------------------------------------------------------------------
// Provider reply cleanup
// ---------------------------------------------------------------------------
{
    const reply = 'Here is the solution:\n\n```python\nprint(1)\n```\n\nAnd a longer one:\n```py\nimport sys\nprint(sum(map(int, sys.stdin.read().split())))\n```\nHope this helps!';
    check('extractCode: picks the longest fenced block, strips fences', extractCode(reply) === 'import sys\nprint(sum(map(int, sys.stdin.read().split())))', JSON.stringify(extractCode(reply)));
    check('extractCode: plain code passes through', extractCode('print(1)\n') === 'print(1)');
    check('extractCode: unterminated fence', extractCode('```js\nconsole.log(1)') === 'console.log(1)', JSON.stringify(extractCode('```js\nconsole.log(1)')));
}

// ---------------------------------------------------------------------------
// Performance bound
// ---------------------------------------------------------------------------
{
    // ~2k tokens of varied code per side (the engine caps each text at 2000 tokens).
    const ops = ['+', '-', '*', '%', '//'];
    const body = (seed) =>
        Array.from({ length: 160 }, (_, i) => {
            const k = (i * 7 + seed) % 13;
            return k % 3 === 0
                ? `for v${i} in range(${k}):\n    acc = acc ${ops[k % 5]} v${i}`
                : k % 3 === 1
                ? `if acc > ${k}:\n    acc = helper_${k}(acc, ${i})`
                : `items.append(acc ${ops[(k + 1) % 5]} ${i})`;
        }).join('\n');
    const big = body(1);
    const t0 = Date.now();
    const r = compareCode(big, body(5), { language: 'python' });
    const ms = Date.now() - t0;
    check('performance: two ~2k-token texts compared in < 2 s', ms < 2000 && r.status === 'ok', `${ms} ms, ${pct(r)}`);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
