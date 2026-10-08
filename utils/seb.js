'use strict';

/**
 * Safe Exam Browser (SEB) support.
 *
 * - Per-exam secrets: an ENTRY password (checked by this server when a student starts the exam) and an
 *   EXIT password (SEB's own quit password, stored in the .seb file only as its SHA-256 hash), plus a
 *   random token that authorises the unauthenticated .seb download (SEB fetches the file itself).
 * - The .seb file: an XML plist with the exam settings, written in SEB's documented unencrypted
 *   binary format: gzip( "plnd" + gzip(xml) ). Password encryption ("pswd") is intentionally not used.
 * - The Config Key: SHA-256 over SEB-JSON of the exact settings dictionary we put in the file, as in
 *   https://safeexambrowser.org/developer/seb-config-key.html and SEB for Windows' Json.cs /
 *   DataProcessor.cs: keys ordered case-insensitively (recursively), no whitespace, no escaping,
 *   "originatorVersion" and empty dictionaries skipped, lowercase hex digest.
 * - Request checks: basic = the User-Agent carries "SEB/<version>" (SEB for Windows builds
 *   "... Chrome/<v> SEB/<version> [suffix]") or our custom UA suffix; strict = the
 *   X-SafeExamBrowser-ConfigKeyHash header equals SHA-256(absolute URL without fragment + Config Key).
 *
 * SEB for Windows only adds the hash headers to main-frame requests and to requests whose host equals
 * the page's host. When the app and the API live on different hosts (algosutra.co.in vs
 * api.algosutra.co.in) the API never sees the native header, so the frontend also forwards the value of
 * SEB's JavaScript API (window.SafeExamBrowser.security.configKey = SHA-256(page URL + Config Key)) in
 * the same header as "jsapi;<hash>;<encoded page URL>[;<encoded page URL>]". We accept it when the hash
 * matches one of those page URLs and the URL is on the app origin (PUBLIC_APP_URL).
 */

const crypto = require('crypto');
const zlib = require('zlib');
const config = require('../config/env');

/** No 0/O, 1/I/L: the teacher reads these out loud and students type them. Upper case only. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 8;
/** Appended by SEB to its User-Agent (setting "browserUserAgent"); lets basic mode recognise our config. */
const SEB_UA_SUFFIX = 'AlgoSutraSEB/1';
const SEB_UA_PATTERN = /\bSEB\/\d/;
const CONFIG_KEY_HEADER = 'x-safeexambrowser-configkeyhash';
const HEX64 = /^[0-9a-f]{64}$/;

const ENTRY_MAX_FAILURES = 5;
const ENTRY_WINDOW_MS = 10 * 60 * 1000;
const ENTRY_LOCK_MS = 10 * 60 * 1000;

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

const generatePassword = (length = PASSWORD_LENGTH) => {
    let out = '';
    for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
    return out;
};

const generateToken = () => crypto.randomBytes(24).toString('base64url');

/** Timing-safe string equality (hashes both sides so lengths always match). */
const safeEqual = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
    const y = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
    return crypto.timingSafeEqual(x, y);
};

/** Entry passwords are compared trimmed and case-insensitively. */
const normalizePassword = (value) => String(value ?? '').trim().toUpperCase();
const entryPasswordMatches = (given, expected) =>
    Boolean(expected) && safeEqual(normalizePassword(given), normalizePassword(expected));

/** '' when empty; the lowercase key when it is a 64-hex Config Key; null when invalid. */
const normalizeConfigKeyOverride = (value) => {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v) return '';
    return HEX64.test(v) ? v : null;
};

// ---------------------------------------------------------------------------
// Exam secrets
// ---------------------------------------------------------------------------

const sebOf = (exam) => exam?.proctoring || {};
const isSebRequired = (exam) => Boolean(sebOf(exam).sebRequired);

/** Fresh entry/exit passwords and download token. */
const newSecrets = () => ({
    sebEntryPassword: generatePassword(),
    sebExitPassword: generatePassword(),
    sebConfigToken: generateToken(),
});

/** Fills in any missing secret (keeps existing ones). */
const ensureSecrets = (proctoring) => {
    const fresh = newSecrets();
    for (const key of Object.keys(fresh)) {
        if (!proctoring[key]) proctoring[key] = fresh[key];
    }
    return proctoring;
};

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const firstHeaderValue = (value) => String(value || '').split(',')[0].trim();

