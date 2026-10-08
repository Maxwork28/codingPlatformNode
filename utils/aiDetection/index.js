'use strict';

/**
 * AI-generated-code check for exam coding submissions.
 *
 * "Similarity to AI-generated reference solutions", computed locally: each exam coding answer is
 * compared (tokenized, identifier-normalized, starter code removed; winnowed fingerprints + greedy
 * string tiling) with reference solutions obtained from ChatGPT / Gemini / Claude for the same
 * question + language, or pasted by teachers. Student code never leaves the server.
 *
 * scheduleAiCheck is called fire-and-forget by examController.submitAnswer right after an exam coding
 * answer is saved. It returns immediately, never throws, and never slows the judge or the request.
 */

const checker = require('./checker');

module.exports = {
    scheduleAiCheck: checker.scheduleAiCheck,
    checker,
    get references() {
        return require('./references');
    },
    get providers() {
        return require('./providers');
    },
    get similarity() {
        return require('./similarity');
    },
};
