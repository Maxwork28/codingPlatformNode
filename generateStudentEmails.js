const XLSX = require('xlsx');

// Generate student emails based on the seedDatabase logic
const studentEmails = [];
for (let i = 1; i <= 50; i++) {
  studentEmails.push(`student${i}@example.com`);
}

// Create worksheet data
const worksheetData = [
  ['Email'], // Header row
  ...studentEmails.map(email => [email]), // Data rows
];

// Create a new workbook and worksheet
const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);

// Append the worksheet to the workbook
XLSX.utils.book_append_sheet(workbook, worksheet, 'Students');

// Write the workbook to a file
XLSX.writeFile(workbook, 'students.xlsx');

console.log('Excel file "students.xlsx" generated successfully!');