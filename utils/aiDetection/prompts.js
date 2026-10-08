'use strict';

/**
 * Prompts used to obtain AI reference solutions, built ONLY from the question (title, statement,
 * formats, constraints, public samples, and the student-visible stub). Student code is never used.
 *
 * Variants imitate what students actually type into ChatGPT / Gemini / Claude.
 */

const { htmlToPlainText } = require('../answerText');

const LANGUAGE_NAMES = {
    javascript: 'JavaScript (Node.js)',
    c: 'C',
    cpp: 'C++',
    java: 'Java',
    python: 'Python 3',
    php: 'PHP',
    ruby: 'Ruby',
    go: 'Go',
};
const FENCE_LANG = { javascript: 'javascript', c: 'c', cpp: 'cpp', java: 'java', python: 'python', php: 'php', ruby: 'ruby', go: 'go' };

const MAX_FIELD = 6000;

/** HTML / rich text → compact plain text. */
const plain = (value) => {
    if (value === undefined || value === null) return '';
    let s = String(htmlToPlainText(String(value)) ?? '');
    s = s
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
};

/** Code fields: only undo rich-text HTML (the form used to save some as <p>…</p>); never strip `<int>`. */
const plainCode = (value) => (value ? String(htmlToPlainText(String(value)) ?? '').replace(/\s+$/, '') : '');

const codeFor = (rows, language) => (rows || []).find((r) => r?.language === language && r.code && String(r.code).trim())?.code || '';

/** The code a student sees in the exam editor for this question + language (or ''). */
const studentStub = (question, language) => {
    if (question.type === 'fillInTheBlanksCoding') {
        return plainCode(codeFor(question.starterCode, language) || question.codeSnippet || codeFor(question.templateCode, language));
    }
    if (question.type === 'codingWithDriver') {
        return plainCode(codeFor(question.templateCode, language) || codeFor(question.starterCode, language));
    }
    return plainCode(codeFor(question.starterCode, language));
};

/** Every student-visible code fragment for this question + language (boilerplate for similarity). */
const boilerplateSources = (question, language) =>
    [
        codeFor(question.starterCode, language),
        codeFor(question.templateCode, language),
        codeFor(question.driverCode, language),
        question.type === 'fillInTheBlanksCoding' ? question.codeSnippet : '',
        question.functionSignature,
    ]
        .map((s) => plainCode(s))
        .filter(Boolean);

/** The problem statement as a student would paste it. */
const problemText = (question) => {
    const parts = [];
    if (question.title) parts.push(plain(question.title));
    const desc = plain(question.description);
    if (desc) parts.push(desc);
    const inputFormat = plain(question.inputFormat);
    if (inputFormat) parts.push(`Input format:\n${inputFormat}`);
    const outputFormat = plain(question.outputFormat);
    if (outputFormat) parts.push(`Output format:\n${outputFormat}`);
    const constraints = plain(question.constraints);
    if (constraints) parts.push(`Constraints:\n${constraints}`);
    const samples = (question.sampleIo || []).filter((s) => s && (s.input || s.output)).slice(0, 3);
    const publicTests = samples.length ? [] : (question.testCases || []).filter((t) => t?.isPublic).slice(0, 2);
    [...samples, ...publicTests.map((t) => ({ input: t.input, output: t.expectedOutput }))].forEach((s, i) => {
        let block = `Example ${i + 1}:\nInput:\n${String(s.input ?? '').trim()}\nOutput:\n${String(s.output ?? '').trim()}`;
        if (s.explanation) block += `\nExplanation: ${plain(s.explanation)}`;
        parts.push(block);
    });
    if (!samples.length && !publicTests.length) {
        (question.examples || []).slice(0, 3).forEach((ex, i) => {
            const t = plain(ex);
            if (t) parts.push(`Example ${i + 1}:\n${t}`);
        });
    }
    return parts.join('\n\n');
};

const CODE_ONLY = 'Reply with only the complete code in a single code block, no explanation.';

/**
 * Prompt variants for one question + language. Each: { variant, system, prompt, temperature }.
 * temperature is a hint; providers that reject it retry without.
 */
const buildPrompts = (question, language, count = 3) => {
    const lang = LANGUAGE_NAMES[language] || language;
    const fence = FENCE_LANG[language] || '';
    const problem = problemText(question);
    const stub = studentStub(question, language);
    let shape = '';
    if (question.type === 'codingWithDriver' && stub) {
        shape = `Complete this ${lang} code. Input reading and output printing are already handled for you, so only implement the function:\n\`\`\`${fence}\n${stub}\n\`\`\``;
    } else if (question.type === 'fillInTheBlanksCoding' && stub) {
        shape = `Fill in the part marked FILL_IN_THE_BLANK in this ${lang} program and give the complete program:\n\`\`\`${fence}\n${stub}\n\`\`\``;
    } else if (stub) {
        shape = `Start from this code:\n\`\`\`${fence}\n${stub}\n\`\`\``;
    }
    const io = question.type === 'codingWithDriver' ? '' : ' It must read from standard input and print to standard output.';
    const system = 'You are a helpful programming assistant.';

    const variants = [
        {
            variant: 1,
            temperature: undefined,
            prompt: `Solve this problem in ${lang}.${io}\n\n${problem}${shape ? `\n\n${shape}` : ''}\n\n${CODE_ONLY}`,
        },
        {
            variant: 2,
            temperature: 0.7,
            prompt: `give me the ${lang.toLowerCase()} code for this question\n\n${problem}${shape ? `\n\n${shape}` : ''}\n\nonly code please`,
        },
        {
            variant: 3,
            temperature: 1,
            prompt: `${problem}${shape ? `\n\n${shape}` : ''}\n\nWrite an efficient ${lang} solution for the problem above.${io} ${CODE_ONLY}`,
        },
        {
            variant: 4,
            temperature: 0.9,
            prompt: `I have a coding exam question. Write the ${lang} program for it so that it passes all test cases.${io}\n\n${problem}${shape ? `\n\n${shape}` : ''}\n\n${CODE_ONLY}`,
        },
        {
            variant: 5,
            temperature: 1,
            prompt: `${lang} solution:\n\n${problem}${shape ? `\n\n${shape}` : ''}\n\nJust the code.`,
        },
        {
            variant: 6,
            temperature: 0.5,
            prompt: `Can you write simple, beginner-friendly ${lang} code for this?${io}\n\n${problem}${shape ? `\n\n${shape}` : ''}\n\n${CODE_ONLY}`,
        },
    ];
    return variants.slice(0, Math.max(1, Math.min(variants.length, count))).map((v) => ({ ...v, system }));
};

/**
 * Pull code out of a chat reply: the longest fenced block (``` or ~~~), else an unterminated fence's
 * body, else the whole reply trimmed.
 */
const extractCode = (reply) => {
    const text = String(reply ?? '').replace(/\r\n?/g, '\n');
    const blocks = [];
    const re = /(^|\n)[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
    let m;
    while ((m = re.exec(text))) blocks.push(m[3]);
    if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0].replace(/\s+$/, '');
    const open = /(^|\n)[ \t]*(```|~~~)[^\n]*\n([\s\S]*)$/.exec(text);
    if (open) return open[3].replace(/\n[ \t]*(```|~~~)\s*$/, '').replace(/\s+$/, '');
    return text.trim();
};

module.exports = { buildPrompts, extractCode, problemText, studentStub, boilerplateSources, plain, plainCode, LANGUAGE_NAMES };