/** Public API base URL (no trailing slash): API_PUBLIC_URL, else what the request says. */
const apiBaseUrl = (req) => {
    if (config.apiPublicUrl) return config.apiPublicUrl;
    if (!req) return '';
    const host = firstHeaderValue(req.get('x-forwarded-host')) || req.get('host');
    return `${req.protocol}://${host}`;
};

const appBaseUrl = () => config.publicAppUrl;

const startUrlFor = (exam) => `${appBaseUrl()}/student/exams/${exam._id}`;

const configPathFor = (exam) => `/exams/${exam._id}/seb-config/${encodeURIComponent(sebOf(exam).sebConfigToken || '')}`;

/** https API -> sebs://host/path, http API -> seb://host/path (SEB maps them back to https/http). */
const launchLinkFor = (exam, req) => {
    const base = apiBaseUrl(req);
    if (!base || !sebOf(exam).sebConfigToken) return null;
    const url = new URL(base);
    const scheme = url.protocol === 'https:' ? 'sebs' : 'seb';
    const prefix = url.pathname.replace(/\/+$/, '');
    return `${scheme}://${url.host}${prefix}${configPathFor(exam)}`;
};

const configUrlFor = (exam, req) => {
    const base = apiBaseUrl(req);
    return base && sebOf(exam).sebConfigToken ? `${base}${configPathFor(exam)}` : null;
};

const hostOf = (value) => {
    try {
        return new URL(value).hostname;
    } catch {
        return '';
    }
};

// ---------------------------------------------------------------------------
// Settings, plist, SEB-JSON, Config Key
// ---------------------------------------------------------------------------

/**
 * The exact settings dictionary written into the .seb file. Keys are verified against SEB for Windows'
 * Keys.cs / data mappers; unknown keys are ignored by SEB but still part of the Config Key on both sides.
 * Only <true/>, <false/>, <integer>, <string>, <array>, <dict> are used (no <real>, no <date>).
 */
const buildSebSettings = (exam, req) => {
    const p = sebOf(exam);
    if (!appBaseUrl()) throw Object.assign(new Error('PUBLIC_APP_URL is not configured on the server'), { status: 500 });
    if (!p.sebExitPassword) throw Object.assign(new Error('Safe Exam Browser passwords have not been generated'), { status: 409 });
    const hosts = [...new Set([hostOf(appBaseUrl()), hostOf(apiBaseUrl(req))].filter(Boolean))];
    return {
        // 0 = this file starts an exam (1 would reconfigure the client permanently).
        sebConfigPurpose: 0,
        startURL: startUrlFor(exam),
        sendBrowserExamKey: true,
        browserUserAgent: SEB_UA_SUFFIX,
        // Quitting needs the exit password the teacher announces.
        allowQuit: true,
        hashedQuitPassword: sha256Hex(p.sebExitPassword),
        // Links/scripts may open new windows only on the same host (2 = new window; foreign hosts blocked).
        newBrowserWindowByLinkPolicy: 2,
        newBrowserWindowByLinkBlockForeign: true,
        newBrowserWindowByScriptPolicy: 2,
        newBrowserWindowByScriptBlockForeign: true,
        allowBrowsingBackForward: false,
        browserWindowAllowReload: true,
        showReloadButton: true,
        showReloadWarning: true,
        allowDownloads: false,
        allowPrint: false,
        allowSpellCheck: false,
        allowDeveloperConsole: false,
        enableRightMouse: false,
        enablePrintScreen: false,
        // Top-level navigation only to the app and the API; embedded resources (fonts, CDN scripts,
        // question images) are not filtered so the editor keeps working.
        URLFilterEnable: true,
        URLFilterEnableContentFilter: false,
        URLFilterRules: hosts.map((host) => ({ action: 1, active: true, expression: host, regex: false })),
    };
};

/** SEB's key order: culture-invariant, case-insensitive; lower case first on a tie. */
const compareKeys = (a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    if (a === b) return 0;
    return a > b ? -1 : 1;
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);

