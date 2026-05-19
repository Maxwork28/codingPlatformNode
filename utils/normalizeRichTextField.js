/**
 * Ensures multi-line constraint (and similar) text is stored as HTML paragraphs
 * so UIs render each line on its own row.
 */
function normalizeMultilineRichText(value) {
    if (value == null || typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return trimmed;
    }

    // One <p> block with embedded newlines → split into multiple <p> tags
    const singleParagraph = trimmed.match(/^<p>([\s\S]*)<\/p>$/i);
    if (singleParagraph && /\r?\n/.test(singleParagraph[1])) {
        return singleParagraph[1]
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => `<p>${line}</p>`)
            .join('');
    }

    // Already has block-level HTML
    if (/<(p|ul|ol|li|br|div|pre)\b/i.test(trimmed)) {
        return trimmed;
    }

    // Plain text with newlines → one paragraph per line
    if (/\r?\n/.test(trimmed)) {
        return trimmed
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => `<p>${line}</p>`)
            .join('');
    }

    return trimmed;
}

function normalizeQuestionRichTextFields(questionData) {
    if (!questionData || typeof questionData !== 'object') {
        return questionData;
    }
    if (questionData.constraints) {
        questionData.constraints = normalizeMultilineRichText(questionData.constraints);
    }
    return questionData;
}

module.exports = {
    normalizeMultilineRichText,
    normalizeQuestionRichTextFields,
};
