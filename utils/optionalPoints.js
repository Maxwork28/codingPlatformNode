/** Empty / omitted points → null. Invalid values → undefined (caller should 400). */
const parseOptionalPoints = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
};

const resolvePoints = (value) => parseOptionalPoints(value) || 0;

module.exports = { parseOptionalPoints, resolvePoints };
