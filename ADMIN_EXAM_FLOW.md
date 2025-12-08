# Complete Exam Flow - Admin Perspective

## Overview
This document describes the complete exam lifecycle from an admin's perspective, including creation, management, monitoring, and reporting.

---

## 1. Exam Creation Flow

### 1.1 Creating an Exam from Scratch

**Route:** `/admin/classes/:classId/exams/create`

**Steps:**
1. **Basic Information**
   - Enter exam title and description
   - Select class (pre-filled from URL)
   - Set exam duration (in minutes)

2. **Question Selection**
   - Browse available questions from question bank
   - Search by title or filter by type (MCQ, Coding, Fill-in-the-blanks, etc.)
   - Select questions and assign points to each
   - Option to create new questions on-the-fly (exam-only questions)
   - Preview questions before adding

3. **Section Configuration** (Optional)
   - Create multiple sections
   - Set section titles and descriptions
   - Configure section-specific timers
   - Set whether students can revisit sections
   - Assign questions to sections

4. **Proctoring Settings**
   - **Duration:** Total exam time in minutes
   - **Start/End Time:** Schedule exam window (optional)
   - **Auto-submit:** Automatically submit when time ends
   - **Tab Switch Limit:** Maximum allowed tab switches (default: 5)
   - **Copy/Paste Disabled:** Prevent copy-paste (default: true)
   - **Fullscreen Required:** Force fullscreen mode (default: true)
   - **Internet Required:** Monitor network connectivity (default: true)
   - **Allow Run Code:** Allow students to run/test code (default: true)

5. **Scoring Settings**
   - **Immediate Score Release:** Show scores immediately after submission (default: false)
   - **Grading Mode:** Auto, Manual, or Mixed
   - **Release Status:** Initially set to 'not_released'

6. **Save Exam**
   - Status: `draft` (can be edited)
   - Can be scheduled later by setting start/end times

### 1.2 Creating an Exam from Template

**Route:** `/admin/exams/templates/:templateId/use`

**Steps:**
1. Navigate to Exam Templates page
2. Select a template to use
3. Template data is pre-filled:
   - Questions
   - Sections
   - Proctoring settings
   - Scoring settings
4. Modify as needed (change class, questions, settings)
5. Save as new exam

### 1.3 Creating Exam Templates

**Route:** `/admin/exams/templates/create`

**Purpose:** Create reusable exam structures

**Steps:**
1. Follow same steps as creating an exam
2. Mark as template during creation
3. Template is saved with `isTemplate: true`
4. Can be reused to create multiple exams
5. Templates appear in Exam Templates page

---

## 2. Exam Management

### 2.1 Viewing Exams

**Route:** `/admin/classes/:classId/exams`

**Features:**
- List all exams for a class
- Filter by status: Draft, Scheduled, Active, Completed
- Search by title/description
- View exam details:
  - Title and description
  - Status badge
  - Number of questions
  - Duration
  - Start/End times
  - Student participation count

**Exam Statuses:**
- **Draft:** Created but not scheduled
- **Scheduled:** Has start/end times, not yet started
- **Active:** Currently available for students
- **Completed:** Past end time or manually completed
- **Archived:** Manually archived

### 2.2 Editing Exams

**Route:** `/admin/classes/:classId/exams/:examId/edit`

**Restrictions:**
- Only `draft` exams can be fully edited
- Scheduled/Active/Completed exams have limited editing
- Can modify:
  - Title, description
  - Questions (add/remove/reorder)
  - Sections
  - Proctoring settings
  - Scoring settings

**Note:** Once exam is scheduled or active, major changes are restricted to prevent disruption.

### 2.3 Deleting Exams

**Action:** Delete button in Exam Management page

**Restrictions:**
- Cannot delete if students have started attempts
- Confirmation dialog required
- Deletes exam and all associated data

---

## 3. Exam Scheduling

### 3.1 Setting Exam Schedule

**When Creating/Editing:**
- Set `startTime`: When exam becomes available
- Set `endTime`: When exam closes
- If both set: Exam status becomes `scheduled`
- If only duration set: Exam becomes `active` immediately when started

### 3.2 Status Transitions

```
Draft → Scheduled (when start/end times set)
Scheduled → Active (when current time >= startTime)
Active → Completed (when current time >= endTime OR duration expired)
```

---

## 4. Exam Monitoring (During Exam)

### 4.1 Real-time Monitoring

**Route:** `/admin/classes/:classId/exams/:examId/report`

**Available Information:**
- **Student Attempts:**
  - Who has started
  - Who is in progress
  - Who has submitted
  - Current question/section
  - Time remaining

- **Proctoring Violations:**
  - Tab switches (count and timestamps)
  - Fullscreen exits
  - Copy/paste attempts
  - Network disconnections
  - Heartbeat failures

- **Live Statistics:**
  - Total students enrolled
  - Students started
  - Students completed
  - Average time spent
  - Violation summary

### 4.2 Proctoring Features

