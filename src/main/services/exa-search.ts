import Exa from 'exa-js';

/**
 * A single search result from Exa, trimmed to what we need.
 */
export interface ExaSearchResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
}

let exaClient: Exa | null = null;

/**
 * Return a configured Exa client, or null if no API key is set.
 */
function getClient(): Exa | null {
  if (exaClient) return exaClient;
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return null;
  exaClient = new Exa(apiKey);
  return exaClient;
}

/**
 * Check whether Exa search is available (API key configured).
 */
export function isAvailable(): boolean {
  return !!process.env.EXA_API_KEY;
}

/**
 * Search Exa for information about a supplier.
 *
 * @param supplierName - The supplier name to search for
 * @param supplierAddress - Optional address for more specific results
 * @param numResults - Number of results to request (default 5)
 * @returns Array of search results, or empty array if Exa is unavailable
 */
export async function searchSupplier(
  supplierName: string,
  supplierAddress?: string,
  numResults = 5
): Promise<ExaSearchResult[]> {
  const client = getClient();
  if (!client) return [];

  const query = supplierAddress
    ? `${supplierName} ${supplierAddress} company information`
    : `${supplierName} company information business`;

  const response = await client.search(query, {
    numResults,
    type: 'auto',
    contents: {
      text: { maxCharacters: 3000 },
    },
  });

  return response.results
    .filter((r) => r.text)
    .map((r) => ({
      title: r.title || 'Untitled',
      url: r.url,
      text: r.text as string,
      publishedDate: r.publishedDate,
    }));
}

/**
 * Reset the cached Exa client (useful for testing).
 */
export function resetClient(): void {
  exaClient = null;
}
