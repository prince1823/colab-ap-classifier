import Exa from 'exa-js';
import type { WebSearch } from '../../shared/types/services';

export interface ExaSearchResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
}

export class ExaWebSearch implements WebSearch {
  private client: Exa | null = null;

  private getClient(): Exa | null {
    if (this.client) return this.client;
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) return null;
    this.client = new Exa(apiKey);
    return this.client;
  }

  isAvailable(): boolean {
    return !!process.env.EXA_API_KEY;
  }

  async searchSupplier(
    supplierName: string,
    supplierAddress?: string,
    numResults = 5
  ): Promise<ExaSearchResult[]> {
    const client = this.getClient();
    if (!client) return [];

    const query = supplierAddress
      ? `${supplierName} ${supplierAddress} company information linkedin`
      : `${supplierName} company information business linkedin`;

    const response = await client.search(query, {
      numResults,
      type: 'auto',
      contents: { text: { maxCharacters: 3000 } },
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

  resetClient(): void {
    this.client = null;
  }
}

// Backward compatibility exports
const defaultInstance = new ExaWebSearch();
export function isAvailable(): boolean { return defaultInstance.isAvailable(); }
export async function searchSupplier(supplierName: string, supplierAddress?: string, numResults = 5): Promise<ExaSearchResult[]> {
  return defaultInstance.searchSupplier(supplierName, supplierAddress, numResults);
}
export function resetClient(): void { defaultInstance.resetClient(); }
