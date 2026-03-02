/**
 * Format a spend amount with abbreviated suffix (K / M / B).
 * Examples: $1.23M, $45.67K, $892.00
 * Used consistently across Data Review, Review, Pivot, Output, and Suppliers pages.
 */
export const fmtAbbrev = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
