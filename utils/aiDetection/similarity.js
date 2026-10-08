'use strict';

/**
 * Source-code similarity, computed locally (nothing leaves the server).
 *
 * Pipeline for each text:
 *   1. tokenize (comments dropped; identifiers → ID, numbers → NUM, strings → STR; whitespace-insensitive)
 *   2. remove boilerplate: tokens covered by a run of ≥ BOILER_K raw tokens that also occurs in the
 *      question's starter / template / driver / snippet code for that language (students start from it,
 *      so it says nothing about where their code came from)
 *   3. on what remains ("effective tokens"):
 *        - k-gram fingerprints selected by winnowing → containment in both directions
 *        - Greedy String Tiling (minimum match length MML) → normalized coverage + matched regions
 *
 * score = 100 × (0.5·tiling + 0.25·containment(student in ref) + 0.25·containment(ref in student))
 * where tiling = 2·tiled / (|A| + |B|). Identical token streams score 100.
 */

const { tokenize, normalizeLanguage } = require('./tokenizer');
const { IDIOMS } = require('./idioms');

const K = 5; // fingerprint k-gram size (tokens)
const WINDOW = 4; // winnowing window
const MML = 6; // minimum tile length for greedy string tiling
const BOILER_K = 5; // raw k-gram size used to detect boilerplate (identifiers verbatim)
const BOILER_NK = 10; // normalized k-gram size: also catches the given code with renamed identifiers
const MAX_TOKENS = 2000; // hard cap per text (keeps the O(n·m) tiling bounded; ~400 lines of code)
const DEFAULT_MIN_TOKENS = 25; // fewer effective tokens than this → 'too_short'

const VERSION = 1;

/** 32-bit FNV-1a of a string. */
const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
};

/** Shared vocabulary → small ints so tiling compares numbers. */
const vocab = new Map();
const idOf = (t) => {
    let id = vocab.get(t);
    if (id === undefined) {
        id = vocab.size + 1;
        vocab.set(t, id);
    }
    return id;
};

/** Normalized token sequences of the language's generic I/O idioms (cached). */
const idiomCache = new Map();
const idiomsFor = (language) => {
    const lang = normalizeLanguage(language);
    if (!idiomCache.has(lang)) {
        idiomCache.set(
            lang,
            (IDIOMS[lang] || []).map((src) => tokenize(src, lang).map((t) => t.t)).filter((seq) => seq.length >= 4)
        );
    }
    return idiomCache.get(lang);
};

/**
 * Build the boilerplate index for one question + language from its student-visible code
 * (starter code, template, driver, fill-the-code snippet), plus the language's generic I/O idioms.
 */
const buildBoilerplate = (sources, language) => {
    const grams = new Set();
    const normGrams = new Set();
    for (const src of sources || []) {
        if (!src || typeof src !== 'string' || !src.trim()) continue;
        const toks = tokenize(src, language).slice(0, MAX_TOKENS);
        for (let i = 0; i + BOILER_K <= toks.length; i += 1) {
            grams.add(toks.slice(i, i + BOILER_K).map((t) => t.r).join('\u0001'));
        }
        for (let i = 0; i + BOILER_NK <= toks.length; i += 1) {
            normGrams.add(toks.slice(i, i + BOILER_NK).map((t) => t.t).join('\u0001'));
        }
    }
    return { grams, normGrams, idioms: idiomsFor(language), language: normalizeLanguage(language) };
};

