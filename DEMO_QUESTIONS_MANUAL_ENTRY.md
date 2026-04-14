# Demo questions — manual entry cheat sheet

Use these examples in the admin/teach UI or when posting to the API.  
**Languages allowed:** `javascript`, `c`, `cpp`, `java`, `python`, `php`, `ruby`, `go`

**Important:** Admin “create question” (`adminController`) accepts  
`singleCorrectMcq`, `multipleCorrectMcq`, `fillInTheBlanks`, `fillInTheBlanksCoding`, `coding`  
and uses **`starterCode`** for coding types.  
**`codingWithDriver`** is validated on **teacher question assignment** / edits and uses **`templateCode`** + **`driverCode`** (not `starterCode`).

Test cases for runnable types must include **`input`**, **`expectedOutput`**, and **`isPublic`** (`true` or `false`).  
`timeLimit` and `memoryLimit` must be **numbers** &gt; 0 (e.g. `2` and `256`).

---

## 1. `singleCorrectMcq`

| Field | Example |
|--------|---------|
| **type** | `singleCorrectMcq` |
| **title** | Demo: Capital of France |
| **description** | What is the capital of France? |
| **difficulty** | `easy` |
| **options** | `["Paris", "London", "Berlin", "Madrid"]` |
| **correctOption** | `0` (index of correct choice) |
| **points** | `10` |

**Correct answer:** Paris → index `0`.

---

## 2. `multipleCorrectMcq`

| Field | Example |
|--------|---------|
| **type** | `multipleCorrectMcq` |
| **title** | Demo: Even numbers |
| **description** | Select all **even** numbers. |
| **difficulty** | `easy` |
| **options** | `["2", "3", "4", "7"]` |
| **correctOptions** | `[0, 2]` (indices 2 and 4 are correct) |
| **points** | `10` |

---

## 3. `fillInTheBlanks`

| Field | Example |
|--------|---------|
| **type** | `fillInTheBlanks` |
| **title** | Demo: HTML tag |
| **description** | The paragraph tag in HTML is `______`. |
| **difficulty** | `easy` |
| **correctAnswer** | `p` |
| **points** | `15` |

Matching is **case-insensitive** on submit.

---

## 4. `fillInTheBlanksCoding`

The backend replaces the literal substring **`// FILL_IN_THE_BLANK`** in **`codeSnippet`** with the student’s answer, then runs the result.  
Use **exactly** that marker (see `questionController.js` — other placeholders like `___FILL_IN_THE_BLANK___` are **not** substituted).

You still provide **`starterCode`** (admin), **`languages`**, **`testCases`**, **`timeLimit`**, **`memoryLimit`**, and **`correctAnswer`** (required for grading checks).

| Field | Example |
|--------|---------|
| **type** | `fillInTheBlanksCoding` |
| **title** | Demo: Double the input |
| **description** | Read an integer from stdin. Student completes the line so the program prints **double** that number. |
| **difficulty** | `easy` |
| **languages** | `["python"]` |
| **codeSnippet** | See below (Python) |
| **correctAnswer** | `y = x * 2` |
| **starterCode** | `[{ "language": "python", "code": "x = int(input())\\n// FILL_IN_THE_BLANK\\nprint(y)" }]` (often mirrors snippet) |
| **testCases** | See below |
| **timeLimit** | `2` |
| **memoryLimit** | `256` |

**codeSnippet** (one line must be exactly `// FILL_IN_THE_BLANK` — it is replaced entirely, so the file is valid Python after substitution):

```python
x = int(input())
// FILL_IN_THE_BLANK
print(y)
```

**correctAnswer** (the line students should type):

```text
y = x * 2
```

**JavaScript alternative** (same marker in **`codeSnippet`**):

```javascript
const fs = require('fs');
const x = Number(fs.readFileSync(0, 'utf8').trim());
// FILL_IN_THE_BLANK
console.log(y);
```

**correctAnswer:** `const y = x * 2;`

**testCases** (stdin is one line; program prints doubled value):

```json
[
  { "input": "3", "expectedOutput": "6", "isPublic": true },
  { "input": "0", "expectedOutput": "0", "isPublic": true },
  { "input": "-4", "expectedOutput": "-8", "isPublic": false }
]
```

