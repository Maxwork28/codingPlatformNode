#!/usr/bin/env node
'use strict';

/**
 * Provider clients + reference generation against a local MOCK HTTP server (no real API keys):
 *   node scripts/test-ai-providers.js
 *
 * Part 1 (no DB): OpenAI / Gemini / Anthropic request shapes, reply parsing, retries with backoff on
 * 429/5xx, dropping a rejected optional parameter, timeouts, non-retryable errors, concurrency cap,
 * and prompt content (no hidden tests / solutions).
 * Part 2 (local MongoDB 127.0.0.1:27017, throw-away aitest_<ts> DB, dropped at the end): automatic
 * generation for a burst of answers starts exactly one generation, references are stored, waiting
 * submissions are re-checked, and student code never reaches a provider.
 */

const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MONGO_HOST = process.env.SMOKE_MONGO || 'mongodb://127.0.0.1:27017';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(MONGO_HOST)) {
    console.error('SMOKE_MONGO must point at a local MongoDB');
    process.exit(2);
}

let failed = 0;
let passed = 0;
const check = (name, ok, extra = '') => {
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------
const REFERENCE = `import sys

def solve(values):
    best = values[0]
    current = 0
    for x in values:
        current = max(x, current + x)
        best = max(best, current)
    return best

data = sys.stdin.read().split()
n = int(data[0])
print(solve([int(v) for v in data[1:n + 1]]))
`;

const requests = [];
let scenario = {}; // path-prefix -> array of queued responses
let active = 0;
let maxActive = 0;
let delayMs = 0;

const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};

const okBody = (provider, code) => {
    const text = `Here you go:\n\n\`\`\`python\n${code}\`\`\`\n`;
    if (provider === 'openai') return { id: 'resp_1', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
    if (provider === 'gemini') return { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason: 'STOP' }] };
    return { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' };
};

const providerOf = (url) => (url.startsWith('/openai') ? 'openai' : url.startsWith('/gemini') ? 'gemini' : 'anthropic');

