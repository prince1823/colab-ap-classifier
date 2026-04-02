import Exa from 'exa-js';
import type { WebSearch, IAppConfigService } from '../../shared/types/services';

export interface ExaSearchResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
}

export class ExaWebSearch implements WebSearch {
  private client: Exa | null = null;
  private configService: Pick<IAppConfigService, 'getExaApiKey'> | null;

  constructor(configService?: Pick<IAppConfigService, 'getExaApiKey'>) {
    this.configService = configService ?? null;
  }

  private getApiKey(): string | null {
    const key = this.configService?.getExaApiKey() ?? process.env.EXA_API_KEY ?? null;
    return key?.trim() || null;
  }

  private getClient(): Exa | null {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;
    // Always create a fresh client when using configService so key updates take effect immediately
    if (this.configService) return new Exa(apiKey);
    if (!this.client) this.client = new Exa(apiKey);
    return this.client;
  }

  isAvailable(): boolean {
    return this.getApiKey() !== null;
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
