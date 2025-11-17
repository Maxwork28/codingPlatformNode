/**
 * Driver Code Templates for codingWithDriver question type
 * 
 * These templates handle input/output for student functions
 * STUDENT_CODE_PLACEHOLDER will be replaced with student's function code
 */

const driverCodeTemplates = {
    /**
     * JavaScript Driver Template
     * Receives test input as JSON via command line argument
     */
    javascript: `// STUDENT_CODE_PLACEHOLDER

// Driver Code
try {
    const testInput = JSON.parse(process.argv[2] || '{}');
    const result = FUNCTION_CALL;
    console.log(JSON.stringify(result));
} catch (error) {
    console.error('Runtime Error:', error.message);
    process.exit(1);
}`,

    /**
     * Python Driver Template
     * Receives test input as JSON via command line argument
     */
    python: `import sys
import json

# STUDENT_CODE_PLACEHOLDER

# Driver Code
try:
    test_input = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    result = FUNCTION_CALL
    print(json.dumps(result))
except Exception as error:
    print(f'Runtime Error: {str(error)}', file=sys.stderr)
    sys.exit(1)`,

    /**
     * C Driver Template
     * Note: C has limitations with JSON, so we use simpler input format
     */
    c: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// STUDENT_CODE_PLACEHOLDER

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "No input provided\\n");
        return 1;
    }
    
    // Driver Code
    // Parse input and call student function
    FUNCTION_CALL
    
    return 0;
}`,

    /**
     * C++ Driver Template
     */
    cpp: `#include <iostream>
#include <string>
#include <vector>
#include <sstream>
using namespace std;

// STUDENT_CODE_PLACEHOLDER

int main(int argc, char *argv[]) {
    if (argc < 2) {
        cerr << "No input provided" << endl;
        return 1;
    }
    
    try {
        // Driver Code
        // Parse input and call student function
        FUNCTION_CALL
    } catch (const exception& e) {
        cerr << "Runtime Error: " << e.what() << endl;
        return 1;
    }
    
    return 0;
}`,

    /**
     * Java Driver Template
     */
    java: `import java.util.*;
import com.google.gson.Gson;

// STUDENT_CODE_PLACEHOLDER

public class Solution {
    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("No input provided");
            System.exit(1);
        }
        
        try {
            // Driver Code
            Gson gson = new Gson();
            // Parse input and call student function
            FUNCTION_CALL
        } catch (Exception e) {
            System.err.println("Runtime Error: " + e.getMessage());
            System.exit(1);
        }
    }
}`,

    /**
     * PHP Driver Template
     */
    php: `<?php
// STUDENT_CODE_PLACEHOLDER

// Driver Code
try {
    $testInput = json_decode($argv[1] ?? '{}', true);
    $result = FUNCTION_CALL;
    echo json_encode($result);
} catch (Exception $e) {
    fwrite(STDERR, "Runtime Error: " . $e->getMessage() . "\\n");
    exit(1);
}
?>`,

    /**
     * Ruby Driver Template
     */
    ruby: `require 'json'

# STUDENT_CODE_PLACEHOLDER

# Driver Code
begin
    test_input = JSON.parse(ARGV[0] || '{}')
    result = FUNCTION_CALL
    puts JSON.generate(result)
rescue => e
    STDERR.puts "Runtime Error: #{e.message}"
    exit 1
end`,

    /**
     * Go Driver Template
     */
    go: `package main

import (
    "encoding/json"
    "fmt"
    "os"
)

// STUDENT_CODE_PLACEHOLDER

func main() {
    if len(os.Args) < 2 {
        fmt.Fprintln(os.Stderr, "No input provided")
        os.Exit(1)
    }
    
    // Driver Code
    var testInput map[string]interface{}
    if err := json.Unmarshal([]byte(os.Args[1]), &testInput); err != nil {
        fmt.Fprintf(os.Stderr, "Input parsing error: %v\\n", err)
        os.Exit(1)
    }
    
    // Call student function
    result := FUNCTION_CALL
    
    output, err := json.Marshal(result)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Output serialization error: %v\\n", err)
        os.Exit(1)
    }
    fmt.Println(string(output))
}`
};

/**
 * Generate function call string based on test input
 * @param {string} functionName - Name of the function
 * @param {object} testInput - Test input object
 * @returns {string} Function call string
 */
function generateFunctionCall(functionName, testInput) {
    const params = Object.keys(testInput).map(key => {
        const value = testInput[key];
        if (Array.isArray(value)) {
            return JSON.stringify(value);
        } else if (typeof value === 'string') {
            return `"${value}"`;
        } else {
            return value;
        }
    }).join(', ');
    
    return `${functionName}(${params})`;
}

/**
 * Build complete driver code for a specific language
 * @param {string} language - Programming language
 * @param {string} studentCode - Student's function code
 * @param {string} functionName - Name of the function to call
 * @param {object} testInput - Test input data
 * @returns {string} Complete code with driver
 */
function buildDriverCode(language, studentCode, functionName, testInput) {
    const template = driverCodeTemplates[language];
    if (!template) {
        throw new Error(`No driver template for language: ${language}`);
    }
    
    // Replace student code placeholder
    let code = template.replace('// STUDENT_CODE_PLACEHOLDER', studentCode);
    code = code.replace('# STUDENT_CODE_PLACEHOLDER', studentCode);
    
    // For languages that need explicit function calls in template
    // We'll handle this in the controller for now
    
    return code;
}

/**
 * Extract function name from function signature
 * @param {string} signature - Function signature
 * @returns {string} Function name
 */
function extractFunctionName(signature) {
    // JavaScript: function twoSum(nums, target)
    // Python: def twoSum(nums, target)
    // C/C++: vector<int> twoSum(vector<int>& nums, int target)
    
    const jsMatch = signature.match(/function\s+(\w+)/);
    if (jsMatch) return jsMatch[1];
    
    const pyMatch = signature.match(/def\s+(\w+)/);
    if (pyMatch) return pyMatch[1];
    
    const cppMatch = signature.match(/\w+\s+(\w+)\s*\(/);
    if (cppMatch) return cppMatch[1];
    
    // Fallback: try to find word before opening parenthesis
    const genericMatch = signature.match(/(\w+)\s*\(/);
    if (genericMatch) return genericMatch[1];
    
    throw new Error(`Cannot extract function name from signature: ${signature}`);
}

module.exports = {
    driverCodeTemplates,
    buildDriverCode,
    generateFunctionCall,
    extractFunctionName
};






