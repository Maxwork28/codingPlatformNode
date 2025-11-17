# Architecture Diagram - AlgoSutra Coding Platform

## 🏗️ System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            CLIENT LAYER                                  │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     React Application (Vite)                      │  │
│  │  Port: 5173/5174          Theme: Light/Dark                       │  │
│  ├──────────────────────────────────────────────────────────────────┤  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  │
│  │  │   Admin    │  │  Teacher   │  │  Student   │                  │  │
│  │  │  Dashboard │  │  Dashboard │  │  Dashboard │                  │  │
│  │  └────────────┘  └────────────┘  └────────────┘                  │  │
│  │                                                                    │  │
│  │  Components:                                                       │  │
│  │  • Navbar & Sidebar    • Code Editor (React Ace)                  │  │
│  │  • Charts (Chart.js)   • Leaderboard Tables                       │  │
│  │  • Question Cards      • Rich Text Editor (Slate)                 │  │
│  │                                                                    │  │
│  │  State Management:                                                 │  │
│  │  • Redux Toolkit (Auth, Class, Question Slices)                   │  │
│  │  • Context API (Theme, Sidebar)                                   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS/WSS
                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                                │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              Express.js Server + Socket.IO                        │  │
│  │              Port: 3000                                            │  │
│  │              API: http://localhost:3000                      │  │
│  ├──────────────────────────────────────────────────────────────────┤  │
│  │                                                                    │  │
│  │  Middleware Layer:                                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │  │
│  │  │     CORS     │  │  JWT Auth    │  │   Multer     │           │  │
│  │  │   Handler    │  │  Middleware  │  │   (Upload)   │           │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘           │  │
│  │                                                                    │  │
│  │  Routing Layer:                                                    │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │  │
│  │  │ /auth        │  │  /admin      │  │  /questions  │           │  │
│  │  │ Login        │  │  Classes     │  │  Assign      │           │  │
│  │  │ Register     │  │  Users       │  │  Submit      │           │  │
│  │  │ Reset Pass   │  │  Upload      │  │  Run Code    │           │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘           │  │
│  │          │                  │                  │                   │  │
│  │          └──────────────────┴──────────────────┘                   │  │
│  │                            │                                        │  │
│  │  Controller Layer:                                                 │  │
│  │  ┌──────────────────────────────────────────────────────────┐    │  │
│  │  │  adminController  │  questionController  │  contactController│ │  │
│  │  └──────────────────────────────────────────────────────────┘    │  │
│  │                            │                                        │  │
│  └────────────────────────────┼────────────────────────────────────── │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA & SERVICES LAYER                            │
│                                                                           │
│  ┌──────────────────────┐  ┌──────────────────────┐                    │
│  │   MongoDB Database   │  │   Docker Engine      │                    │
│  │   Port: 27017        │  │   dockerode API      │                    │
│  ├──────────────────────┤  ├──────────────────────┤                    │
│  │                      │  │                      │                    │
│  │  Collections:        │  │  Container Images:   │                    │
│  │  • users             │  │  • javascript-compiler│                   │
│  │  • classes           │  │  • c-compiler        │                    │
│  │  • questions         │  │  • cpp-compiler      │                    │
│  │  • submissions       │  │  • java-compiler     │                    │
│  │  • leaderboards      │  │  • python-compiler   │                    │
│  │                      │  │  • php-compiler      │                    │
│  │  Indexes:            │  │  • ruby-compiler     │                    │
│  │  • User email        │  │  • go-compiler       │                    │
│  │  • Class queries     │  │                      │                    │
│  │  • Question tags     │  │  Features:           │                    │
│  │  • Leaderboard rank  │  │  • Network isolation │                    │
│  │                      │  │  • Memory limits     │                    │
│  └──────────────────────┘  │  • CPU constraints   │                    │
│                            │  • Auto cleanup      │                    │
│                            └──────────────────────┘                    │
│                                                                           │
│  ┌──────────────────────┐  ┌──────────────────────┐                    │
│  │   Email Service      │  │   File Storage       │                    │
│  │   (Nodemailer)       │  │   (Local FS)         │                    │
│  ├──────────────────────┤  ├──────────────────────┤                    │
│  │                      │  │                      │                    │
│  │  • Gmail SMTP        │  │  • /temp directory   │                    │
│  │  • Password reset    │  │  • /uploads (Excel)  │                    │
│  │  • Contact form      │  │  • /docker files     │                    │
│  │  • Welcome emails    │  │  • Temp code files   │                    │
│  └──────────────────────┘  └──────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Data Flow Diagrams