/** SEB-JSON: no whitespace, no escaping, sorted keys, originatorVersion and empty dicts skipped. */
const sebJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(sebJson).join(',')}]`;
    if (Buffer.isBuffer(value)) return `"${value.toString('base64')}"`;
    if (value instanceof Date) return value.toISOString();
    if (isPlainObject(value)) {
        const parts = Object.keys(value)
            .filter((k) => k.toLowerCase() !== 'originatorversion')
            .filter((k) => value[k] !== undefined)
            .filter((k) => !(isPlainObject(value[k]) && !Object.keys(value[k]).length))
            .sort(compareKeys)
            .map((k) => `"${k}":${sebJson(value[k])}`);
        return `{${parts.join(',')}}`;
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    // Our own settings only use integers; reals (only in imported files) print like .NET's invariant ToString.
    if (typeof value === 'number') return String(value);
    if (value === null) return '""';
    return `"${String(value)}"`;
};

const computeConfigKey = (settings) => sha256Hex(sebJson(settings));

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const plistValue = (value, indent) => {
    const pad = '\t'.repeat(indent);
    if (Array.isArray(value)) {
        if (!value.length) return `${pad}<array/>`;
        return `${pad}<array>\n${value.map((v) => plistValue(v, indent + 1)).join('\n')}\n${pad}</array>`;
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(compareKeys);
        if (!keys.length) return `${pad}<dict/>`;
        const body = keys.map((k) => `${pad}\t<key>${xmlEscape(k)}</key>\n${plistValue(value[k], indent + 1)}`).join('\n');
        return `${pad}<dict>\n${body}\n${pad}</dict>`;
    }
    if (typeof value === 'boolean') return `${pad}<${value}/>`;
    if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
    if (Buffer.isBuffer(value)) return `${pad}<data>${value.toString('base64')}</data>`;
    return `${pad}<string>${xmlEscape(value ?? '')}</string>`;
};

const buildPlistXml = (settings) =>
    [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        plistValue(settings, 0),
        '</plist>',
        '',
    ].join('\n');

/** Unencrypted .seb: gzip("plnd" + gzip(xml)), per safeexambrowser.org/developer/seb-file-format.html. */
const encodeSebFile = (xml) => zlib.gzipSync(Buffer.concat([Buffer.from('plnd', 'utf8'), zlib.gzipSync(Buffer.from(xml, 'utf8'))]));

/** Inverse of encodeSebFile (also accepts a raw XML plist). Used by tests and diagnostics. */
const decodeSebFile = (buffer) => {
    let data = Buffer.from(buffer);
    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    if (data.subarray(0, 4).toString('utf8') === 'plnd') {
        data = data.subarray(4);
        if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    }
    return data.toString('utf8');
};

const buildSebFile = (exam, req) => {
    const settings = buildSebSettings(exam, req);
    const xml = buildPlistXml(settings);
    return { settings, xml, buffer: encodeSebFile(xml), configKey: computeConfigKey(settings) };
};

/** The Config Key requests are checked against: the teacher's override, else the computed key. */
const expectedConfigKey = (exam, req) => {
    const override = normalizeConfigKeyOverride(sebOf(exam).sebConfigKeyOverride);
    if (override) return { key: override, source: 'override' };
    return { key: computeConfigKey(buildSebSettings(exam, req)), source: 'computed' };
};

const fileNameFor = (exam) => {
    const base = String(exam.title || 'exam')
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return `${base || 'exam'}.seb`;
};

// ---------------------------------------------------------------------------
// Request checks
// ---------------------------------------------------------------------------

const userAgentMatches = (req) => {
    const ua = String(req.get('user-agent') || '');
    return SEB_UA_PATTERN.test(ua) || ua.includes(SEB_UA_SUFFIX);
};

/** Absolute URLs this request may have had in the browser (fragment never reaches the server). */
const candidateRequestUrls = (req) => {
    const path = req.originalUrl || req.url || '/';
    const urls = new Set();
    const host = req.get('host');
    if (host) urls.add(`${req.protocol}://${host}${path}`);
    const fwdHost = firstHeaderValue(req.get('x-forwarded-host'));
    if (fwdHost) {
        const fwdProto = firstHeaderValue(req.get('x-forwarded-proto')) || req.protocol;
        urls.add(`${fwdProto}://${fwdHost}${path}`);
        urls.add(`${req.protocol}://${fwdHost}${path}`);
    }
    if (config.apiPublicUrl) urls.add(`${config.apiPublicUrl}${path}`);
    return [...urls];
};

const stripFragment = (url) => String(url).split('#')[0];

