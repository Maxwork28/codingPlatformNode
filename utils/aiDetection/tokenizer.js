'use strict';

/**
 * Language-aware, whitespace-insensitive tokenizer for source-code similarity.
 *
 * Supported: C, C++, Java, JavaScript, Go, PHP (C-like comments), Python, Ruby (# comments).
 * Every token keeps two forms:
 *   r  raw form: identifiers verbatim, string/number literals collapsed (used to detect the shared
 *      starter/template/driver code, whose identifiers students keep as given)
 *   t  normalized form: user identifiers → ID, numbers → NUM, strings → STR, keywords/built-ins kept
 *      (used for scoring, so renaming variables or reformatting does not change anything)
 * plus its character span (s, e) and 1-based line (l) for highlighting.
 *
 * Dropped entirely: comments, Python docstrings, preprocessor lines, import/package/using lines,
 * PHP open/close tags, and the style-only punctuation `;` `{` `}`.
 */

const words = (s) => s.split(/\s+/).filter(Boolean);

/**
 * Reserved words: always kept verbatim (keywords, literals, primitive types, standard streams).
 * Built-ins: kept verbatim only where used as an API (after `.` `->` `::`, or followed by `(` `.`
 * `::` `->`), e.g. `len(x)`, `arr.append`, `Math.max`, `fmt.Println`; a variable that happens to be
 * called `values`, `count` or `max` is still an ID, so renaming it changes nothing.
 */
const RESERVED = {
    c: words(`
    auto break case char const continue default do double else enum extern float for goto if inline int
    long register return short signed sizeof static struct switch typedef union unsigned void volatile
    while NULL main
  `),
    cpp: words(`
    auto break case char const continue default do double else enum extern float for goto if inline int
    long register return short signed sizeof static struct switch typedef union unsigned void volatile
    while bool true false class public private protected virtual template typename namespace new delete
    this nullptr try catch throw operator friend static_cast const_cast dynamic_cast reinterpret_cast
    std string cin cout cerr endl vector map unordered_map set unordered_set multiset multimap pair tuple
    queue stack deque priority_queue array bitset main NULL
  `),
    java: words(`
    abstract assert boolean break byte case catch char class const continue default do double else enum
    extends final finally float for if implements instanceof int interface long native new private
    protected public return short static strictfp super switch synchronized this throw throws transient
    try void volatile while var true false null String main
  `),
    javascript: words(`
    break case catch class const continue debugger default delete do else export extends finally for
    function if in instanceof let new return super switch this throw try typeof var void while with
    yield async await of true false null undefined
  `),
    python: words(`
    False None True and as assert async await break class continue def del elif else except finally for
    global if in is lambda nonlocal not or pass raise return try while with yield self __name__ __main__
  `),
    ruby: words(`
    alias and begin break case class def do else elsif end ensure false for if in module next nil not
    or redo rescue retry return self super then true undef unless until when while yield puts gets
  `),
    php: words(`
    abstract and array as break case catch class clone const continue default do echo else elseif empty
    extends final finally fn for foreach function global if implements instanceof interface isset list
    match new or print private protected public return static switch throw try unset use var while xor
    yield true false null STDIN PHP_EOL
  `),
    go: words(`
    break case chan const continue default defer else fallthrough for func go goto if interface map
    range return select struct switch type var true false nil int int64 int32 uint uint64 byte rune
    float64 string bool error main
  `),
};