### 1. Authentication Flow

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│          │   1. Login Request │          │   2. Query User    │          │
│  Client  │───────────────────▶│  Server  │───────────────────▶│ MongoDB  │
│          │    email/password  │          │                    │          │
└──────────┘                    └──────────┘                    └──────────┘
     ▲                               │                               │
     │                               │                               │
     │  5. JWT Token                 │                               │
     │  + User Details               │                               │
     │                               │◀──────────────────────────────┘
     │                               │   3. User Document
     │                               │
     │                               │   4. Verify Password
     │                               │      (bcrypt.compare)
     │                               │      Generate JWT
     └───────────────────────────────┘
```

### 2. Code Submission Flow

```
┌──────────┐    1. Submit Code    ┌──────────┐    2. Validate     ┌──────────┐
│ Student  │─────────────────────▶│  Server  │───────────────────▶│ MongoDB  │
│ Frontend │   (code + language)  │          │  Question/Class    │          │
└──────────┘                      └──────────┘                    └──────────┘
                                       │                               │
                                       │◀──────────────────────────────┘
                                       │   3. Question Details
                                       │
                                       │   4. Create Container
                                       ▼
                              ┌────────────────┐
                              │ Docker Engine  │
                              ├────────────────┤
                              │ • Write code   │
                              │ • Compile (if  │
                              │   needed)      │
                              │ • Run tests    │
                              │ • Capture      │
                              │   output       │
                              └────────────────┘
                                       │
                                       │   5. Test Results
                                       ▼
                              ┌────────────────┐
                              │     Server     │
                              ├────────────────┤
                              │ • Calculate    │
                              │   score        │
                              │ • Save         │
                              │   submission   │
                              │ • Update       │
                              │   leaderboard  │
                              └────────────────┘
                                       │
                                       │   6. Emit Socket Event
                                       ▼
                              ┌────────────────┐
                              │   Socket.IO    │
                              │   (Broadcast)  │
                              └────────────────┘
                                       │
                                       │   7. Live Update
                                       ▼
                              ┌────────────────┐
                              │  All Clients   │
                              │  in Class      │
                              └────────────────┘
```

### 3. Teacher Question Assignment Flow

```
┌──────────┐    1. Create Q     ┌──────────┐    2. Save Question  ┌──────────┐
│ Teacher  │───────────────────▶│  Server  │────────────────────▶│ MongoDB  │
│ Frontend │   + Select Classes │          │   with classes[]    │          │
└──────────┘                    └──────────┘                     └──────────┘
                                     │                                │
                                     │◀───────────────────────────────┘
                                     │   3. Question ID
                                     │
                                     │   4. Update Class.questions[]
                                     │      for each selected class
                                     ▼
                              ┌──────────┐
                              │ MongoDB  │
                              ├──────────┤
                              │ Update   │
                              │ Classes  │
                              └──────────┘
                                     │
                                     │   5. Success Response
                                     ▼
                              ┌──────────┐
                              │ Teacher  │
                              │ Frontend │
                              └──────────┘
