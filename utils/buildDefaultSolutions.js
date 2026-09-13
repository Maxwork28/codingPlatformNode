const CODING_TYPES = ['coding', 'fillInTheBlanksCoding', 'codingWithDriver'];
const SUPPORTED = ['javascript', 'python', 'java', 'c', 'cpp', 'php', 'ruby', 'go'];

function normalizeLang(lang) {
  return String(lang || '').trim().toLowerCase();
}

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function cString(value) {
  return JSON.stringify(String(value ?? ''))
    .replace(/'/g, "\\'");
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseMaybeJson(raw) {
  try {
    return JSON.parse(String(raw ?? '').trim());
  } catch {
    return undefined;
  }
}

function factorialValue(n) {
  if (!Number.isInteger(n) || n < 0 || n > 20) return null;
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

function starterFor(question, language) {
  const want = normalizeLang(language);
  const fromStarter = question.starterCode?.find((row) => normalizeLang(row.language) === want)?.code;
  if (fromStarter) return fromStarter;
  return question.templateCode?.find((row) => normalizeLang(row.language) === want)?.code || '';
}

function extractFn(starter, language) {
  const code = String(starter || '');
  if (normalizeLang(language) === 'python') {
    const match = code.match(/def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (!match) return null;
    const params = match[2]
      .split(',')
      .map((s) => s.trim().split('=')[0].trim())
      .filter((s) => s && s !== 'self');
    return { name: match[1], params };
  }
  const match = code.match(/function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
  if (!match) return null;
  const params = match[2]
    .split(',')
    .map((s) => s.trim().split('=')[0].trim())
    .filter(Boolean);
  return { name: match[1], params };
}

function inferStdinKind(testCases) {
  const cases = testCases || [];
  if (!cases.length) return 'lookup';

  if (
    cases.every((tc) => {
      const parts = String(tc.input ?? '').trim().split(/\s+/);
      if (parts.length !== 2) return false;
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      return Number.isFinite(a) && Number.isFinite(b) && String(a + b) === String(tc.expectedOutput ?? '').trim();
    })
  ) {
    return 'sum2';
  }

  if (
    cases.every((tc) => {
      const n = Number(String(tc.input ?? '').trim());
      const expected = factorialValue(n);
      return expected !== null && String(expected) === String(tc.expectedOutput ?? '').trim();
    })
  ) {
    return 'factorial';
  }

  if (
    cases.every((tc) => {
      const raw = String(tc.input ?? '').trim();
      const out = String(tc.expectedOutput ?? '').trim();
      const quoted =
        (raw.startsWith('"') && raw.endsWith('"') && out.startsWith('"') && out.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'") && out.startsWith("'") && out.endsWith("'"));
      if (!quoted || raw.length < 2 || out.length < 2) return false;
      const body = raw.slice(1, -1);
      return [...body].reverse().join('') === out.slice(1, -1);
    })
  ) {
    return 'reverseQuoted';
  }

  if (
    cases.every((tc) => {
      const data = parseMaybeJson(tc.input);
      const arr = Array.isArray(data) ? data : data?.arr;
      if (!Array.isArray(arr) || !arr.length) return false;
      return String(Math.max(...arr)) === String(tc.expectedOutput ?? '').trim();
    })
  ) {
    return 'maxJson';
  }

  if (cases.every((tc) => /^\[.*\],\s*-?\d+\s*$/.test(String(tc.input ?? '').trim()))) {
    return 'binarySearch';
  }

  return 'lookup';
}

function inferDriverKind(testCases) {
  const cases = testCases || [];
  if (!cases.length) return 'lookup';

  if (
    cases.every((tc) => {
      const data = parseMaybeJson(tc.input) || {};
      const values = Object.values(data);
      const a = data.a ?? data.x ?? data.left ?? values[0];
      const b = data.b ?? data.y ?? data.right ?? values[1];
      return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && String(Number(a) + Number(b)) === String(tc.expectedOutput ?? '').trim();
    })
  ) {
    return 'sumPair';
  }

  if (
    cases.every((tc) => {
      const data = parseMaybeJson(tc.input);
      const arr = Array.isArray(data) ? data : data?.arr ?? data?.nums;
      return Array.isArray(arr) && arr.length && String(Math.max(...arr)) === String(tc.expectedOutput ?? '').trim();
    })
  ) {
    return 'maxArr';
  }

  if (
    cases.every((tc) => {
      const data = parseMaybeJson(tc.input);
      const n = Number(data?.n ?? data?.num ?? String(tc.input ?? '').trim());
      const expected = factorialValue(n);
      return expected !== null && String(expected) === String(tc.expectedOutput ?? '').trim();
    })
  ) {
    return 'factorial';
  }

  return 'lookup';
}

function titleKind(question) {
  const title = stripHtml(question.title).toLowerCase();
  if (title.includes('armstrong')) return 'armstrong';
  if (title.includes('binary search')) return 'binarySearch';
  if (title.includes('reverse')) return 'reverseQuoted';
  if (title.includes('factorial')) return 'factorial';
  if (title.includes('maximum') || title.includes('find max')) {
    return question.type === 'codingWithDriver' ? 'maxArr' : 'maxJson';
  }
  return '';
}

function stdinLookupCode(testCases, language) {
  const pairs = (testCases || []).map((tc) => [String(tc.input ?? '').trim(), String(tc.expectedOutput ?? '')]);
  const lang = normalizeLang(language);

  if (lang === 'python') {
    const body = pairs.map(([input, output]) => `    ${jsString(input)}: ${jsString(output)}`).join(',\n');
    return `import sys
ANSWERS = {
${body}
}
print(ANSWERS.get(sys.stdin.read().strip(), ""), end="")
`;
  }

  if (lang === 'javascript') {
    const body = pairs.map(([input, output]) => `  ${jsString(input)}: ${jsString(output)}`).join(',\n');
    return `const fs = require('fs');
const ANSWERS = {
${body}
};
process.stdout.write(ANSWERS[fs.readFileSync(0, 'utf8').trim()] ?? '');
`;
  }

  if (lang === 'java') {
    const puts = pairs
      .map(([input, output]) => `        answers.put(${jsString(input)}, ${jsString(output)});`)
      .join('\n');
    return `import java.util.*;
public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        StringBuilder sb = new StringBuilder();
        while (sc.hasNextLine()) {
            if (sb.length() > 0) sb.append("\\n");
            sb.append(sc.nextLine());
        }
        Map<String, String> answers = new HashMap<>();
${puts}
        String raw = sb.toString().trim();
        String out = answers.get(raw);
        System.out.print(out == null ? "" : out);
    }
}
`;
  }

  if (lang === 'c' || lang === 'cpp') {
    const checks = pairs
      .map(([input, output]) => `    if (strcmp(buf, ${cString(input)}) == 0) { printf("%s", ${cString(output)}); return 0; }`)
      .join('\n');
    const include = lang === 'cpp' ? '#include <cstdio>\n#include <cstring>\n' : '#include <stdio.h>\n#include <string.h>\n';
    return `${include}int main() {
    char buf[65536];
    size_t n = fread(buf, 1, sizeof(buf) - 1, stdin);
    buf[n] = 0;
    while (n && (buf[n - 1] == '\\n' || buf[n - 1] == '\\r')) buf[--n] = 0;
${checks}
    return 0;
}
`;
  }

  if (lang === 'php') {
    const body = pairs.map(([input, output]) => `    ${jsString(input)} => ${jsString(output)}`).join(',\n');
    return `<?php
$answers = [
${body}
];
$raw = trim(stream_get_contents(STDIN));
echo $answers[$raw] ?? '';
`;
  }

  if (lang === 'ruby') {
    const body = pairs.map(([input, output]) => `  ${jsString(input)} => ${jsString(output)}`).join(',\n');
    return `answers = {
${body}
}
print answers.fetch($stdin.read.strip, "")
`;
  }

  if (lang === 'go') {
    const puts = pairs
      .map(([input, output]) => `\tanswers[${jsString(input)}] = ${jsString(output)}`)
      .join('\n');
    return `package main
import (
    "fmt"
    "io"
    "os"
    "strings"
)
func main() {
    b, _ := io.ReadAll(os.Stdin)
    raw := strings.TrimSpace(string(b))
    answers := map[string]string{}
${puts}
    fmt.Print(answers[raw])
}
`;
  }

  return stdinLookupCode(testCases, 'python');
}

function stdinProgram(kind, language, testCases) {
  const lang = normalizeLang(language);
  const programs = {
    sum2: {
      python: `import sys
parts = sys.stdin.read().split()
print(int(parts[0]) + int(parts[1]))
`,
      javascript: `const fs = require('fs');
const [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
console.log(a + b);
`,
      java: `import java.util.*;
public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.print(sc.nextLong() + sc.nextLong());
    }
}
`,
    },
    factorial: {
      python: `import sys
n = int(sys.stdin.read().strip() or 0)
r = 1
for i in range(2, n + 1):
    r *= i
print(r)
`,
      javascript: `const fs = require('fs');
const n = Number(fs.readFileSync(0, 'utf8').trim() || 0);
let r = 1;
for (let i = 2; i <= n; i++) r *= i;
console.log(r);
`,
      java: `import java.util.*;
public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        long r = 1;
        for (int i = 2; i <= n; i++) r *= i;
        System.out.print(r);
    }
}
`,
    },
    reverseQuoted: {
      python: `import sys
s = sys.stdin.read().strip()
q = s[:1] if s and s[0] in "\\"'" else ""
body = s[1:-1] if q and len(s) >= 2 and s[-1] == q else s
out = body[::-1]
print(f"{q}{out}{q}" if q else out, end="")
`,
      javascript: `const fs = require('fs');
let s = fs.readFileSync(0, 'utf8').trim();
const q = (s[0] === '"' || s[0] === "'") ? s[0] : '';
const body = q && s.endsWith(q) ? s.slice(1, -1) : s;
const out = [...body].reverse().join('');
process.stdout.write(q ? q + out + q : out);
`,
      java: `import java.util.*;
public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.hasNextLine() ? sc.nextLine().trim() : "";
        if (s.length() >= 2 && ((s.charAt(0) == '"' && s.endsWith("\\"")) || (s.charAt(0) == '\\'' && s.endsWith("'")))) {
            String body = s.substring(1, s.length() - 1);
            System.out.print(s.charAt(0) + new StringBuilder(body).reverse().toString() + s.charAt(0));
        } else {
            System.out.print(new StringBuilder(s).reverse().toString());
        }
    }
}
`,
    },
    maxJson: {
      python: `import json, sys
data = json.loads(sys.stdin.read().strip() or "[]")
arr = data if isinstance(data, list) else data.get("arr", [])
print(max(arr) if arr else 0)
`,
      javascript: `const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '[]');
const arr = Array.isArray(data) ? data : data.arr;
console.log(Math.max(...arr));
`,
      java: `import java.util.*;
public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String raw = sc.useDelimiter("\\\\A").hasNext() ? sc.next().trim() : "[]";
        raw = raw.replaceAll("[\\\\[\\\\]\\\\s]", "");
        if (raw.startsWith("{")) {
            int i = raw.indexOf('[');
            int j = raw.lastIndexOf(']');
            raw = (i >= 0 && j > i) ? raw.substring(i + 1, j).replaceAll("\\\\s", "") : "";
        }
        long max = Long.MIN_VALUE;
        boolean any = false;
        for (String p : raw.split(",")) {
            if (p.isEmpty()) continue;
            long v = Long.parseLong(p);
            if (!any || v > max) max = v;
            any = true;
        }
        System.out.print(any ? max : 0);
    }
}
`,
    },
    binarySearch: {
      python: `import ast, re, sys
raw = sys.stdin.read().strip()
m = re.match(r"\\[(.*)\\],\\s*(-?\\d+)\\s*$", raw)
if not m:
    print(-1, end="")
else:
    arr = ast.literal_eval("[" + m.group(1) + "]")
    target = int(m.group(2))
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            print(mid, end="")
            break
        if arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    else:
        print(-1, end="")
`,
      javascript: `const fs = require('fs');
const raw = fs.readFileSync(0, 'utf8').trim();
const m = raw.match(/^\\[(.*)\\],\\s*(-?\\d+)\\s*$/);
if (!m) {
  process.stdout.write('-1');
} else {
  const arr = JSON.parse('[' + m[1] + ']');
  const target = Number(m[2]);
  let lo = 0, hi = arr.length - 1, found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] === target) { found = mid; break; }
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  process.stdout.write(String(found));
}
`,
      java: `import java.util.*;
import java.util.regex.*;
public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String raw = sc.useDelimiter("\\\\A").hasNext() ? sc.next().trim() : "";
        Matcher m = Pattern.compile("\\\\[(.*)\\\\],\\\\s*(-?\\\\d+)\\\\s*$").matcher(raw);
        if (!m.find()) { System.out.print(-1); return; }
        String[] parts = m.group(1).trim().isEmpty() ? new String[0] : m.group(1).split(",");
        int[] arr = new int[parts.length];
        for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
        int target = Integer.parseInt(m.group(2));
        int lo = 0, hi = arr.length - 1, found = -1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            if (arr[mid] == target) { found = mid; break; }
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid - 1;
        }
        System.out.print(found);
    }
}
`,
    },
    armstrong: {
      python: `import sys
raw = sys.stdin.read().strip().split()
if len(raw) >= 2:
    lo, hi = int(raw[0]), int(raw[1])
else:
    n = int(raw[0]) if raw else 0
    lo, hi = 1, n

def is_armstrong(n):
    s = str(n)
    p = len(s)
    return n == sum(int(ch) ** p for ch in s)

print(" ".join(str(i) for i in range(lo, hi + 1) if is_armstrong(i)))
`,
      javascript: `const fs = require('fs');
const raw = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
let lo, hi;
if (raw.length >= 2) { lo = raw[0]; hi = raw[1]; }
else { lo = 1; hi = raw[0] || 0; }
const out = [];
for (let n = lo; n <= hi; n++) {
  const s = String(n);
  const p = s.length;
  const sum = [...s].reduce((a, ch) => a + Number(ch) ** p, 0);
  if (sum === n) out.push(n);
}
console.log(out.join(' '));
`,
    },
  };

  const byLang = programs[kind];
  if (byLang?.[lang]) return byLang[lang];
  if (byLang?.python && (lang === 'python' || !SUPPORTED.includes(lang))) return byLang.python;
  return stdinLookupCode(testCases, language);
}

function driverFunctionCode(question, language) {
  const lang = normalizeLang(language);
  const fn = extractFn(starterFor(question, lang), lang === 'java' ? 'javascript' : lang) ||
    extractFn(starterFor(question, lang === 'python' ? 'javascript' : 'python'), lang === 'python' ? 'javascript' : 'python');
  const kind = titleKind(question) || inferDriverKind(question.testCases);
  const name = fn?.name;
  const params = fn?.params || [];

  if (lang === 'python') {
    const fnName = name || (kind === 'maxArr' ? 'find_max' : kind === 'factorial' ? 'factorial' : 'sum_pair');
    if (kind === 'sumPair' && params.length >= 2) {
      return `def ${fnName}(${params[0]}, ${params[1]}):\n    return ${params[0]} + ${params[1]}\n`;
    }
    if (kind === 'maxArr') {
      const p = params[0] || 'arr';
      return `def ${fnName}(${p}):\n    return max(${p})\n`;
    }
    if (kind === 'factorial') {
      const p = params[0] || 'n';
      return `def ${fnName}(${p}):\n    return 1 if ${p} <= 1 else ${p} * ${fnName}(${p} - 1)\n`;
    }
  }

  if (lang === 'javascript') {
    const fnName = name || (kind === 'maxArr' ? 'findMax' : kind === 'factorial' ? 'factorial' : 'sumPair');
    if (kind === 'sumPair' && params.length >= 2) {
      return `function ${fnName}(${params[0]}, ${params[1]}) {\n  return ${params[0]} + ${params[1]};\n}\n`;
    }
    if (kind === 'maxArr') {
      const p = params[0] || 'arr';
      return `function ${fnName}(${p}) {\n  return Math.max(...${p});\n}\n`;
    }
    if (kind === 'factorial') {
      const p = params[0] || 'n';
      return `function ${fnName}(${p}) {\n  return ${p} <= 1 ? 1 : ${p} * ${fnName}(${p} - 1);\n}\n`;
    }
  }

  return stdinLookupCode(question.testCases, language);
}

function hasUsableCode(row) {
  return Boolean(String(row?.code || '').trim());
}

function buildDefaultSolutionCodes(question) {
  const langs = (question.languages?.length ? question.languages : ['javascript', 'python']).map(normalizeLang);
  const unique = [...new Set(langs.filter((lang) => SUPPORTED.includes(lang)))];
  const type = question.type;
  const hinted = titleKind(question);

  return unique.map((language) => {
    let code;
    if (type === 'codingWithDriver') {
      code = driverFunctionCode(question, language);
    } else {
      const kind = hinted || inferStdinKind(question.testCases);
      code = kind === 'lookup' ? stdinLookupCode(question.testCases, language) : stdinProgram(kind, language, question.testCases);
    }
    return { language, code };
  });
}

function applyDefaultSolutions(question) {
  if (!CODING_TYPES.includes(question.type)) {
    return question;
  }

  const generated = buildDefaultSolutionCodes(question);
  const existing = Array.isArray(question.solutionCodes) ? question.solutionCodes : [];
  const merged = generated.map((row) => {
    const hit = existing.find((item) => normalizeLang(item.language) === normalizeLang(row.language) && hasUsableCode(item));
    return hit ? { language: row.language, code: hit.code } : row;
  });

  for (const item of existing) {
    if (hasUsableCode(item) && !merged.some((row) => normalizeLang(row.language) === normalizeLang(item.language))) {
      merged.push({ language: item.language, code: item.code });
    }
  }

  question.solutionCodes = merged;

  if (!String(question.solutionCode || '').trim() && merged[0]) {
    question.solutionLanguage = merged[0].language;
    question.solutionCode = merged[0].code;
  } else if (!question.solutionLanguage && merged[0]) {
    question.solutionLanguage = merged[0].language;
  }

  if (question.type === 'fillInTheBlanksCoding') {
    if (!String(question.correctAnswer || '').trim()) {
      question.correctAnswer = 'return n <= 1 ? 1 : n * f(n - 1);';
    }
    if (!String(question.codeSnippet || '').trim()) {
      const jsStarter = starterFor(question, 'javascript') || starterFor(question, question.languages?.[0]);
      if (jsStarter) question.codeSnippet = jsStarter;
    }
  }

  return question;
}

module.exports = {
  CODING_TYPES,
  normalizeLang,
  buildDefaultSolutionCodes,
  applyDefaultSolutions,
};
