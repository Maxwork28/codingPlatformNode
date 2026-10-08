'use strict';

/**
 * Plain-text handling for typed answers and fill-the-code templates.
 *
 * The question form historically saved `correctAnswer` and `codeSnippet` through the rich-text
 * editor, i.e. as HTML ("<p>New Delhi</p>", "<p>line 1</p><p>// FILL_IN_THE_BLANK</p>").
 * Grading compared that HTML against what students type, so correct answers were marked wrong
 * and fill-the-code programs were executed with <p> tags inside. Everything here tolerates both
 * the old HTML form and plain text, so existing questions grade correctly without a migration.
 */

const ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

const decodeEntities = (s) =>
    s
        .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

const looksLikeHtml = (s) => /<\/?(p|br|div|pre|code|strong|em|span|ul|ol|li|h[1-6])\b[^>]*>/i.test(s);

/**
 * HTML (or plain text) → plain text. Block boundaries become newlines; inline tags are dropped;
 * entities are decoded. Plain text without tags is returned unchanged (apart from CRLF → LF).
 */
const htmlToPlainText = (value) => {
    if (value === undefined || value === null) return value;
    let s = String(value).replace(/\r\n?/g, '\n');
    if (!looksLikeHtml(s)) return s;
    s = s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|pre|li|h[1-6])>\s*/gi, '\n')
        .replace(/<(p|div|pre|li|h[1-6])\b[^>]*>/gi, '')
        .replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    // drop the trailing newline produced by the last closing block tag
    return s.replace(/\n+$/, '');
};

/** Normalise a typed answer for comparison: plain text, collapsed whitespace, case-insensitive. */
const normalizeTypedAnswer = (value) =>
    String(htmlToPlainText(value ?? '') ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

/** True when the student's typed answer matches the stored correct answer. */
const typedAnswerMatches = (studentAnswer, correctAnswer) => {
    const expected = normalizeTypedAnswer(correctAnswer);
    if (!expected) return false;
    return normalizeTypedAnswer(studentAnswer) === expected;
};

// "// FILL_IN_THE_BLANK", "# FILL_IN_THE_BLANK", "// ___FILL_IN_THE_BLANK___", "-- FILL_IN_THE_BLANK"
const BLANK_RE = /(^[ \t]*)?(?:\/\/|#|--)\s*_{0,3}FILL_IN_THE_BLANK_{0,3}/m;
const BLANK_RE_GLOBAL = /(^[ \t]*)?(?:\/\/|#|--)\s*_{0,3}FILL_IN_THE_BLANK_{0,3}/gm;

const hasBlankMarker = (code) => BLANK_RE.test(String(code || ''));

const looksLikeFullProgram = (code) => {
    const s = String(code || '');
    if (s.length > 80) return true;
    if ((s.match(/\n/g) || []).length >= 2) return true;
    return /^\s*(import |from |const |let |var |def |function |class |#include|public class|package )/m.test(s);
};

/** Plain-text template for a fill-the-code question in the given language (or null). */
const fillTemplateFor = (question, language) => {
    const candidates = [
        question?.starterCode?.find((row) => row.language === language)?.code,
        question?.codeSnippet,
        question?.templateCode?.find((row) => row.language === language)?.code,
    ];
    for (const candidate of candidates) {
        const plain = htmlToPlainText(candidate);
        if (plain && hasBlankMarker(plain)) return plain;
    }
    return null;
};

/**
 * Build the program to execute for a fill-the-code answer.
 * - If the student submitted the whole program (exam editor starts from the full template), run it.
 * - Otherwise insert their line(s) at the blank, keeping the blank's indentation on every line
 *   (essential for Python).
 */
const buildFillTheCodeProgram = (question, answer, language) => {
    const submitted = String(answer ?? '').replace(/\r\n?/g, '\n');
    const template = fillTemplateFor(question, language);
    if (!template) return submitted;
    if (looksLikeFullProgram(submitted) && !hasBlankMarker(submitted)) return submitted;
    if (hasBlankMarker(submitted)) return submitted; // they edited the template but left the marker; run as-is
    return template.replace(BLANK_RE_GLOBAL, (_m, indent = '') => {
        const lines = submitted.replace(/\n+$/, '').split('\n');
        return lines.map((line) => `${indent}${line}`).join('\n');
    });
};

module.exports = {
    htmlToPlainText,
    normalizeTypedAnswer,
    typedAnswerMatches,
    hasBlankMarker,
    looksLikeFullProgram,
    fillTemplateFor,
    buildFillTheCodeProgram,
};
