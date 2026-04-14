'use strict';

/**
 * Merge driver template with student answer for codingWithDriver questions.
 * - Uses replacement callbacks so '$' in student code does not corrupt the merge.
 * - If the driver already declares a function and the student pastes the same full
 *   function, inject only the inner body to avoid duplicate braces / SyntaxError.
 */

const PLACEHOLDER_MARKERS = [
    { token: '{{USER_CODE}}', len: '{{USER_CODE}}'.length },
    { token: '// USER_CODE_HERE', len: '// USER_CODE_HERE'.length },
    { token: '# USER_CODE_HERE', len: '# USER_CODE_HERE'.length }
];

function normalizeNewlines(s) {
    return String(s ?? '').replace(/\r\n/g, '\n');
}

function findPlaceholderIndex(driverTemplate) {
    const d = String(driverTemplate ?? '');
    for (const { token } of PLACEHOLDER_MARKERS) {
        const i = d.indexOf(token);
        if (i !== -1) return { index: i, token };
    }
    return null;
}

function findMatchingBrace(s, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < s.length; i++) {
        const c = s[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * If user code is a full `function name(...) { ... }` matching `fname`, return inner body only.
 */
function stripJsFunctionNamedBlock(userCode, fname) {
    if (!fname || !/^[A-Za-z_$][\w$]*$/.test(fname)) return null;
    const u = userCode.trim();
    const escaped = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\([^)]*\\)\\s*\\{`);
    const m = re.exec(u);
    if (!m) return null;
    const openBrace = u.indexOf('{', m.index);
    if (openBrace === -1) return null;
    const closeBrace = findMatchingBrace(u, openBrace);
    if (closeBrace === -1) return null;
    return u.slice(openBrace + 1, closeBrace).trim();
}

/**
 * If user code is `def name(...):\\n ...`, return body lines only (keep indentation — required for valid Python).
 */
function stripPythonDefBlock(userCode, fname) {
    if (!fname || !/^[A-Za-z_][\w]*$/.test(fname)) return null;
    const lines = normalizeNewlines(userCode).split('\n');
    if (lines.length === 0) return null;
    const first = lines[0].trim();
    const re = new RegExp(`^def\\s+${fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*:\\s*$`);
    if (!re.test(first)) return null;
    return lines.slice(1).join('\n').replace(/\s+$/, '');
}

/**
 * Driver text before the placeholder: find JS function that directly wraps the injection point.
 */
function jsWrappingFunctionNameBeforePlaceholder(before) {
    const b = before.replace(/\r\n/g, '\n');
    const tail = b.slice(Math.max(0, b.length - 4096));
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const t = line.trim();
        if (t === '' || t.startsWith('//')) continue;
        if (t.includes('{{USER_CODE}}') || t.includes('USER_CODE_HERE')) continue;
        const m = t.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/);
        if (m) return m[1];
        break;
    }
    const joined = tail.replace(/\s+/g, ' ');
    const m2 = joined.match(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/);
    return m2 ? m2[1] : null;
}

function pyWrappingDefNameBeforePlaceholder(before) {
    const b = before.replace(/\r\n/g, '\n');
    const tail = b.slice(Math.max(0, b.length - 4096));
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const t = line.trim();
        if (t === '' || t.startsWith('#')) continue;
        if (t.includes('{{USER_CODE}}') || t.includes('USER_CODE_HERE')) continue;
        const m = t.match(/^def\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*:\s*$/);
        if (m) return m[1];
        break;
    }
    return null;
}

/**
 * @param {string} driverTemplate
 * @param {string} userAnswer
 * @param {string} [language] - e.g. 'javascript', 'python'
 * @returns {string}
 */
function extractInjectableUserCode(driverTemplate, userAnswer, language) {
    const u = normalizeNewlines(userAnswer);
    const ph = findPlaceholderIndex(driverTemplate);
    if (!ph) return u;

    const before = String(driverTemplate ?? '').slice(0, ph.index);
    const lang = (language || '').toLowerCase();

    if (lang === 'python' || (!language && before.includes('def '))) {
        const pyName = pyWrappingDefNameBeforePlaceholder(before);
        if (pyName) {
            const stripped = stripPythonDefBlock(u, pyName);
            if (stripped !== null) return stripped;
        }
    }

    if (
        lang === 'javascript' ||
        lang === 'java' ||
        lang === 'go' ||
        !language ||
        ['c', 'cpp', 'php', 'ruby'].includes(lang)
    ) {
        const jsName = jsWrappingFunctionNameBeforePlaceholder(before);
        if (jsName) {
            const stripped = stripJsFunctionNamedBlock(u, jsName);
            if (stripped !== null) return stripped;
        }
    }

    return u;
}

/**
 * @param {string} driverTemplate
 * @param {string} userAnswer
 * @param {{ language?: string }} [options]
 * @returns {string}
 */
function mergeDriverWithUserAnswer(driverTemplate, userAnswer, options = {}) {
    const inject = extractInjectableUserCode(driverTemplate, userAnswer, options.language);
    const tpl = String(driverTemplate ?? '');
    return tpl
        .replace(/\{\{USER_CODE\}\}/g, () => inject)
        .replace(/\/\/ USER_CODE_HERE/g, () => inject)
        .replace(/# USER_CODE_HERE/g, () => inject);
}

module.exports = {
    mergeDriverWithUserAnswer,
    extractInjectableUserCode,
    findPlaceholderIndex
};
