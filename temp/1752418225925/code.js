function findMax(arr) {
    if (!arr || arr.length === 0) return null; // Handle empty or invalid array
    return Math.max(...arr); // Find maximum using spread operator
}