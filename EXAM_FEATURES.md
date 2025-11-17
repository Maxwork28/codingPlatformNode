# Exam & Proctoring Feature Guide

This document explains how to configure, run, and test the secure exam workflow that powers features 1–11 (submit by choice, auto-submit, proctoring, reporting, marks release, templates, etc.).

---

## 1. Data Model Overview

### `Exam`
Represents a scheduled test for a class.
- `title`, `description`
- `classId`
- `questions`: array of `{ questionId, points, order }`
- `proctoring`
  - `durationMinutes`
  - `startTime`, `endTime`
  - `autoSubmitOnEnd`
  - `tabSwitchLimit`
  - `copyPasteDisabled`
  - `fullscreenRequired`
  - `internetRequired`
- `scoring`
  - `immediateScoreRelease`
  - `releaseStatus` (`not_released` or `released`)
- `template`
  - `isTemplate`, optional metadata for test bank reuse

### `ExamAttempt`
One active attempt per student.
- `status`: `not_started`, `in_progress`, `submitted`, `auto_submitted`, `terminated`, `expired`
- Timestamps: `startedAt`, `endsAt`, `submittedAt`
- Counters: `tabSwitchCount`, `fullscreenExitCount`, `copyPasteCount`, `networkDropCount`
- `violations`: log of proctoring events (`tab_switch`, `fullscreen_exit`, `copy_paste`, `network_loss`)
- `answers`: `{ questionId, submissionId, score, maxScore, isCorrect }`
- `totalScore`, `maxScore`

### `Submission`
Existing submission model extended with:
- `examId`
- `examAttemptId`
- `passedTestCases`, `totalTestCases`

---

## 2. Backend Endpoints

Mounted under `/exams` (all routes require JWT auth):

| Method | Route | Roles | Description |
|--------|-------|-------|-------------|
| POST | `/exams/templates` | admin/teacher | Create reusable template |
| GET | `/exams/templates` | admin/teacher | List templates |
| POST | `/exams` | admin/teacher | Schedule an exam (optionally from template) |
| GET | `/exams/class/:classId` | student/teacher/admin | Student-visible exam list |
| GET | `/exams/:examId` | admin/teacher | Detailed exam info |
| POST | `/exams/:examId/start` | student | Start attempt (enters fullscreen) |
| GET | `/exams/:examId/attempt` | student | Fetch current attempt (sync timer) |
| POST | `/exams/:examId/events` | student | Log proctoring event (tab switch, copy, fullscreen exit, heartbeat, etc.) |
| POST | `/exams/:examId/submit` | student | Manual submit |
| POST | `/exams/:examId/auto-submit` | student/admin/teacher | Auto-submit (timer expiry) |
| GET | `/exams/:examId/report` | admin/teacher | Full report of attempts |
| POST | `/exams/:examId/release` | admin/teacher | Release marks to students |
| POST | `/questions/exam-only` | admin/teacher | Create an exam-only question (hidden from bank) |

Key controller behaviours:
- Auto-evaluates submissions when attempts finalize.
- Terminates attempt when tab-switch count exceeds limit.
- Heartbeat events update connectivity status without counting as violations.
- Auto-submit endpoint can be triggered by scheduler or frontend timer.

---

## 3. Frontend Workflow

### Student Experience
1. **Exam List** (`/student/exams`)
   - Shows upcoming/active exams per class.
   - “Start Exam” opens `/student/exams/:examId`.
