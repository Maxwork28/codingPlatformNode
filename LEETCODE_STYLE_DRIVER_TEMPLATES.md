# LeetCode-Style Driver Code Templates

This guide explains how to create **LeetCode-style** coding questions where students only write the solution function—the platform handles input parsing and output.

## How It Works

1. **Template code** (starter code): What students see and edit — the function signature
2. **Driver code**: Hidden code that reads test input, calls the student's function, prints the result
3. **Placeholder**: Where student code is injected — use `{{USER_CODE}}`, `// USER_CODE_HERE`, or `# USER_CODE_HERE`

## Test Case Format

For LeetCode-style questions, test case **input** is JSON that maps to function parameters:

| Question        | Input (JSON)                    | Expected Output |
|-----------------|---------------------------------|-----------------|
| Find Max        | `{"arr": [1, 5, 3, 9, 2]}`      | `9`             |
| Two Sum         | `{"nums": [2,7,11,15], "target": 9}` | `[0, 1]`   |
| Reverse String  | `{"s": "hello"}`                | `olleh`         |

---

## Example: Find Maximum Element

### Question Setup

- **Type**: `codingWithDriver`
- **Function**: `def find_max(arr):`
- **Languages**: Python, JavaScript

### Python Driver Code

```python
import json

# {{USER_CODE}}

if __name__ == "__main__":
    data = json.loads(input())
    arr = data["arr"]
    result = find_max(arr)
    print(result)
```

### Python Starter Code (what students see)

```python
def find_max(arr):
    # Your code here
    pass
```

### Python Test Cases

| Input | Expected Output |
|-------|-----------------|
| `{"arr": [1, 5, 3, 9, 2]}` | `9` |
| `{"arr": [-1, -5, -3]}` | `-1` |
| `{"arr": [42]}` | `42` |

---

## Example: Two Sum (Multiple Parameters)

### JavaScript Driver Code

```javascript
// {{USER_CODE}}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const data = JSON.parse(line);
  const result = twoSum(data.nums, data.target);
  console.log(JSON.stringify(result));
});
```

### JavaScript Starter Code

```javascript
function twoSum(nums, target) {
    // Your code here
    return [];
}
```

### Alternative: Use `# USER_CODE_HERE` for Python

```python
import json

# USER_CODE_HERE

if __name__ == "__main__":
    data = json.loads(input())
    result = two_sum(data["nums"], data["target"])
    print(json.dumps(result))
```

---

## Driver Templates by Language

### Python (single parameter)

```python
import json

# {{USER_CODE}}

if __name__ == "__main__":
    data = json.loads(input())
    result = your_function(data["param_name"])
    # For numbers: print(result)
    # For lists: print(json.dumps(result))
```

### Python (multiple parameters)

```python
import json

# {{USER_CODE}}

if __name__ == "__main__":
    data = json.loads(input())
    result = your_function(data["a"], data["b"])
    print(result)
```

### JavaScript / Node.js

```javascript
// {{USER_CODE}}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const data = JSON.parse(line);
  const result = yourFunction(data.param1, data.param2);
  console.log(typeof result === 'object' ? JSON.stringify(result) : result);
});
```

### Java

```java
import java.util.*;
import org.json.*;

// USER_CODE_HERE

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        JSONObject data = new JSONObject(sc.nextLine());
        JSONArray arr = data.getJSONArray("arr");
        int[] nums = new int[arr.length()];
        for (int i = 0; i < arr.length(); i++) nums[i] = arr.getInt(i);
        int result = findMax(nums);
        System.out.println(result);
    }
}
```

*Note: Java may need a JSON library. For simpler cases, use a custom parser or restrict to single-line input.*

### C++

```cpp
#include <iostream>
#include <vector>
#include <sstream>
// USER_CODE_HERE

int main() {
    std::string line;
    std::getline(std::cin, line);
    // Parse JSON or use simple format
    std::vector<int> arr = parseArray(line);
    int result = find_max(arr);
    std::cout << result << std::endl;
}
```

---

## Creating a LeetCode-Style Question via API

When creating a question with type `codingWithDriver`, include `driverCode` in the payload:

```json
{
  "type": "codingWithDriver",
  "title": "Find Maximum Element",
  "description": "Write a function to find the maximum element in an array of integers.",
  "difficulty": "easy",
  "languages": ["python", "javascript"],
  "templateCode": [
    {
      "language": "python",
      "code": "def find_max(arr):\n    # Your code here\n    pass"
    },
    {
      "language": "javascript",
      "code": "function findMax(arr) {\n    // Your code here\n    return 0;\n}"
    }
  ],
  "driverCode": [
    {
      "language": "python",
      "code": "import json\n\n# {{USER_CODE}}\n\nif __name__ == \"__main__\":\n    data = json.loads(input())\n    arr = data[\"arr\"]\n    result = find_max(arr)\n    print(result)"
    },
    {
      "language": "javascript",
      "code": "// {{USER_CODE}}\n\nconst readline = require('readline');\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const data = JSON.parse(line);\n  const result = findMax(data.arr);\n  console.log(result);\n});"
    }
  ],
  "testCases": [
    {
      "input": "{\"arr\": [1, 5, 3, 9, 2]}",
      "expectedOutput": "9",
      "isPublic": true
    },
    {
      "input": "{\"arr\": [-1, -5, -3]}",
      "expectedOutput": "-1",
      "isPublic": true
    }
  ],
  "timeLimit": 2,
  "memoryLimit": 256
}
```

---

## Placeholder Reference

| Placeholder       | Use Case                    |
|-------------------|-----------------------------|
| `{{USER_CODE}}`   | Universal (any language)    |
| `// USER_CODE_HERE` | C, C++, Java, JavaScript, Go |
| `# USER_CODE_HERE`  | Python, Ruby                |

The platform replaces the placeholder with the student's submitted code before execution.

---

## Frontend: Question Form Updates

To create LeetCode-style questions from the UI, the QuestionForm should:

1. Add **"Coding (LeetCode-style)"** as a question type option
2. Show a **Driver Code** section (collapsible) when `codingWithDriver` is selected
3. Provide driver code per language, similar to starter code
4. Validate that each driver contains a placeholder
