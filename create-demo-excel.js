const XLSX = require('xlsx');

// Create demo data for students
const students = [
    { name: 'John Doe', email: 'john.doe@example.com', number: '1234567890' },
    { name: 'Jane Smith', email: 'jane.smith@example.com', number: '2345678901' },
    { name: 'Alice Johnson', email: 'alice.johnson@example.com', number: '3456789012' },
    { name: 'Bob Williams', email: 'bob.williams@example.com', number: '4567890123' },
    { name: 'Charlie Brown', email: 'charlie.brown@example.com', number: '5678901234' },
    { name: 'Diana Prince', email: 'diana.prince@example.com', number: '6789012345' },
    { name: 'Eve Davis', email: 'eve.davis@example.com', number: '7890123456' },
    { name: 'Frank Miller', email: 'frank.miller@example.com', number: '8901234567' },
    { name: 'Grace Lee', email: 'grace.lee@example.com', number: '9012345678' },
    { name: 'Henry Taylor', email: 'henry.taylor@example.com', number: '0123456789' }
];

// Create demo data for teachers
const teachers = [
    { name: 'Dr. Sarah Connor', email: 'sarah.connor@example.com', number: '1111111111' },
    { name: 'Prof. Michael Chen', email: 'michael.chen@example.com', number: '2222222222' },
    { name: 'Dr. Emily Watson', email: 'emily.watson@example.com', number: '3333333333' },
    { name: 'Prof. David Kumar', email: 'david.kumar@example.com', number: '4444444444' },
    { name: 'Dr. Lisa Anderson', email: 'lisa.anderson@example.com', number: '5555555555' }
];

// Create workbook for students
const studentsWorksheet = XLSX.utils.json_to_sheet(students);
const studentsWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(studentsWorkbook, studentsWorksheet, 'Students');

// Set column widths for students file
studentsWorksheet['!cols'] = [
    { wch: 20 }, // name
    { wch: 30 }, // email
    { wch: 15 }  // number
];

XLSX.writeFile(studentsWorkbook, 'demo_students.xlsx');
console.log('✓ Created demo_students.xlsx with', students.length, 'students');

// Create workbook for teachers
const teachersWorksheet = XLSX.utils.json_to_sheet(teachers);
const teachersWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(teachersWorkbook, teachersWorksheet, 'Teachers');

// Set column widths for teachers file
teachersWorksheet['!cols'] = [
    { wch: 20 }, // name
    { wch: 30 }, // email
    { wch: 15 }  // number
];

XLSX.writeFile(teachersWorkbook, 'demo_teachers.xlsx');
console.log('✓ Created demo_teachers.xlsx with', teachers.length, 'teachers');

console.log('\n📋 Excel File Format:');
console.log('   Required columns: name, email, number (or phone)');
console.log('   Column names are case-insensitive (Name/name/NAME all work)');
console.log('\n📤 Upload Instructions:');
console.log('   1. Use demo_students.xlsx for student onboarding');
console.log('   2. Use demo_teachers.xlsx for teacher onboarding');
console.log('   3. Select the role (student/teacher) when uploading');
console.log('   4. The system will auto-generate passwords and email them');