**Monitored Events:**
1. **Tab Switch Detection**
   - Tracks when student switches tabs/windows
   - Counts violations
   - Logs timestamps

2. **Fullscreen Monitoring**
   - Detects fullscreen exit
   - Can require fullscreen mode

3. **Copy/Paste Prevention**
   - Blocks copy/paste operations
   - Logs attempts

4. **Network Monitoring**
   - Tracks internet connectivity
   - Logs disconnections

5. **Heartbeat System**
   - Regular ping from student browser
   - Detects if student is inactive
   - Can auto-submit on extended inactivity

---

## 5. Exam Results & Reporting

### 5.1 Viewing Exam Report

**Route:** `/admin/classes/:classId/exams/:examId/report`

**Report Includes:**

1. **Summary Statistics:**
   - Total students enrolled
   - Students who attempted
   - Students who completed
   - Average score
   - Highest score
   - Lowest score
   - Pass rate (if passing criteria set)

2. **Per-Student Breakdown:**
   - Student name and email
   - Attempt status (submitted, auto-submitted, in_progress)
   - Total score / Max score
   - Percentage
   - Time taken
   - Violation count
   - Per-question scores

3. **Per-Question Analysis:**
   - Question title
   - Points assigned
   - Average score
   - Correct/Incorrect ratio
   - Most common mistakes

4. **Violation Details:**
   - Type of violation
   - Timestamp
   - Frequency per student
   - Severity assessment

### 5.2 Exporting Results

**CSV Export Features:**
- Export all student results
- Include per-question breakdown
- Include violation counts
- Include timestamps
- Formatted for Excel/Google Sheets

**Export Columns:**
- Student Name, Email
- Status, Total Score, Max Score, Percentage
- Violations count
- Per-question: Score, Max Score, Status (Correct/Incorrect/Not Attempted)

### 5.3 Score Release

**Action:** "Release Scores" button in Exam Report

**Process:**
1. Admin reviews all submissions
2. Can manually adjust scores if needed (for manual/mixed grading)
3. Clicks "Release Scores"
4. Changes `scoring.releaseStatus` to `'released'`
5. Students can now view their results

**Note:** If `immediateScoreRelease` is enabled, scores are released automatically upon submission.

---

## 6. Exam Templates Management

### 6.1 Viewing Templates

**Route:** `/admin/exams/templates`

**Features:**
- List all exam templates
- View template details:
  - Title and description
  - Number of questions
  - Sections
  - Proctoring settings
- Actions:
  - Use Template (create exam from template)
  - Edit Template
  - Delete Template

### 6.2 Template Workflow

1. **Create Template:** Design reusable exam structure
2. **Use Template:** Create new exam from template
3. **Customize:** Modify exam as needed (different class, questions, etc.)
4. **Save:** New exam is independent of template

---

## 7. Database Models

### 7.1 Exam Model

```javascript
{
  title: String,
  description: String,
  classId: ObjectId (ref: Class),
  questions: [{
    questionId: ObjectId (ref: Question),
    points: Number,
    order: Number,
    sectionId: String,
    timeLimitSeconds: Number
  }],
  sections: [{
    sectionId: String,
    title: String,
    description: String,
    durationSeconds: Number,
    allowRevisit: Boolean,
    order: Number
  }],
  proctoring: {
    durationMinutes: Number,
    startTime: Date,
    endTime: Date,
    autoSubmitOnEnd: Boolean,
    tabSwitchLimit: Number,
    copyPasteDisabled: Boolean,
    fullscreenRequired: Boolean,
    internetRequired: Boolean,
    allowRunCode: Boolean
  },
  scoring: {
    immediateScoreRelease: Boolean,
    releaseStatus: 'not_released' | 'released',
    gradingMode: 'auto' | 'manual' | 'mixed'
  },
  template: {
    isTemplate: Boolean,
    templateName: String,
    templateDescription: String,
    baseTemplateId: ObjectId
  },
  createdBy: ObjectId (ref: User),
  status: 'draft' | 'scheduled' | 'active' | 'completed' | 'archived',
  createdAt: Date,
  updatedAt: Date
}
```

### 7.2 ExamAttempt Model

```javascript
{
  examId: ObjectId (ref: Exam),
  studentId: ObjectId (ref: User),
  classId: ObjectId (ref: Class),
  status: 'not_started' | 'in_progress' | 'submitted' | 'auto_submitted' | 'terminated' | 'expired',
  startedAt: Date,
  endsAt: Date,
  submittedAt: Date,
  currentSectionId: String,
  currentQuestionId: ObjectId,
  sectionTimers: [{
    sectionId: String,
    remainingSeconds: Number,
    completed: Boolean
  }],
  questionTimers: [{
    questionId: ObjectId,
    remainingSeconds: Number,
    completed: Boolean
  }],
  violations: [{
    type: 'tab_switch' | 'fullscreen_exit' | 'copy_paste' | 'network_loss' | 'heartbeat',
    timestamp: Date,
    details: Mixed
  }],
  violationCount: Number,
  tabSwitchCount: Number,
  fullscreenExitCount: Number,
  copyPasteCount: Number,
  networkDropCount: Number,
  answers: [{
    questionId: ObjectId,
    submissionId: ObjectId,
    answer: Mixed,
    score: Number,
    maxScore: Number,
    isCorrect: Boolean,
    language: String,
    passedTestCases: Number,
    totalTestCases: Number
  }],
  totalScore: Number,
  maxScore: Number,
  remark: String,
  feedback: String
}
```