/** Tokenize + remove boilerplate. The result can be compared against many references. */
const prepare = (code, language, boilerplate) => {
    const all = tokenize(code, language).slice(0, MAX_TOKENS);
    const isBoiler = new Uint8Array(all.length);
    let boilerTokens = 0;
    if (boilerplate?.grams?.size) {
        for (let i = 0; i + BOILER_K <= all.length; i += 1) {
            const slice = all.slice(i, i + BOILER_K);
            if (!slice.some((t) => t.w)) continue; // pure punctuation runs are not evidence of boilerplate
            if (boilerplate.grams.has(slice.map((t) => t.r).join('\u0001'))) {
                for (let k = i; k < i + BOILER_K; k += 1) isBoiler[k] = 1;
            }
        }
    }
    if (boilerplate?.normGrams?.size) {
        for (let i = 0; i + BOILER_NK <= all.length; i += 1) {
            if (boilerplate.normGrams.has(all.slice(i, i + BOILER_NK).map((t) => t.t).join(''))) {
                for (let k = i; k < i + BOILER_NK; k += 1) isBoiler[k] = 1;
            }
        }
    }
    for (const seq of boilerplate?.idioms || []) {
        const L = seq.length;
        for (let i = 0; i + L <= all.length; i += 1) {
            if (all[i].t !== seq[0]) continue;
            let k = 1;
            while (k < L && all[i + k].t === seq[k]) k += 1;
            if (k === L) for (let j = i; j < i + L; j += 1) isBoiler[j] = 1;
        }
    }
    const eff = []; // indices into `all`
    for (let i = 0; i < all.length; i += 1) {
        if (isBoiler[i]) boilerTokens += 1;
        else eff.push(i);
    }
    const ids = Int32Array.from(eff.map((i) => idOf(all[i].t)));
    return { code: String(code ?? ''), all, eff, ids, boilerTokens, fingerprints: winnow(ids) };
};

/** Winnowing over k-gram hashes: the minimum of every window of WINDOW consecutive hashes (rightmost on ties). */
function winnow(ids) {
    const hashes = [];
    for (let i = 0; i + K <= ids.length; i += 1) {
        let key = '';
        for (let k = i; k < i + K; k += 1) key += `${ids[k]},`;
        hashes.push(fnv(key));
    }
    const picked = new Set();
    if (!hashes.length) return picked;
    if (hashes.length <= WINDOW) {
        hashes.forEach((h) => picked.add(h));
        return picked;
    }
    for (let i = 0; i + WINDOW <= hashes.length; i += 1) {
        let min = i;
        for (let j = i + 1; j < i + WINDOW; j += 1) if (hashes[j] <= hashes[min]) min = j;
        picked.add(hashes[min]);
    }
    return picked;
}

/**
 * Greedy String Tiling (Wise 1993) on two int arrays. Returns tiles [{a, b, len}] (indices into the
 * arrays) of length >= minLen, longest first, non-overlapping in both sequences.
 *
 * run[i][j] (length of the common run starting at A[i], B[j]) is precomputed once (O(n*m), n,m <=
 * MAX_TOKENS), so each round is a single O(n*m) scan bounded by the unmarked stretch at i and j.
 * Rounds are capped, which bounds pathological (highly repetitive) inputs.
 */
const MAX_ROUNDS = 400;
const greedyTiles = (A, B, minLen = MML) => {
    const n = A.length;
    const m = B.length;
    const tiles = [];
    if (!n || !m) return tiles;
    const w = m + 1;
    const run = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
        const row = i * w;
        const next = row + w;
        const ai = A[i];
        for (let j = m - 1; j >= 0; j -= 1) {
            if (ai === B[j]) {
                const v = run[next + j + 1] + 1;
                run[row + j] = v > 65535 ? 65535 : v;
            }
        }
    }
    const markedA = new Uint8Array(n);
    const markedB = new Uint8Array(m);
    const freeA = new Int32Array(n + 1);
    const freeB = new Int32Array(m + 1);
    const refreshFree = () => {
        freeA[n] = 0;
        for (let i = n - 1; i >= 0; i -= 1) freeA[i] = markedA[i] ? 0 : freeA[i + 1] + 1;
        freeB[m] = 0;
        for (let j = m - 1; j >= 0; j -= 1) freeB[j] = markedB[j] ? 0 : freeB[j + 1] + 1;
    };
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
        refreshFree();
        let maxMatch = minLen;
        let matches = [];
        for (let i = 0; i < n; i += 1) {
            const fa = freeA[i];
            if (fa < maxMatch) continue;
            const row = i * w;
            for (let j = 0; j < m; j += 1) {
                let len = run[row + j];
                if (len < maxMatch) continue;
                if (fa < len) len = fa;
                if (freeB[j] < len) len = freeB[j];
                if (len < maxMatch) continue;
                if (len === maxMatch) matches.push(i, j);
                else {
                    maxMatch = len;
                    matches = [i, j];
                }
            }
        }
        if (!matches.length) break;
        for (let k = 0; k < matches.length; k += 2) {
            const a = matches[k];
            const b = matches[k + 1];
            let free = true;
            for (let x = 0; x < maxMatch && free; x += 1) if (markedA[a + x] || markedB[b + x]) free = false;
            if (!free) continue;
            for (let x = 0; x < maxMatch; x += 1) {
                markedA[a + x] = 1;
                markedB[b + x] = 1;
            }
            tiles.push({ a, b, len: maxMatch });
        }
    }
    return tiles;
};