const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        let body = null;
        try {
            body = JSON.parse(raw);
        } catch {
            /* ignore */
        }
        requests.push({ url: req.url, headers: req.headers, body, raw });
        const provider = providerOf(req.url);
        const queued = scenario[provider];
        const step = queued && queued.length ? queued.shift() : { status: 200 };
        const wait = step.delay ?? delayMs;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        active -= 1;
        if (res.destroyed) return;
        if (typeof step.check === 'function' && !step.check(body)) return reply(res, 400, { error: { message: 'mock: unexpected body' } });
        if (step.status === 200) return reply(res, 200, okBody(provider, step.code || REFERENCE));
        return reply(res, step.status, step.body || { error: { message: step.message || `mock ${step.status}` } }, step.headers);
    });
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // Env for config/env.js (read lazily by the AI modules).
    process.env.NODE_ENV = 'test';
    process.env.MONGO_URI = `${MONGO_HOST.replace(/\/$/, '')}/aitest_${Date.now()}`;
    process.env.JWT_SECRET = 'ai-provider-test-secret-ai-provider-test-secret';
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.OPENAI_MODEL = 'gpt-test';
    process.env.OPENAI_BASE_URL = `${base}/openai/v1`;
    process.env.GEMINI_API_KEY = 'gm-test-key';
    process.env.GEMINI_MODEL = 'gemini-test';
    process.env.GEMINI_BASE_URL = `${base}/gemini/v1beta`;
    process.env.ANTHROPIC_API_KEY = 'ant-test-key';
    process.env.ANTHROPIC_MODEL = 'claude-test';
    process.env.ANTHROPIC_BASE_URL = `${base}/anthropic`;
    process.env.AI_REF_VARIANTS = '3';
    process.env.AI_MAX_RETRIES = '3';

    const config = require(path.join(ROOT, 'config', 'env'));
    const { callProvider, enabledProviders, providerStatus } = require(path.join(ROOT, 'utils', 'aiDetection', 'providers'));
    const { buildPrompts, extractCode } = require(path.join(ROOT, 'utils', 'aiDetection', 'prompts'));
    const fast = { ...config.ai, retryBaseMs: 20 };

    try {
        // ---- config / status
        const status = providerStatus();
        check('providerStatus lists 3 enabled providers and never exposes keys', enabledProviders().length === 3 && !JSON.stringify(status).includes('test-key') && !JSON.stringify(status).includes('sk-test'), JSON.stringify(status));

        const prompt = { system: 'You are a helpful programming assistant.', prompt: 'Solve: print the max subarray sum', temperature: 0.7 };

        // ---- OpenAI happy path + request shape
        requests.length = 0;
        const t1 = await callProvider('openai', prompt, fast);
        const r1 = requests[0];
        check('openai: POST /v1/responses with Bearer key, model, instructions, input', r1?.url === '/openai/v1/responses' && r1.headers.authorization === 'Bearer sk-test-openai' && r1.body.model === 'gpt-test' && r1.body.instructions && r1.body.input === prompt.prompt, JSON.stringify(r1?.body).slice(0, 160));
        check('openai: reply parsed from output[].content[].output_text, fences stripped', extractCode(t1) === REFERENCE.trimEnd());

        // ---- OpenAI rejects temperature → retried without it, and remembered
        requests.length = 0;
        scenario = { openai: [{ status: 400, message: "Unsupported parameter: 'temperature' is not supported with this model." }, { status: 200, check: (b) => !('temperature' in b) }] };
        const t2 = await callProvider('openai', prompt, fast);
        check('openai: 400 on temperature → retried without temperature', Boolean(t2) && requests.length === 2 && 'temperature' in requests[0].body && !('temperature' in requests[1].body), `${requests.length} requests`);
        requests.length = 0;
        await callProvider('openai', prompt, fast);
        check('openai: rejected parameter is not sent again for that model', requests.length === 1 && !('temperature' in requests[0].body));

        // ---- Gemini: 429 then 503 then OK (backoff), key in header not URL, thought parts skipped
        requests.length = 0;
        scenario = { gemini: [{ status: 429, headers: { 'Retry-After': '0' } }, { status: 503 }, { status: 200 }] };
        const t3 = await callProvider('gemini', prompt, fast);
        const g = requests[requests.length - 1];
        check('gemini: retries 429 + 503 then succeeds', requests.length === 3 && extractCode(t3) === REFERENCE.trimEnd(), `${requests.length} requests`);
        check('gemini: POST models/{model}:generateContent with x-goog-api-key header (no key in URL)', g.url === '/gemini/v1beta/models/gemini-test:generateContent' && g.headers['x-goog-api-key'] === 'gm-test-key' && !g.url.includes('key='), g.url);
        check('gemini: body has systemInstruction, contents, generationConfig.temperature', g.body.systemInstruction?.parts?.[0]?.text && g.body.contents?.[0]?.parts?.[0]?.text === prompt.prompt && g.body.generationConfig?.temperature === 0.7);
        check('gemini: thought parts are not part of the reply', !t3.includes('thinking…'));

        // ---- Anthropic: 529 overloaded twice then OK; headers
        requests.length = 0;
        scenario = { anthropic: [{ status: 529 }, { status: 529 }, { status: 200 }] };
        const t4 = await callProvider('anthropic', prompt, fast);
        const a = requests[requests.length - 1];
        check('anthropic: retries 529 twice then succeeds', requests.length === 3 && Boolean(extractCode(t4)), `${requests.length} requests`);
        check('anthropic: POST /v1/messages with x-api-key + anthropic-version, system + messages', a.url === '/anthropic/v1/messages' && a.headers['x-api-key'] === 'ant-test-key' && a.headers['anthropic-version'] === '2023-06-01' && a.body.system && a.body.messages?.[0]?.content === prompt.prompt && a.body.max_tokens > 0);

        // ---- Retries exhausted / non-retryable / timeout
        requests.length = 0;
        scenario = { anthropic: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }] };
        const e1 = await callProvider('anthropic', prompt, fast).catch((e) => e);
        check('5xx: gives up after maxRetries (1 + 3 attempts) with a clear error', e1 instanceof Error && requests.length === 4 && /HTTP 500/.test(e1.message), `${requests.length} requests: ${e1?.message}`);
        requests.length = 0;
        scenario = { openai: [{ status: 401, message: 'Incorrect API key provided' }] };
        const e2 = await callProvider('openai', prompt, fast).catch((e) => e);
        check('401: not retried, error says HTTP 401 and never echoes the key', requests.length === 1 && /HTTP 401/.test(e2?.message) && !e2.message.includes('sk-test'), e2?.message);
        requests.length = 0;
        scenario = { gemini: [{ status: 200, delay: 1500 }, { status: 200, delay: 1500 }] };
        const e3 = await callProvider('gemini', prompt, { ...fast, requestTimeoutMs: 200, maxRetries: 1 }).catch((e) => e);
        check('timeout: request aborted and retried, then a "timed out" error', /timed out/.test(e3?.message) && requests.length === 2, `${requests.length} requests: ${e3?.message}`);
        scenario = {};
        await new Promise((r) => setTimeout(r, 1600)); // let the mock finish the slow responses

        // ---- Concurrency cap
        maxActive = 0;
        delayMs = 120;
        await Promise.all(Array.from({ length: 6 }, () => callProvider('openai', prompt, { ...fast, providerConcurrency: 2 })));
        delayMs = 0;
        check('concurrency: at most AI_PROVIDER_CONCURRENCY calls in flight', maxActive <= 2 && maxActive >= 1, `max in flight ${maxActive}`);

        // ---- Prompts: student-visible material only
        const question = {
            title: 'Max subarray',
            description: '<p>Return the <strong>maximum</strong> subarray sum.</p>',
            type: 'codingWithDriver',
            inputFormat: '<p>n, then n integers</p>',
            outputFormat: 'One integer',
            constraints: '1 ≤ n ≤ 10^5',
            sampleIo: [{ input: '5\n1 -2 3 4 -1', output: '7' }],
            testCases: [{ input: 'HIDDEN_CASE_INPUT', expectedOutput: 'x', isPublic: false }],
            solutionCode: 'SECRET_SOLUTION',
            templateCode: [{ language: 'python', code: 'def solve(values):\n    # write here\n    pass' }],
        };
        const prompts = buildPrompts(question, 'python', 3);
        const allText = JSON.stringify(prompts);
        check('prompts: 3 distinct phrasings with temperature variation', prompts.length === 3 && new Set(prompts.map((p) => p.prompt)).size === 3 && new Set(prompts.map((p) => p.temperature)).size === 3);
        check('prompts: include statement (HTML stripped), formats, constraints, sample and the driver stub', /maximum subarray sum/.test(prompts[0].prompt) && !/<strong>/.test(allText) && /n, then n integers/.test(prompts[0].prompt) && /10\^5/.test(prompts[0].prompt) && /1 -2 3 4 -1/.test(prompts[0].prompt) && /def solve\(values\)/.test(prompts[0].prompt));
        check('prompts: never include hidden test cases or the stored solution', !allText.includes('HIDDEN_CASE_INPUT') && !allText.includes('SECRET_SOLUTION'));

        // ---------------------------------------------------------------------------
        // Part 2: auto-generation with the database
        // ---------------------------------------------------------------------------
        const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
        await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
        try {
            const Question = require(path.join(ROOT, 'models', 'Question'));
            const Submission = require(path.join(ROOT, 'models', 'Submission'));
            const AiReference = require(path.join(ROOT, 'models', 'AiReference'));
            const AiGenerationJob = require(path.join(ROOT, 'models', 'AiGenerationJob'));
            await AiGenerationJob.init(); // unique index on key
            const { scheduleAiCheck, checker } = require(path.join(ROOT, 'utils', 'aiDetection'));
            const userId = new mongoose.Types.ObjectId();
            const q = await Question.create({
                title: 'Max subarray',
                description: '<p>Print the maximum subarray sum.</p>',
                difficulty: 'easy',
                type: 'coding',
                createdBy: userId,
                languages: ['python'],
                testCases: [{ input: 'HIDDEN_CASE_INPUT', expectedOutput: '1', isPublic: false }, { input: '1\n5', expectedOutput: '5', isPublic: true }],
                solutionCode: 'SECRET_SOLUTION',
            });
            const studentCode = REFERENCE.replace(/\bvalues\b/g, 'student_marker_arr').replace(/\bbest\b/g, 'ans').replace(/\bcurrent\b/g, 'cur');
            const subs = await Submission.create(
                Array.from({ length: 20 }, () => ({
                    questionId: q._id,
                    classId: new mongoose.Types.ObjectId(),
                    studentId: new mongoose.Types.ObjectId(),
                    answer: studentCode,
                    language: 'python',
                    examAttemptId: new mongoose.Types.ObjectId(),
                }))
            );
            requests.length = 0;
            scenario = {};
            delayMs = 150;
            subs.forEach((s) => scheduleAiCheck({ submissionId: s._id }));
            const deadline = Date.now() + 20_000;
            let checks = [];
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 300));
                checks = await Submission.find({ _id: { $in: subs.map((s) => s._id) } }).select('+aiCheck').lean();
                if (checks.every((c) => c.aiCheck?.status === 'done')) break;
            }
            delayMs = 0;
            const refCount = await AiReference.countDocuments({ questionId: q._id, language: 'python' });
            check('auto: 20 simultaneous answers start ONE generation (3 providers × 3 variants = 9 calls)', requests.length === 9, `${requests.length} provider calls`);
            check('auto: 9 references stored with source/model/variant', refCount === 9 && (await AiReference.distinct('source', { questionId: q._id })).length === 3, `${refCount} refs`);
            const percents = checks.map((c) => c.aiCheck?.percent);
            check('auto: waiting submissions re-checked → done with high similarity', checks.every((c) => c.aiCheck?.status === 'done' && c.aiCheck.percent >= 85 && c.aiCheck.matchedSource), `statuses ${[...new Set(checks.map((c) => c.aiCheck?.status))].join(',')} min% ${Math.min(...percents)}`);
            const everything = requests.map((r) => r.raw).join('\n');
            check('privacy: no provider request contains student code, hidden tests or the stored solution', !everything.includes('student_marker_arr') && !everything.includes('HIDDEN_CASE_INPUT') && !everything.includes('SECRET_SOLUTION'));
            const job = await AiGenerationJob.findOne({ key: `auto:${q._id}:python` }).lean();
            check('auto: generation job recorded as done (9/9)', job?.status === 'done' && job.completed === 9 && job.created === 9, JSON.stringify({ s: job?.status, c: job?.completed }));

            // A later answer uses the stored references (no new provider calls).
            requests.length = 0;
            const late = await Submission.create({ questionId: q._id, classId: userId, studentId: userId, answer: studentCode, language: 'python', examAttemptId: new mongoose.Types.ObjectId() });
            scheduleAiCheck({ submissionId: late._id });
            await new Promise((r) => setTimeout(r, 200));
            await checker.idle();
            const lateDoc = await Submission.findById(late._id).select('+aiCheck').lean();
            check('auto: later answers reuse references (no provider calls)', requests.length === 0 && lateDoc.aiCheck?.status === 'done', `${requests.length} calls, ${lateDoc.aiCheck?.status}`);
            const plainDoc = await Submission.findById(late._id).lean();
            check('aiCheck is not selected by default (never leaks into existing payloads)', plainDoc.aiCheck === undefined);
        } finally {
            await mongoose.connection.db.dropDatabase().catch(() => {});
            await mongoose.disconnect();
        }
    } catch (err) {
        failed += 1;
        console.error('ABORTED:', err?.stack || err);
    } finally {
        server.close();
    }
    console.log(`\n${passed}/${passed + failed} checks passed`);
    process.exit(failed ? 1 : 0);
})();