const BUILTINS = {
    c: words(`
    printf scanf malloc calloc realloc free memset memcpy strlen strcmp strcpy strcat qsort abs getchar
    putchar puts gets fgets stdin stdout sqrt pow fabs
  `),
    cpp: words(`
    getline scanf printf ios sync_with_stdio tie begin end rbegin rend push_back pop_back emplace_back
    emplace insert erase find count first second make_pair front back top empty clear resize reserve
    reverse accumulate memset swap lower_bound upper_bound unique greater less size length push pop
    min max abs sort INT_MAX INT_MIN LLONG_MAX LLONG_MIN substr to_string stoi stoll sqrt pow fill
  `),
    java: words(`
    System out println print printf in Scanner nextInt nextLine next nextLong nextDouble hasNext
    hasNextInt BufferedReader InputStreamReader readLine parseInt parseLong Integer Long Double
    Character Math max min abs Arrays asList sort fill stream List ArrayList LinkedList Map HashMap
    TreeMap Set HashSet TreeSet Queue Deque ArrayDeque PriorityQueue Collections StringBuilder get put
    add remove contains containsKey getOrDefault toString charAt substring toCharArray equals valueOf
    MAX_VALUE MIN_VALUE isEmpty poll offer peek trim length size split join append reverse
  `),
    javascript: words(`
    console log error require process stdin stdout readline createInterface Number parseInt
    parseFloat Math max min abs floor ceil round sqrt pow push pop shift unshift slice splice sort
    forEach map filter reduce includes indexOf toString trim Array from fill Set Map has get set add
    keys values entries Object JSON stringify parse String Infinity BigInt fs readFileSync module
    exports on resolve length split join reverse concat some every
  `),
    python: words(`
    print input int str float list dict set tuple range enumerate zip sorted reversed open sys stdin read
    readline readlines strip rstrip split extend insert reverse items keys values get format isdigit
    lower upper collections deque defaultdict Counter heapq heappush heappop math inf bisect any all
    ord chr isinstance setdefault len sum min max abs map filter append pop join sort count index
    popleft appendleft
  `),
    ruby: words(`
    to_i to_s to_a chomp strip each each_with_index map times upto downto select reject inject reduce
    STDIN read lambda proc attr_accessor first last length size push pop sum split join min max sort
    print p
  `),
    php: words(`
    count strlen explode implode trim fgets intval max min sizeof array_push array_pop array_sum
    array_map fscanf str_split sort rsort abs
  `),
    go: words(`
    len cap make append copy delete panic fmt Println Printf Print Scan Scanln Scanf Sprintf Sprint
    bufio NewReader NewScanner NewWriter os Stdin Stdout ReadString Text strings Split Fields TrimSpace
    strconv Atoi Itoa sort Ints Slice Flush math MaxInt MinInt Max Min Abs
  `),
};

const toSet = (lists) => new Set(lists.flat());
const RESERVED_SET = {};
const BUILTIN_SET = {};
for (const lang of Object.keys(RESERVED)) {
    RESERVED_SET[lang] = toSet([RESERVED[lang]]);
    BUILTIN_SET[lang] = toSet([BUILTINS[lang]]);
}
const DEFAULT_RESERVED = toSet(Object.values(RESERVED));
const DEFAULT_BUILTIN = toSet(Object.values(BUILTINS));
const MEMBER_BEFORE = new Set(['.', '->', '::', '?.']);
const API_AFTER = new Set(['(', '.', '::', '->']);

const HASH_COMMENT = new Set(['python', 'ruby', 'php']);
const SLASH_COMMENT = new Set(['c', 'cpp', 'java', 'javascript', 'go', 'php']);
const PREPROCESSOR = new Set(['c', 'cpp']);

// Longest first.
const OPERATORS = [
    '>>>=', '<<=', '>>=', '**=', '//=', '===', '!==', '>>>', '<=>', '...', '&&=', '||=', '??=',
    '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    '->', '=>', '::', '<<', '>>', '**', '//', ':=', '?.', '??', '<-',
];
const NORMALIZE_OP = { '===': '==', '!==': '!=' };
const DROP_PUNCT = new Set([';', '{', '}']);
const DECL_JS = new Set(['let', 'const', 'var']);
const STRING_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;

const isIdStart = (c) => /[A-Za-z_$À-￿]/.test(c);
const isIdPart = (c) => /[\w$À-￿]/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';

const normalizeLanguage = (language) => {
    const l = String(language || '').toLowerCase();
    if (l === 'c++') return 'cpp';
    if (l === 'js' || l === 'node') return 'javascript';
    if (l === 'py' || l === 'python3') return 'python';
    if (l === 'golang') return 'go';
    return l;
};

/**
 * Raw lexing: returns [{kind, text, s, e, l}] with comments removed.
 * kind: 'id' | 'num' | 'str' | 'op' | 'nl'
 */