/** Character / line span of effective tokens [from, to) of a prepared text. */
const spanOf = (p, from, to) => {
    const first = p.all[p.eff[from]];
    const last = p.all[p.eff[to - 1]];
    return { start: first.s, end: last.e, lineStart: first.l, lineEnd: last.l };
};

/** Turn tiles into highlight ranges for both texts (largest first, capped). */
const rangesFor = (a, b, tiles, limit = 60) =>
    tiles
        .slice()
        .sort((x, y) => y.len - x.len)
        .slice(0, limit)
        .map((t) => ({ tokens: t.len, a: spanOf(a, t.a, t.a + t.len), b: spanOf(b, t.b, t.b + t.len) }))
        .sort((x, y) => x.a.start - y.a.start);

const intersectSize = (x, y) => {
    let n = 0;
    const [small, big] = x.size <= y.size ? [x, y] : [y, x];
    for (const h of small) if (big.has(h)) n += 1;
    return n;
};

/**
 * Compare two prepared texts. `a` is the student's code, `b` a reference.
 * @returns {{percent:number, tiling:number, containA:number, containB:number, matches:Array, tiledTokens:number}}
 */
const comparePrepared = (a, b, { withMatches = true } = {}) => {
    const lenA = a.ids.length;
    const lenB = b.ids.length;
    if (!lenA || !lenB) return { percent: 0, tiling: 0, containA: 0, containB: 0, tiledTokens: 0, matches: [] };
    const tiles = greedyTiles(a.ids, b.ids, Math.min(MML, lenA, lenB));
    const tiled = tiles.reduce((s, t) => s + t.len, 0);
    const tiling = (2 * tiled) / (lenA + lenB);
    const shared = intersectSize(a.fingerprints, b.fingerprints);
    const containA = a.fingerprints.size ? shared / a.fingerprints.size : 0;
    const containB = b.fingerprints.size ? shared / b.fingerprints.size : 0;
    const raw = 0.5 * tiling + 0.25 * containA + 0.25 * containB;
    const percent = Math.max(0, Math.min(100, Math.round(raw * 100)));
    return {
        percent,
        tiling: Math.round(tiling * 1000) / 1000,
        containA: Math.round(containA * 1000) / 1000,
        containB: Math.round(containB * 1000) / 1000,
        tiledTokens: tiled,
        matches: withMatches ? rangesFor(a, b, tiles) : [],
    };
};

/**
 * One-shot comparison.
 * @param {string} studentCode
 * @param {string} referenceCode
 * @param {{language?: string, boilerplate?: string[], minTokens?: number}} [opts]
 * @returns {{status: 'ok'|'too_short', percent: number|null, tokens: number, ...}}
 */
const compareCode = (studentCode, referenceCode, opts = {}) => {
    const bp = buildBoilerplate(opts.boilerplate || [], opts.language);
    const a = prepare(studentCode, opts.language, bp);
    const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
    if (a.ids.length < minTokens) return { status: 'too_short', percent: null, tokens: a.ids.length, matches: [] };
    const b = prepare(referenceCode, opts.language, bp);
    return { status: 'ok', tokens: a.ids.length, referenceTokens: b.ids.length, ...comparePrepared(a, b) };
};

module.exports = {
    VERSION,
    DEFAULT_MIN_TOKENS,
    K,
    WINDOW,
    MML,
    buildBoilerplate,
    prepare,
    comparePrepared,
    compareCode,
    greedyTiles,
};