---

## 8. API Endpoints (Admin)

### 8.1 Exam Creation & Management

- `POST /exams/` - Create exam
- `POST /exams/templates` - Create template
- `GET /exams/templates` - List templates
- `GET /exams/class/:classId` - List class exams
- `GET /exams/:examId` - Get exam details
- `PUT /exams/:examId` - Edit exam
- `DELETE /exams/:examId` - Delete exam

### 8.2 Reporting

- `GET /exams/:examId/report` - Get exam report
- `POST /exams/:examId/release` - Release scores
- `POST /exams/:examId/auto-submit` - Force auto-submit (admin/teacher only)

---

## 9. Student Experience (What Admin Sees)

### 9.1 Student Exam Taking Flow

1. **Student sees exam** in their class exam list
2. **Clicks "Start Exam"** - Creates ExamAttempt record
3. **Takes exam** with proctoring monitoring
4. **Submits answers** - Creates Submission records
5. **Submits exam** - Finalizes ExamAttempt
6. **Views results** (if scores released)

### 9.2 What Admin Monitors

- Real-time attempt status
- Proctoring violations
- Answer submissions
- Time remaining
- Network connectivity
- Fullscreen compliance

---

## 10. Best Practices

### 10.1 Exam Creation

1. **Test with Preview:** Always preview exam before scheduling
2. **Check Questions:** Verify all questions are correct and have proper test cases
3. **Set Appropriate Duration:** Consider question complexity and student level
4. **Configure Proctoring:** Balance security with user experience
5. **Use Templates:** Create templates for recurring exam patterns

### 10.2 Scheduling

1. **Set Clear Times:** Use specific start/end times for scheduled exams
2. **Buffer Time:** Add buffer time for technical issues
3. **Time Zones:** Consider student time zones
4. **Notifications:** Inform students well in advance

### 10.3 Monitoring

1. **Active Monitoring:** Monitor during exam for issues
2. **Violation Review:** Review violations contextually (not all are cheating)
3. **Technical Support:** Be available during exam for technical issues
4. **Backup Plans:** Have contingency for technical failures

### 10.4 Reporting

1. **Review Before Release:** Always review results before releasing scores
2. **Manual Grading:** Review coding questions that need manual grading
3. **Export Data:** Export results for record-keeping
4. **Feedback:** Provide feedback to students when releasing scores

---

## 11. Common Workflows

### 11.1 Creating a Weekly Quiz

1. Create exam template with standard quiz structure
2. Each week: Use template → Select questions → Schedule
3. Monitor during quiz
4. Review and release scores
5. Archive completed quiz

### 11.2 Final Exam Setup

1. Create comprehensive exam with multiple sections
2. Set strict proctoring (fullscreen, no copy-paste, low tab switch limit)
3. Schedule well in advance
4. Test exam environment before launch
5. Monitor closely during exam
6. Review all submissions
7. Release scores after review period

### 11.3 Practice Exam

1. Create exam with lenient proctoring
2. Allow immediate score release
3. Enable code running
4. Allow revisiting sections
5. No strict time limits

---

## 12. Troubleshooting

### 12.1 Common Issues

**Student Can't Start Exam:**
- Check exam status (must be active)
- Verify student is enrolled in class
- Check start/end times
- Verify exam hasn't expired

**Scores Not Showing:**
- Check `releaseStatus` (must be 'released')
- Verify `immediateScoreRelease` setting
- Check if exam is completed

**Violations Not Recording:**
- Check browser compatibility
- Verify proctoring settings enabled
- Check network connectivity
- Review browser console for errors

**Auto-submit Not Working:**
- Verify `autoSubmitOnEnd` is enabled
- Check timer calculations
- Verify exam status
- Check for JavaScript errors

---

## 13. Security Considerations

1. **Proctoring:** Monitors but doesn't prevent cheating completely
2. **Server-side Validation:** All answers validated on server
3. **Time Limits:** Enforced server-side
4. **Submission Lock:** Once submitted, cannot modify
5. **Access Control:** Role-based access (admin/teacher/student)
6. **Data Privacy:** Student data protected, only accessible to authorized roles

---

## Summary

The exam flow for admin involves:
1. **Creation:** Build exams from scratch or templates
2. **Configuration:** Set questions, sections, proctoring, and scoring
3. **Scheduling:** Set availability windows
4. **Monitoring:** Watch real-time progress and violations
5. **Reporting:** Analyze results and export data
6. **Release:** Make scores available to students

The system supports flexible exam structures with comprehensive proctoring and detailed analytics for effective exam management.