2. **Exam Screen**
   - Requests fullscreen if required.
   - Countdown timer; auto-submits at zero.
   - Logs tab switches, copy/paste attempts, fullscreen exits, network drops.
   - Offline banner if network lost; events synced once back online.
   - Questions listed with status; opens existing question submission screen while preserving exam context.
   - Manual submit button (feature #1).
   - If scores are auto-released or released by staff, summary appears immediately.

### Teacher/Admin Experience
1. **Exam Management** (`/teacher/exams`)
   - Create templates (feature #11 test bank reuse).
   - Schedule exams (custom or from template) with proctoring options.
   - Create exam-only questions on the fly (stored outside the global bank and auto-assigned to the exam/template).
   - View exams per class, release scores, download reports.
   - Reports list per-student score, max score, violations.

### Question Submission Integration
- `QuestionSubmission` now accepts `examId` + `examAttemptId` via navigation state/query.
- All run/submit actions pass exam metadata so backend ties submissions to the active attempt.

---

## 4. Feature Mapping

| Feature | Implementation Notes |
|-------------|----------------------|
| Sectional Timer | Exams now define `sections` with dedicated `durationSeconds`. Attempts track `sectionTimers`; UI shows section countdown and moves to next section when time elapses. |
| Question Timer | Each exam question can specify `timeLimitSeconds`. Attempts track per-question timers; students can only revisit questions while their timer is above zero. |
| Total Timer | Total duration still enforced via `attempt.endsAt` (auto submits when reached) and displayed alongside section/question timers. |
| Revisit with Time Left | Navigation buttons disable/lock questions whose timer reached zero; backend enforces via `questionTimers` state. |
| Submit by choice | Manual “Submit Exam” button, backend `submitExam`. |
| 2. Auto submit when time ends | Timer triggers `/exams/:id/auto-submit`; backend enforces auto submit as well. |
| 3. Close after 5 tab switches | Frontend logs `tab_switch`, backend counts and terminates when limit reached. |
| 4. Disable copy/paste | Frontend prevents copy/cut/paste events, logs violations if attempted. |
| 5. Prompt for alerts | `ExamPrompt` modal component for warnings/info. |
| 6. Start in fullscreen | Exam screen requests fullscreen; exits logged as violations. |
| 7. Cheating safeguards | Combines tab monitoring, copy/paste disable, fullscreen enforcement, offline logging. |
| 8. Internet monitoring | Online/offline events update banner and send `network_loss`/`heartbeat` events. |
| 9. Report & marks | `/exams/:id/report` for staff, exam screen summary for students once released. |
|10. Marks release control | `immediateScoreRelease` flag + `releaseScores` endpoint. |
|11. Test templates/bank | Template CRUD, reuse when scheduling new exams. |

---

## 5. Testing Checklist

### Backend
1. **Create Template**
   ```bash
   POST /exams/templates
   {
     "title": "DSA Template",
     "classId": "<classId>",
     "questions": [
       { "questionId": "<questionId1>", "points": 5, "sectionId": "section-a", "timeLimitMinutes": 5 },
       { "questionId": "<questionId2>", "points": 5, "sectionId": "section-b", "timeLimitMinutes": 7 }
     ],
     "sections": [
       { "sectionId": "section-a", "title": "MCQ", "durationMinutes": 15 },
       { "sectionId": "section-b", "title": "Coding", "durationMinutes": 30 }
     ],
     "proctoring": { "durationMinutes": 45, "tabSwitchLimit": 3 }
   }
   ```
2. **Schedule Exam**
   ```bash
   POST /exams
   {
     "templateId": "<templateId>",
     "classId": "<classId>",
     "proctoring": { "startTime": "2025-11-15T09:00:00Z" }
   }
   ```
3. **Start Attempt**
   ```bash
   POST /exams/<examId>/start
   ```
   Response includes `sections`, `sectionTimers`, and `questionTimers`.
4. **Update Timers**
   ```bash
   PATCH /exams/<examId>/section-timer { "attemptId": "...", "sectionId": "section-a", "remainingSeconds": 120 }
   PATCH /exams/<examId>/question-timer { "attemptId": "...", "questionId": "...", "remainingSeconds": 45 }
   ```
5. **Manual Submit**
   ```bash
   POST /exams/<examId>/submit { "attemptId": "..." }
   ```
6. **Auto Submit**
   ```bash
   POST /exams/<examId>/auto-submit { "attemptId": "..." }
   ```
7. **Release Scores**
   ```bash
   POST /exams/<examId>/release
   ```
8. **Report**
   ```bash
   GET /exams/<examId>/report
   ```

### Frontend (Manual)
1. Create a template/exam via teacher portal with multiple sections and per-question time limits.
2. Log in as student → open `/student/exams`.
   - Verify each exam shows status.
   - Start exam → confirm fullscreen, prompts, and three timers (total/section/question).
3. Navigate between sections/questions:
   - Section timer decreases only for the active section.
   - Question timer pauses on unlimited questions (∞) and locks when reaching 00:00 (buttons disable, banner appears).
4. Switch tabs repeatedly → after hitting the configured limit the exam terminates.
5. Let a question timer expire → question becomes locked but overall exam continues if other questions still have time.
6. Allow a section timer to expire → exam advances to the next section automatically.
7. Disconnect and reconnect network → offline banner and sync upon return.
8. Submit manually (feature #1) and verify score release behaviour (#10). If marks are not released immediately, use teacher exam management to release and confirm student summary updates.
9. After submission review `TeacherExamManagement` reports to see section/question timings recorded for each attempt.

---

## 6. Troubleshooting Tips
- **“Attempt already closed”**: Student already submitted/terminated; create a re-take by deleting attempt or re-opening exam.
- **No submissions recorded inside report**: Ensure question submissions pass `examId` & `examAttemptId` (check network calls from exam screen/question submission page).
- **Fullscreen request blocked**: Browser may block without user interaction; exam screen prompts again if fullscreen exits.
- **Auto-submit not triggered**: Timer runs on frontend; backend also checks when receiving manual submissions or events—ensure exam duration is configured.

---

With these endpoints, UI changes, and proctoring rules the platform now supports full secure examinations with configurable behavior, monitoring, and reporting.
