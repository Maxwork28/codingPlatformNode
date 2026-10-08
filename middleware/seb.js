'use strict';

const Exam = require('../models/Exam');
const { checkSebRequest, SEB_REQUIRED_BODY } = require('../utils/seb');

const SEB_FIELDS =
    'title proctoring.sebRequired proctoring.sebVerifyMode proctoring.sebExitPassword proctoring.sebConfigToken proctoring.sebConfigKeyOverride';

/**
 * Student exam routes: when the exam requires Safe Exam Browser, refuse requests that do not come from
 * SEB with 403 { code: 'SEB_REQUIRED' }. Basic mode checks the User-Agent; strict mode the Config Key
 * hash (see utils/seb.js). Runs after authMiddleware; unknown exams fall through to the controller's 404.
 */
const requireSeb = async (req, res, next) => {
    try {
        const exam = await Exam.findById(req.params.examId).select(SEB_FIELDS).lean();
        if (!exam?.proctoring?.sebRequired) return next();
        const result = checkSebRequest(req, exam);
        if (result.ok) return next();
        return res.status(403).json({ ...SEB_REQUIRED_BODY, mode: result.expectedMode });
    } catch (err) {
        return next(err);
    }
};

module.exports = { requireSeb, SEB_FIELDS };