/** Parses the header: a plain 64-hex hash (native SEB) or "jsapi;<hash>;<encoded page URL>;..." (frontend). */
const parseConfigKeyHeader = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (HEX64.test(value.toLowerCase())) return { source: 'header', hash: value.toLowerCase(), pageUrls: [] };
    const parts = value.split(';');
    if (parts[0] !== 'jsapi' || !HEX64.test(String(parts[1] || '').toLowerCase())) return { source: 'invalid', hash: null, pageUrls: [] };
    const pageUrls = parts
        .slice(2, 6)
        .map((p) => {
            try {
                return stripFragment(decodeURIComponent(p));
            } catch {
                return '';
            }
        })
        .filter(Boolean);
    return { source: 'jsapi', hash: parts[1].toLowerCase(), pageUrls };
};

const onAppOrigin = (url) => {
    try {
        return Boolean(appBaseUrl()) && new URL(url).origin === new URL(appBaseUrl()).origin;
    } catch {
        return false;
    }
};

/**
 * Full diagnosis of one request against one exam.
 * ok = what enforcement uses: basic -> UA matched or a valid Config Key hash; strict -> valid hash only.
 */
const checkSebRequest = (req, exam) => {
    const mode = sebOf(exam).sebVerifyMode === 'strict' ? 'strict' : 'basic';
    const uaMatched = userAgentMatches(req);
    const parsed = parseConfigKeyHeader(req.get(CONFIG_KEY_HEADER));
    let configKeyHashValid = false;
    let configKeySource = null;
    let configKeyError = null;
    if (parsed?.hash) {
        try {
            const expected = expectedConfigKey(exam, req);
            configKeySource = expected.source;
            const urls = parsed.source === 'header' ? candidateRequestUrls(req) : parsed.pageUrls.filter(onAppOrigin);
            configKeyHashValid = urls.some((url) => safeEqual(sha256Hex(stripFragment(url) + expected.key), parsed.hash));
        } catch (err) {
            configKeyError = err.message;
        }
    }
    const inSeb = uaMatched || configKeyHashValid;
    return {
        ok: mode === 'strict' ? configKeyHashValid : inSeb,
        expectedMode: mode,
        inSeb,
        uaMatched,
        configKeyHashPresent: Boolean(parsed),
        configKeyHashSource: parsed?.source || null,
        configKeyHashValid,
        configKeySource,
        ...(configKeyError ? { configKeyError } : {}),
    };
};

const SEB_REQUIRED_BODY = { error: 'This exam must be taken in Safe Exam Browser', code: 'SEB_REQUIRED' };

/** Staff-only view of an exam's SEB setup (passwords included). */
const staffSebView = (exam, req) => {
    const p = sebOf(exam);
    const view = {
        required: Boolean(p.sebRequired),
        verifyMode: p.sebVerifyMode === 'strict' ? 'strict' : 'basic',
        entryPassword: p.sebEntryPassword || null,
        exitPassword: p.sebExitPassword || null,
        configKeyOverride: p.sebConfigKeyOverride || '',
        launchLink: null,
        configUrl: null,
        startUrl: appBaseUrl() ? startUrlFor(exam) : null,
        configKey: null,
        configFileName: fileNameFor(exam),
        userAgentSuffix: SEB_UA_SUFFIX,
    };
    if (view.required && p.sebConfigToken) {
        view.launchLink = launchLinkFor(exam, req);
        view.configUrl = configUrlFor(exam, req);
        try {
            view.configKey = computeConfigKey(buildSebSettings(exam, req));
        } catch {
            view.configKey = null;
        }
    }
    return view;
};

module.exports = {
    PASSWORD_ALPHABET,
    SEB_UA_SUFFIX,
    CONFIG_KEY_HEADER,
    ENTRY_MAX_FAILURES,
    ENTRY_WINDOW_MS,
    ENTRY_LOCK_MS,
    SEB_REQUIRED_BODY,
    sha256Hex,
    generatePassword,
    generateToken,
    safeEqual,
    normalizePassword,
    entryPasswordMatches,
    normalizeConfigKeyOverride,
    isSebRequired,
    newSecrets,
    ensureSecrets,
    apiBaseUrl,
    startUrlFor,
    launchLinkFor,
    configUrlFor,
    buildSebSettings,
    sebJson,
    computeConfigKey,
    buildPlistXml,
    encodeSebFile,
    decodeSebFile,
    buildSebFile,
    expectedConfigKey,
    fileNameFor,
    userAgentMatches,
    candidateRequestUrls,
    parseConfigKeyHeader,
    checkSebRequest,
    staffSebView,
};