```

### 4. Admin Bulk Upload Flow

```
┌──────────┐   1. Upload Excel   ┌──────────┐   2. Parse File   ┌──────────┐
│  Admin   │────────────────────▶│  Server  │──────────────────▶│ ExcelJS  │
│ Frontend │     (.xlsx file)    │          │                   │ Parser   │
└──────────┘                     └──────────┘                   └──────────┘
                                      │                              │
                                      │◀─────────────────────────────┘
                                      │   3. User Data Array
                                      │
                                      │   4. For each user:
                                      │      • Generate password
                                      │      • Hash password
                                      │      • Create User doc
                                      ▼
                              ┌──────────────┐
                              │   MongoDB    │
                              │  (Bulk Save) │
                              └──────────────┘
                                      │
                                      │   5. User IDs
                                      ▼
                              ┌──────────────┐
                              │  Nodemailer  │
                              ├──────────────┤
                              │ • Send email │
                              │   to each    │
                              │   user       │
                              │ • Include    │
                              │   credentials│
                              └──────────────┘
                                      │
                                      │   6. Success Report
                                      ▼
                              ┌──────────────┐
                              │    Admin     │
                              │   Frontend   │
                              └──────────────┘
```

---

## 🎭 Role-Based Access Control (RBAC)

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Hierarchy                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                      ┌──────────────┐                           │
│                      │  Super Admin │                           │
│                      └───────┬──────┘                           │
│                              │                                   │
│                   Full System Access                            │
│                              │                                   │
│          ┌───────────────────┼───────────────────┐             │
│          │                   │                   │             │
│     ┌────▼────┐         ┌────▼────┐        ┌────▼────┐       │
│     │  Admin  │         │ Teacher │        │ Student │       │
│     └────┬────┘         └────┬────┘        └────┬────┘       │
│          │                   │                   │             │
│          │                   │                   │             │
│  ┌───────────────┐   ┌───────────────┐   ┌─────────────┐    │
│  │ • Manage      │   │ • Create Q    │   │ • View      │    │
│  │   Classes     │   │ • Assign Q    │   │   Classes   │    │
│  │ • Manage      │   │ • View        │   │ • Attempt   │    │
│  │   Users       │   │   Submissions │   │   Questions │    │
│  │ • Upload      │   │ • Test Code   │   │ • Submit    │    │
│  │   Excel       │   │ • Monitor     │   │   Code      │    │
│  │ • View All    │   │   Class       │   │ • View      │    │
│  │   Analytics   │   │ • Block       │   │   Leaderboard│   │
│  │ • Create Q    │   │   Students    │   │ • Run Code  │    │
│  │ • Assign Q    │   │ • View Stats  │   │ • Custom    │    │
│  │              │   │               │   │   Input     │    │
│  └───────────────┘   └───────────────┘   └─────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 Component Relationships

### Frontend Component Hierarchy

```
App.jsx
│
├─ ThemeProvider
│  └─ SidebarProvider
│     │
│     ├─ Navbar (Global)
│     │  ├─ ThemeToggle
│     │  ├─ UserProfile
│     │  └─ Notifications
│     │
│     ├─ Sidebar (Role-based)
│     │  ├─ Navigation Links
│     │  ├─ Role Badge
│     │  └─ Collapse Toggle
│     │
│     └─ MainContent (Routes)
│        │
│        ├─ Admin Routes
│        │  ├─ AdminDashboard
│        │  │  ├─ StatsCards
│        │  │  ├─ Charts
│        │  │  └─ RecentActivity
│        │  │
│        │  ├─ ClassManagement
│        │  │  ├─ ClassList
│        │  │  ├─ CreateClass
│        │  │  └─ ClassDetails
│        │  │
│        │  ├─ StudentManagement
│        │  │  ├─ StudentList
│        │  │  ├─ EditStudent
│        │  │  └─ BlockStudent
│        │  │
│        │  ├─ TeacherManagement
│        │  ├─ ExcelUpload
│        │  └─ QuestionBanks
│        │
│        ├─ Teacher Routes
│        │  ├─ TeacherDashboard
│        │  ├─ ClassView
│        │  │  ├─ Students Tab
│        │  │  ├─ Questions Tab
│        │  │  └─ Assignments Tab
│        │  │
│        │  ├─ CreateQuestion
│        │  │  ├─ QuestionForm
│        │  │  ├─ TestCaseEditor
│        │  │  └─ StarterCodeEditor
│        │  │
│        │  ├─ QuestionManagement
│        │  │  ├─ QuestionList
│        │  │  ├─ QuestionPreview
│        │  │  └─ QuestionEdit
│        │  │
│        │  └─ TakeClass (Live)
│        │     ├─ Leaderboard
│        │     ├─ StudentActivity
│        │     └─ BlockControls
│        │
│        └─ Student Routes
│           ├─ StudentDashboard
│           ├─ ClassView
│           │  ├─ QuestionList
│           │  └─ MyProgress
│           │
│           ├─ QuestionSubmission
│           │  ├─ QuestionStatement
│           │  ├─ CodeEditor
│           │  │  ├─ Language Selector
│           │  │  ├─ Ace Editor
│           │  │  └─ Run/Submit Buttons
│           │  │
│           │  ├─ TestResults
│           │  └─ CustomInput
│           │
│           └─ Leaderboard
│              ├─ RankTable
│              ├─ MyRank
│              └─ Filters
```

---

## 🗄️ Database Relationships

```
┌──────────────┐
│    User      │
└──────┬───────┘
       │ 1
       │
       │ owns/creates
       │
       │ N
       ▼