const lex = (code, lang) => {
    const src = String(code ?? '').replace(/\r\n?/g, '\n');
    const out = [];
    const n = src.length;
    let i = 0;
    let line = 1;
    let lineStart = true; // only whitespace seen since the last newline
    const hashComments = HASH_COMMENT.has(lang) || !lang;
    const slashComments = SLASH_COMMENT.has(lang) || !lang || !HASH_COMMENT.has(lang);
    const countLines = (from, to) => {
        for (let k = from; k < to; k += 1) if (src[k] === '\n') line += 1;
    };

    while (i < n) {
        const c = src[i];
        if (c === '\n') {
            out.push({ kind: 'nl', text: '\n', s: i, e: i + 1, l: line });
            line += 1;
            i += 1;
            lineStart = true;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
            i += 1;
            continue;
        }
        // PHP tags
        if (lang === 'php' && src.startsWith('<?php', i)) {
            i += 5;
            continue;
        }
        if (lang === 'php' && src.startsWith('?>', i)) {
            i += 2;
            continue;
        }
        // Ruby block comment =begin ... =end (must start a line)
        if (lang === 'ruby' && lineStart && src.startsWith('=begin', i)) {
            const end = src.indexOf('\n=end', i);
            const stop = end < 0 ? n : src.indexOf('\n', end + 1) < 0 ? n : src.indexOf('\n', end + 1);
            countLines(i, stop);
            i = stop;
            continue;
        }
        // C/C++ preprocessor line (with backslash continuations)
        if (PREPROCESSOR.has(lang) && lineStart && c === '#') {
            let j = i;
            while (j < n && src[j] !== '\n') {
                if (src[j] === '\\' && src[j + 1] === '\n') {
                    j += 2;
                    line += 1;
                    continue;
                }
                j += 1;
            }
            i = j;
            continue;
        }
        // Comments
        if (slashComments && c === '/' && src[i + 1] === '/' && lang !== 'python') {
            while (i < n && src[i] !== '\n') i += 1;
            continue;
        }
        if (slashComments && c === '/' && src[i + 1] === '*' && lang !== 'python' && lang !== 'ruby') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? n : end + 2;
            countLines(i, stop);
            i = stop;
            continue;
        }
        if (hashComments && c === '#' && !(lang === 'ruby' && src[i + 1] === '{')) {
            while (i < n && src[i] !== '\n') i += 1;
            continue;
        }
        lineStart = false;

        // Strings
        if (c === '"' || c === "'" || c === '`') {
            const start = i;
            const startLine = line;
            const triple = (lang === 'python' || !lang) && (src.startsWith('"""', i) || src.startsWith("'''", i));
            if (triple) {
                const q = src.slice(i, i + 3);
                const end = src.indexOf(q, i + 3);
                const stop = end < 0 ? n : end + 3;
                countLines(i, stop);
                i = stop;
                out.push({ kind: 'str', text: 'STR', s: start, e: i, l: startLine, triple: true });
                continue;
            }
            const raw = c === '`' && (lang === 'go' || lang === 'javascript' || !lang);
            i += 1;
            while (i < n && src[i] !== c) {
                if (src[i] === '\\' && !(raw && lang === 'go')) {
                    if (src[i + 1] === '\n') line += 1;
                    i += 2;
                    continue;
                }
                if (src[i] === '\n') {
                    if (!raw) break; // unterminated single-line string
                    line += 1;
                }
                i += 1;
            }
            if (i < n && src[i] === c) i += 1;
            out.push({ kind: 'str', text: 'STR', s: start, e: i, l: startLine });
            continue;
        }

        // Numbers (decimal, hex, binary, octal, floats, exponents, suffixes, separators)
        if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
            const start = i;
            if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')) {
                i += 2;
                while (i < n && /[\w]/.test(src[i])) i += 1;
            } else {
                while (i < n && /[\d_]/.test(src[i])) i += 1;
                if (src[i] === '.' && isDigit(src[i + 1] || '')) {
                    i += 1;
                    while (i < n && /[\d_]/.test(src[i])) i += 1;
                } else if (src[i] === '.' && !isIdStart(src[i + 1] || '') && src[i + 1] !== '.') {
                    i += 1; // "1." float
                }
                if (/[eE]/.test(src[i] || '') && /[\d+-]/.test(src[i + 1] || '')) {
                    i += 2;
                    while (i < n && isDigit(src[i])) i += 1;
                }
                while (i < n && /[a-zA-Z]/.test(src[i])) i += 1; // L, f, ULL, n (BigInt), j
            }
            out.push({ kind: 'num', text: 'NUM', s: start, e: i, l: line });
            continue;
        }

        // Identifiers / keywords (PHP $vars, Ruby @ivars / predicate? methods)
        if (isIdStart(c) || ((lang === 'php' || lang === 'ruby') && (c === '$' || c === '@') && isIdStart(src[i + 1] || ''))) {
            const start = i;
            i += 1;
            if (lang === 'ruby' && src[i - 1] === '@' && src[i] === '@') i += 1;
            while (i < n && isIdPart(src[i])) i += 1;
            if (lang === 'ruby' && (src[i] === '?' || src[i] === '!') && src[i + 1] !== '=') i += 1;
            const text = src.slice(start, i);
            // Python string prefixes: f"..", r'..', b"..", rb'..'
            if ((lang === 'python' || !lang) && STRING_PREFIX.test(text) && (src[i] === '"' || src[i] === "'")) {
                const q = src.startsWith('"""', i) || src.startsWith("'''", i) ? src.slice(i, i + 3) : src[i];
                const end = src.indexOf(q, i + q.length);
                const stop = end < 0 ? n : end + q.length;
                const startLine = line;
                countLines(i, stop);
                i = stop;
                out.push({ kind: 'str', text: 'STR', s: start, e: i, l: startLine });
                continue;
            }
            out.push({ kind: 'id', text, s: start, e: i, l: line });
            continue;
        }

        // Operators / punctuation
        const op = OPERATORS.find((o) => src.startsWith(o, i) && !(o === '//' && lang !== 'python'));
        if (op) {
            out.push({ kind: 'op', text: op, s: i, e: i + op.length, l: line });
            i += op.length;
            continue;
        }
        out.push({ kind: 'op', text: c, s: i, e: i + 1, l: line });
        i += 1;
    }
    return out;
};