---

## 5. `coding` (stdin/stdout — full solution)

Admin flow: **`starterCode`** + **`languages`** + **`testCases`**.  
Program is the student’s **full** submitted code; stdin is each test’s **`input`** (piped as one `echo` line — keep input simple, usually one line).

**Python example**

| Field | Example |
|--------|---------|
| **type** | `coding` |
| **title** | Demo: A + B |
| **description** | Read two integers from stdin (space-separated on one line). Print their sum. |
| **difficulty** | `easy` |
| **languages** | `["python"]` |
| **starterCode** | `[{ "language": "python", "code": "a, b = map(int, input().split())\\nprint(a + b)" }]` |
| **testCases** | `[{ "input": "2 3", "expectedOutput": "5", "isPublic": true }, { "input": "10 20", "expectedOutput": "30", "isPublic": false }]` |
| **timeLimit** | `2` |
| **memoryLimit** | `256` |

---

## 6. `codingWithDriver` (LeetCode-style — teacher / assign flow)

Use **teacher “assign to class”** or **edit question** APIs — fields use **`templateCode`**, not `starterCode`.

| Field | Example |
|--------|---------|
| **type** | `codingWithDriver` |
| **title** | Demo: Array maximum |
| **description** | Implement `find_max(arr)` returning the maximum number in `arr`. |
| **difficulty** | `easy` |
| **languages** | `["python"]` |
| **templateCode** | `[{ "language": "python", "code": "def find_max(arr):\\n    pass" }]` |
| **driverCode** | `[{ "language": "python", "code": "<driver below>" }]` |
| **testCases** | `[{ "input": "{\\\"arr\\\": [1, 5, 3, 9, 2]}", "expectedOutput": "9", "isPublic": true }]` |
| **timeLimit** | `2` |
| **memoryLimit** | `256` |

**Python driver** (must inject student code with `{{USER_CODE}}`, `// USER_CODE_HERE`, or `# USER_CODE_HERE`):

```python
import json

# {{USER_CODE}}

if __name__ == "__main__":
    data = json.loads(input())
    result = find_max(data["arr"])
    print(result)
```

**Student solution** (for your own testing):

```python
def find_max(arr):
    return max(arr)
```

For more patterns, see `LEETCODE_STYLE_DRIVER_TEMPLATES.md`.

---

## Quick API shapes (JSON)

### Admin create question (coding type uses `starterCode`)

```json
{
  "type": "coding",
  "title": "Demo: A + B",
  "description": "Read two integers from one line, print sum.",
  "difficulty": "easy",
  "languages": ["python"],
  "starterCode": [{ "language": "python", "code": "a, b = map(int, input().split())\nprint(a + b)" }],
  "testCases": [
    { "input": "2 3", "expectedOutput": "5", "isPublic": true }
  ],
  "timeLimit": 2,
  "memoryLimit": 256
}
```

### Teacher assign (uses `templateCode`; `codingWithDriver` adds `driverCode`)

```json
{
  "type": "codingWithDriver",
  "title": "Demo: Max in array",
  "description": "Return max of arr.",
  "difficulty": "easy",
  "languages": ["python"],
  "templateCode": [{ "language": "python", "code": "def find_max(arr):\n    pass" }],
  "driverCode": [{ "language": "python", "code": "import json\n\n# {{USER_CODE}}\n\nif __name__ == \"__main__\":\n    data = json.loads(input())\n    print(find_max(data[\"arr\"]))" }],
  "testCases": [
    { "input": "{\"arr\": [1, 5, 3]}", "expectedOutput": "5", "isPublic": true }
  ],
  "timeLimit": 2,
  "memoryLimit": 256,
  "classIds": ["<yourClassId>"]
}
```

---

## Checks if something fails

- **“Invalid question type”** on admin create → `codingWithDriver` is not allowed there; use teacher assign or draft + edit path.
- **Coding run fails** → Docker images (`python-compiler`, etc.) must exist; test `input` / `expectedOutput` must match **trimmed** stdout.
- **fillInTheBlanksCoding** → Must include **`codeSnippet`** with **`// FILL_IN_THE_BLANK`** and **`correctAnswer`** set, or submissions can error.
