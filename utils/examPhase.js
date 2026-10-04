/**
 * Phase of an exam at `now`: template | draft | archived | scheduled | live | completed.
 * An exam with no start time opens as soon as it is published; one with no end time
 * stays open until it is closed by hand (stored status 'completed').
 */
const examPhase = (exam, now = new Date()) => {
    if (exam.template?.isTemplate) return 'template';
    if (exam.status === 'archived') return 'archived';
    if (exam.status === 'draft') return 'draft';
    const start = exam.proctoring?.startTime ? new Date(exam.proctoring.startTime) : null;
    const end = exam.proctoring?.endTime ? new Date(exam.proctoring.endTime) : null;
    if (exam.status === 'completed') return 'completed';
    if (end && now > end) return 'completed';
    if (start && now < start) return 'scheduled';
    return 'live';
};

module.exports = { examPhase };
