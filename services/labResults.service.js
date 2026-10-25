/**
 * Lab result entry: turns what a technician typed into stored results with
 * reference ranges and flags, using the parameters defined on the lab's
 * catalogue test (see data/labTestLibrary.js for the shape).
 */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

/** "12 – 16" from low/high, or the expected text for qualitative ones. */
function rangeText(param = {}) {
  const low = num(param.low);
  const high = num(param.high);
  if (low !== null && high !== null) return low === 0 ? `Up to ${high}` : `${low} – ${high}`;
  if (low !== null) return `Above ${low}`;
  if (high !== null) return `Up to ${high}`;
  return String(param.text || '').trim();
}

/**
 * 'critical' | 'high' | 'low' | 'normal' for a numeric value against the
 * parameter's range; for qualitative ones, anything other than the expected
 * text is flagged 'high' (abnormal) unless no expected text is set.
 */
function flagFor(param = {}, rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return undefined;
  const v = num(value);
  const low = num(param.low);
  const high = num(param.high);
  if (v !== null && (low !== null || high !== null)) {
    const critLow = num(param.critLow);
    const critHigh = num(param.critHigh);
    if ((critLow !== null && v <= critLow) || (critHigh !== null && v >= critHigh)) return 'critical';
    if (low !== null && v < low) return 'low';
    if (high !== null && v > high) return 'high';
    return 'normal';
  }
  const expected = String(param.text || '').trim().toLowerCase();
  if (!expected) return 'normal';
  return value.toLowerCase() === expected ? 'normal' : 'high';
}

/**
 * Applies one test's entered values. [values] is [{ parameter, value, unit?,
 * normalRange?, notes? }]; units and ranges default from the catalogue so a
 * technician only types numbers. Returns the stored results array.
 */
function buildResults(catalogTest, values = []) {
  const params = new Map(
    (catalogTest?.parameters || []).map((p) => [String(p.name).trim().toLowerCase(), p]),
  );
  return (values || [])
    .filter((v) => v && String(v.parameter || '').trim())
    .map((v) => {
      const name = String(v.parameter).trim();
      const param = params.get(name.toLowerCase()) || {};
      const merged = {
        ...param,
        // A range typed for this one result wins over the catalogue's.
        ...(v.low !== undefined ? { low: v.low } : {}),
        ...(v.high !== undefined ? { high: v.high } : {}),
      };
      const value = String(v.value ?? '').trim();
      return {
        parameter: name,
        value,
        unit: String(v.unit ?? param.unit ?? '').trim(),
        normalRange: String(v.normalRange || rangeText(merged)).trim(),
        flag: flagFor(merged, value),
        notes: String(v.notes || '').trim() || undefined,
      };
    });
}

/** Counts across an order's tests, for list badges and the release check. */
function resultSummary(order) {
  let entered = 0;
  let abnormal = 0;
  let critical = 0;
  let testsWithResults = 0;
  const active = (order.tests || []).filter((t) => t.status !== 'cancelled');
  for (const t of active) {
    const rows = (t.results || []).filter((r) => String(r.value || '').trim());
    if (rows.length) testsWithResults += 1;
    entered += rows.length;
    abnormal += rows.filter((r) => r.flag && r.flag !== 'normal').length;
    critical += rows.filter((r) => r.flag === 'critical').length;
  }
  return { entered, abnormal, critical, testsWithResults, tests: active.length };
}

module.exports = { rangeText, flagFor, buildResults, resultSummary };
