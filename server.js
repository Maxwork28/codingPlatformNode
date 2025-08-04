const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/auth');
const questionRoutes = require('./routes/questionRoutes');
const User = require('./models/User');
const Class = require('./models/Class');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'https://www.algosutra.co.in', 
        // origin: 'http://localhost:5173',
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
});

app.use(cors({ origin: 'https://www.algosutra.co.in', credentials: true }));
// app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true }));
// Middleware to attach io to req
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Routes
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/questions', questionRoutes);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('[Socket.IO] Client connected:', socket.id);

    // Join class-specific room
    socket.on('joinClass', (classId) => {
        socket.join(`class:${classId}`);
        console.log(`[Socket.IO] Client ${socket.id} joined class:${classId}`);
    });

    socket.on('disconnect', () => {
        console.log('[Socket.IO] Client disconnected:', socket.id);
    });
});

// async function createInitialAdmin() {
//     try {
//         const existingAdmin = await User.findOne({ email: 'admin@example.com' });
//         if (existingAdmin) {
//             console.log('Admin already exists');
//             return;
//         }

//         const admin = new User({
//             name: 'Admin',
//             email: 'admin@example.com',
//             number: '1234567890',
//             role: 'admin',
//             password: await bcrypt.hash('admin123', 10),
//         });

//         await admin.save();
//         console.log('Initial admin created');
//     } catch (err) {
//         console.error('Error creating admin:', err);
//     }
// }

mongoose.connect('mongodb://localhost:27017/education_platform').then(async () => {
    console.log('MongoDB connected');
    // await createInitialAdmin();
    server.listen(3000, () => console.log('Server started on port 3000'));
}).catch(err => console.error('MongoDB connection error:', err));