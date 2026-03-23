// Legal entity suffixes to strip during normalization.
// Sorted longest-first so more specific forms match before shorter subsets
// (e.g. "pvt ltd" matches before "ltd" or "pvt").
const SUFFIXES = [
  'private limited',
  'pvt. ltd.',
  'pvt. ltd',
  'pvt ltd.',
  'pvt ltd',
  'pte. ltd.',
  'pte. ltd',
  'pte ltd.',
  'pte ltd',
  'pty. ltd.',
  'pty. ltd',
  'pty ltd.',
  'pty ltd',
  'sdn. bhd.',
  'sdn bhd.',
  'sdn bhd',
  'incorporated',
  'corporation',
  'g.m.b.h',
  'l.l.c.',
  'l.l.c',
  'l.l.p.',
  'l.l.p',
  'p.l.c.',
  'p.l.c',
  's.a.r.l',
  'p. ltd.',
  'p. ltd',
  'p.ltd.',
  'p.ltd',
  'p ltd.',
  'p ltd',
  'limited',
  'corp.',
  'corp',
  'llp',
  'ltd.',
  'ltd',
  'llc',
  'inc.',
  'inc',
  'plc',
  'l.p.',
  'l.p',
  'lp',
  'sarl',
  's.a.s',
  'sas',
  's.p.a',
  'spa',
  's.r.l',
  'srl',
  'gmbh',
  'bhd',
  'pvt',
  'a.g.',
  'a.g',
  'ag',
].sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cleans a raw supplier name for normalization:
 * - Collapses internal whitespace
 * - Strips legal entity suffixes (case-insensitive)
 * - Applies a <5 character guard — if stripping the suffix would leave fewer
 *   than 5 characters, the suffix is kept
 *
 * The returned name preserves the original casing of the meaningful part.
 */
export function cleanSupplierName(raw: string): string {
  let name = raw.trim().replace(/\s+/g, ' ');

  for (const suffix of SUFFIXES) {
    const pattern = new RegExp(`[,\\s]+${escapeRegex(suffix)}\\s*$`, 'i');
    const cleaned = name.replace(pattern, '').trim();
    if (cleaned !== name && cleaned.length >= 5) {
      name = cleaned;
      break;
    }
  }

  return name;
}
