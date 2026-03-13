/**
 * Strip description if ≥70% of characters are numeric.
 * Returns empty string if numeric-heavy.
 */
export function cleanDescription(desc: string): string {
  if (!desc) return '';
  const numericCount = (desc.match(/[0-9]/g) || []).length;
  const totalChars = desc.replace(/\s/g, '').length;
  if (totalChars > 0 && numericCount / totalChars >= 0.7) {
    return '';
  }
  return desc;
}
