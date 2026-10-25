const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const JudgeJob = require('../models/JudgeJob');
const { publicView, queuePosition } = require('../services/judgeJobs');
const { isAdmin } = require('../utils/access');

/**
 * @route   GET /judge/jobs/:jobId
 * @desc    Status of a Run / Submit / exam judge job: queued (with position), running, done (result) or failed (error).
 *          Fallback for clients that missed the 'judge:done' socket event.
 * @access  The job's owner (admins too)
 */
router.get('/jobs/:jobId', authMiddleware, async (req, res) => {
    try {
        const { jobId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(jobId)) return res.status(400).json({ error: 'Invalid job id' });
        const job = await JudgeJob.findById(jobId).select('-spec -context -events').lean();
        if (!job || (String(job.ownerId) !== String(req.user._id) && !isAdmin(req.user))) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.json(publicView(job, job.status === 'queued' ? { position: await queuePosition(job) } : {}));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch job' });
    }
});

module.exports = router;
