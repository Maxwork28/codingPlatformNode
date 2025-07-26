// const mongoose = require('mongoose');
// const bcrypt = require('bcrypt');
// const User = require('../models/User');
// const { faker } = require('@faker-js/faker');

// // Connect to MongoDB
// mongoose.connect('mongodb://localhost:27017/userUploadApp', {
//     useNewUrlParser: true,
//     useUnifiedTopology: true,
// }).then(() => {
//     console.log('MongoDB connected for student creation');
//     createStudents();
// }).catch(err => {
//     console.error('MongoDB connection error:', err);
//     process.exit(1);
// });

// // Function to create 30 students
// async function createStudents() {
//     try {
//         const students = [];
//         const defaultPassword = 'student123'; // Default password for all students
//         const hashedPassword = await bcrypt.hash(defaultPassword, 10);

//         // Generate 30 unique students
//         for (let i = 1; i <= 30; i++) {
//             const firstName = faker.person.firstName();
//             const lastName = faker.person.lastName();
//             const email = `student${i}@example.com`; // Unique email
//             const number = faker.phone.number('##########'); // 10-digit number

//             students.push({
//                 name: `${firstName} ${lastName}`,
//                 email,
//                 number,
//                 role: 'student',
//                 password: hashedPassword,
//                 canCreateClass: false // Explicitly set for consistency
//             });
//         }

//         // Insert students into database
//         await User.insertMany(students, { ordered: false });
//         console.log('30 students created successfully');
//         console.log('Sample credentials:');
//         console.log(`Email: student1@example.com, Password: ${defaultPassword}`);
//         console.log('Emails follow the pattern: student1@example.com to student30@example.com');

//         mongoose.connection.close();
//         process.exit(0);
//     } catch (err) {
//         console.error('Error creating students:', err);
//         mongoose.connection.close();
//         process.exit(1);
//     }
// }