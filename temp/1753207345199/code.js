// Read input from stdin
const fs = require('fs');
const input = fs.readFileSync('/dev/stdin').toString().trim().split('\n');

// For simplicity, assume input is a single line of space-separated integers
const arr = input[0].split(' ').map(Number);

// Find maximum element
const max = Math.max(...arr);

// Output the result
console.log(max);