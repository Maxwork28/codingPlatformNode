const XLSX = require('xlsx');
const { faker } = require('@faker-js/faker');

const OUTPUT_FILE = 'users_credentials.xlsx';

const users = [];

for (let i = 0; i < 2; i++) {
  users.push({
    name: faker.person.fullName(),
    email: `admin${i + 1}@example.com`,
    role: 'admin',
    password: 'Password123!'
  });
}

for (let i = 0; i < 5; i++) {
  users.push({
    name: faker.person.fullName(),
    email: `teacher${i + 1}@example.com`,
    role: 'teacher',
    password: 'Password123!'
  });
}

for (let i = 0; i < 50; i++) {
  users.push({
    name: faker.person.fullName(),
    email: `student${i + 1}@example.com`,
    role: 'student',
    password: 'Password123!'
  });
}

const excelData = users.map((user, index) => ({
  ID: index + 1,
  Name: user.name,
  Email: user.email,
  Role: user.role,
  Password: user.password
}));

const worksheet = XLSX.utils.json_to_sheet(excelData);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'Users');

worksheet['!cols'] = [
  { wch: 5 },
  { wch: 25 },
  { wch: 25 },
  { wch: 15 },
  { wch: 15 }
];

XLSX.writeFile(workbook, OUTPUT_FILE);
console.log(`Excel file "${OUTPUT_FILE}" generated successfully with ${excelData.length} users.`);