┌──────────────┐       N ┌──────────────┐
│    Class     │◀────────│  Assignment  │
└──────┬───────┘  has    └──────────────┘
       │ N                       │ N
       │                         │
       │ contains                │ references
       │                         │
       │ N                       │ N
       ▼                         ▼
┌──────────────┐         ┌──────────────┐
│   Question   │◀────────│  Submission  │
└──────┬───────┘    N    └──────┬───────┘
       │                        │ N
       │ N                      │
       │                        │ updates
       │ references             │
       │                        │ 1
       │ N                      ▼
       └──────────────────▶┌──────────────┐
                           │ Leaderboard  │
                           └──────────────┘

Relationships:
• User (1) ──creates──▶ Class (N)
• User (N) ──enrolled in──▶ Class (N)  [Many-to-Many]
• Class (1) ──contains──▶ Question (N)
• Class (1) ──has──▶ Assignment (N)
• Question (1) ──receives──▶ Submission (N)
• Student (1) ──has──▶ Leaderboard Entry (N)
• Submission (N) ──updates──▶ Leaderboard (1)
```

---

## 🔐 Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Security Layers                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: Network Security                                       │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ • HTTPS/TLS Encryption                                  │    │
│  │ • CORS Policy (Restricted Origins)                      │    │
│  │ • Docker Network Isolation (NetworkMode: 'none')        │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Layer 2: Application Security                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ • JWT Authentication (Bearer Token)                     │    │
│  │ • Role-Based Access Control (RBAC)                      │    │
│  │ • Password Hashing (BCrypt - 10 rounds)                 │    │
│  │ • Input Validation (Schema validation)                  │    │
│  │ • Request Body Parsing Limits                           │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Layer 3: Code Execution Security                               │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ • Docker Container Isolation                            │    │
│  │ • Resource Limits (Memory, CPU)                         │    │
│  │ • No Network Access in Containers                       │    │
│  │ • Temporary File Cleanup                                │    │
│  │ • Time Limits on Execution                              │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Layer 4: Data Security                                         │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ • MongoDB User Authentication                           │    │
│  │ • Indexed Queries (Performance & Security)              │    │
│  │ • Sensitive Data Exclusion (.select())                  │    │
│  │ • Password Reset Tokens with Expiry                     │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Deployment Architecture (Recommended)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Load Balancer                            │
│                         (Nginx/HAProxy)                          │
│                         SSL Termination                          │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
    ┌─────────────────────┐   ┌─────────────────────┐
    │   Web Server 1      │   │   Web Server 2      │
    │   (Node.js + Express)│   │   (Node.js + Express)│
    │   Socket.IO         │   │   Socket.IO         │
    └──────────┬──────────┘   └──────────┬──────────┘
               │                         │
               └────────────┬────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
    ┌─────────────────┐         ┌─────────────────┐
    │  Redis Cluster  │         │ MongoDB Replica │
    │  (Socket.IO     │         │      Set        │
    │   Adapter)      │         │  (Primary +     │
    │                 │         │   Secondaries)  │
    └─────────────────┘         └─────────────────┘
              │
              │
              ▼
    ┌─────────────────┐
    │  Docker Swarm   │
    │  or Kubernetes  │
    │  (Container     │
    │   Orchestration)│
    └─────────────────┘
              │
              ▼
    ┌─────────────────┐
    │  Message Queue  │
    │  (Bull/RabbitMQ)│
    │  (Code Exec     │
    │   Jobs)         │
    └─────────────────┘
```