/** Drop import / package / using lines (and Go import blocks), plus Python docstrings. */
const dropNoise = (raw, lang) => {
    const out = [];
    let lineFirst = true;
    for (let i = 0; i < raw.length; i += 1) {
        const tok = raw[i];
        if (tok.kind === 'nl') {
            lineFirst = true;
            out.push(tok);
            continue;
        }
        if (lineFirst && tok.kind === 'id') {
            const w = tok.text;
            let skip = false;
            if (w === 'import' || w === 'package') skip = true;
            else if (w === 'using' && (lang === 'cpp' || !lang)) skip = true;
            else if (w === 'from' && (lang === 'python' || !lang)) {
                for (let j = i + 1; j < raw.length && raw[j].kind !== 'nl'; j += 1) if (raw[j].text === 'import') skip = true;
            } else if ((w === 'require' || w === 'require_relative') && lang === 'ruby') skip = true;
            if (skip) {
                // Go: import ( ... ) spanning lines
                let j = i + 1;
                if (lang === 'go' && raw[j]?.text === '(') {
                    while (j < raw.length && raw[j].text !== ')') j += 1;
                }
                while (j < raw.length && raw[j].kind !== 'nl') j += 1;
                i = j - 1;
                continue;
            }
        }
        // Python docstring: a triple-quoted string that starts a logical line
        if (tok.triple && lineFirst) {
            lineFirst = false;
            continue;
        }
        lineFirst = false;
        out.push(tok);
    }
    return out.filter((t) => t.kind !== 'nl');
};

/**
 * Tokenize source code.
 * @returns {Array<{t: string, r: string, s: number, e: number, l: number, w: boolean}>}
 *   w = word token (identifier or keyword)
 */
const tokenize = (code, language) => {
    const lang = normalizeLanguage(language);
    const reserved = RESERVED_SET[lang] || DEFAULT_RESERVED;
    const builtins = BUILTIN_SET[lang] || DEFAULT_BUILTIN;
    const raw = dropNoise(lex(code, lang), lang);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 1) {
        const tok = raw[i];
        if (tok.kind === 'op' && DROP_PUNCT.has(tok.text)) continue;
        let t;
        let r;
        if (tok.kind === 'id') {
            r = tok.text;
            const prev = raw[i - 1];
            const next = raw[i + 1];
            if (lang === 'javascript' && DECL_JS.has(r)) t = 'var';
            else if (reserved.has(r)) t = r;
            else if (
                builtins.has(r) &&
                ((prev?.kind === 'op' && MEMBER_BEFORE.has(prev.text)) ||
                    (next?.kind === 'op' && (API_AFTER.has(next.text) || (next.text === '<' && /^[A-Z]/.test(r)))))
            ) {
                t = r;
            } else t = 'ID';
        } else if (tok.kind === 'op') {
            t = NORMALIZE_OP[tok.text] || tok.text;
            r = t;
        } else {
            t = tok.text; // STR / NUM
            r = t;
        }
        tokens.push({ t, r, s: tok.s, e: tok.e, l: tok.l, w: tok.kind === 'id' });
    }
    return tokens;
};

module.exports = { tokenize, normalizeLanguage, lex };
