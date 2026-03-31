/**
 * Detects the date format used in a master_date column by sampling raw CSV values.
 * Returns a DuckDB strptime format string, or null if no recognizable format is found.
 *
 * Handles: ISO (YYYY-MM-DD), ISO slashes (YYYY/MM/DD), named month (15-Jan-2024,
 * Jan 15 2024), US slash (MM/DD/YYYY), EU slash (DD/MM/YYYY), and dash variants.
 *
 * For ambiguous dates where day and month are both ≤ 12, evidence from values with
 * a component > 12 disambiguates EU vs US. Defaults to US if fully ambiguous.
 */
export function detectMasterDateFormat(samples: string[]): string | null {
  const values = samples.map(v => v?.trim()).filter(Boolean);
  if (!values.length) return null;

  // Unambiguous: ISO YYYY-MM-DD
  if (values.some(v => /^\d{4}-\d{1,2}-\d{1,2}$/.test(v))) return '%Y-%m-%d';

  // Unambiguous: ISO YYYY/MM/DD
  if (values.some(v => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v))) return '%Y/%m/%d';

  // Unambiguous: named month DD-Mon-YYYY (e.g. 15-Jan-2024)
  if (values.some(v => /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(v))) return '%d-%b-%Y';

  // Unambiguous: named month Mon DD YYYY (e.g. Jan 15 2024 or Jan 15, 2024)
  if (values.some(v => /^[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}$/.test(v))) return '%b %d %Y';

  // Ambiguous slash/dash D?/M? or M?/D? — use evidence from values where a component > 12
  const sep = values
    .find(v => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(v))
    ?.match(/[\/\-]/)?.[0];
  if (!sep) return null;

  const re = new RegExp(`^(\\d{1,2})\\${sep}(\\d{1,2})\\${sep}(\\d{4})$`);
  let highFirst = 0;
  let highSecond = 0;
  let matched = 0;
  for (const v of values) {
    const m = v.match(re);
    if (!m) continue;
    matched++;
    if (parseInt(m[1], 10) > 12) highFirst++;
    if (parseInt(m[2], 10) > 12) highSecond++;
  }
  if (!matched) return null;

  const [eu, us] =
    sep === '/' ? ['%d/%m/%Y', '%m/%d/%Y'] : ['%d-%m-%Y', '%m-%d-%Y'];
  return highFirst > highSecond ? eu : us; // default US if tied or fully ambiguous
}