---

## 📊 Performance Optimization Points

```
┌─────────────────────────────────────────────────────────────────┐
│                    Performance Bottlenecks                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Code Execution                                              │
│     Current: Sequential Docker containers                        │
│     ┌────────────────────────────────────────────────┐         │
│     │  Optimization:                                  │         │
│     │  • Queue System (Bull/RabbitMQ)                │         │
│     │  • Worker Pools                                │         │
│     │  • Container Pre-warming                       │         │
│     │  • Kubernetes Jobs                             │         │
│     └────────────────────────────────────────────────┘         │
│                                                                  │
│  2. Database Queries                                            │
│     Current: Direct MongoDB queries                             │
│     ┌────────────────────────────────────────────────┐         │
│     │  Optimization:                                  │         │
│     │  • Redis Caching Layer                         │         │
│     │  • Query Result Caching                        │         │
│     │  • Aggregation Pipeline Optimization           │         │
│     │  • Index Optimization                          │         │
│     └────────────────────────────────────────────────┘         │
│                                                                  │
│  3. Real-time Updates                                           │
│     Current: Socket.IO on single server                         │
│     ┌────────────────────────────────────────────────┐         │
│     │  Optimization:                                  │         │
│     │  • Redis Adapter for Socket.IO                 │         │
│     │  • Horizontal Scaling                          │         │
│     │  • Event Debouncing                            │         │
│     │  • Selective Broadcasting                      │         │
│     └────────────────────────────────────────────────┘         │
│                                                                  │
│  4. File Operations                                             │
│     Current: Local filesystem                                   │
│     ┌────────────────────────────────────────────────┐         │
│     │  Optimization:                                  │         │
│     │  • S3/Cloud Storage                            │         │
│     │  • CDN for Static Assets                       │         │
│     │  • Async File Operations                       │         │
│     │  • Cleanup Scheduled Jobs                      │         │
│     └────────────────────────────────────────────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Real-time Communication Flow

```
┌──────────────┐                                    ┌──────────────┐
│  Teacher     │                                    │  Student 1   │
│  Browser     │                                    │  Browser     │
└──────┬───────┘                                    └──────┬───────┘
       │                                                   │
       │ 1. Block Student                                 │
       │                                                   │
       │ WS: emit('blockStudent')                         │
       │                                                   │
       ▼                                                   │
┌──────────────────────────────┐                          │
│     Socket.IO Server         │                          │
│     (Express Middleware)     │                          │
└──────────────────────────────┘                          │
       │                                                   │
       │ 2. Update DB                                     │
       ▼                                                   │
┌──────────────┐                                          │
│   MongoDB    │                                          │
└──────────────┘                                          │
       │                                                   │
       │ 3. Broadcast to Room                             │
       ▼                                                   │
┌──────────────────────────────┐                          │
│  Socket.IO                   │                          │
│  io.to('class:123').emit()   │                          │
└──────────────────────────────┘                          │
       │                                                   │
       │────────────────────────────────────────────────▶ │
       │                                                   │
       │      4. Receive Block Event                      │
       │                                                   ▼
       │                                          ┌─────────────────┐
       │                                          │ Update UI       │
       │                                          │ Show "Blocked"  │
       │                                          │ Disable Submit  │
       │                                          └─────────────────┘
       │
       │◀─────────────────────────────────────────┐
       │                                          │
       │      5. Acknowledgment                   │
┌──────────────┐                                  │
│  Teacher UI  │                                  │
│  Update      │                                  │
└──────────────┘                                  │
```

---

**End of Architecture Diagram**

Generated: November 5, 2025  
Project: AlgoSutra Coding Platform  
Version: 1.0.0






