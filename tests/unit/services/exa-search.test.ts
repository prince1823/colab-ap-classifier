import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  searchSupplier,
  isAvailable,
  resetClient,
} from '../../../src/main/services/exa-search';

// Mock the exa-js module
vi.mock('exa-js', () => {
  const mockSearch = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      search: mockSearch,
    })),
    __mockSearch: mockSearch,
  };
});

// Access the mock search function
import Exa from 'exa-js';
const MockExa = vi.mocked(Exa);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSearch = (await import('exa-js') as any).__mockSearch as ReturnType<typeof vi.fn>;

const MOCK_SEARCH_RESPONSE = {
  results: [
    {
      title: 'Acme Corporation - Industrial Supplies',
      url: 'https://acme.example.com',
      text: 'Acme Corporation is a global provider of industrial supplies and equipment, serving manufacturing, construction, and mining industries.',
      publishedDate: '2024-06-15',
      id: 'result-1',
    },
    {
      title: 'Acme Corp | LinkedIn',
      url: 'https://linkedin.com/company/acme-corp',
      text: 'Acme Corporation is a B2B distributor headquartered in Springfield, IL. 500+ employees.',
      publishedDate: '2024-01-20',
      id: 'result-2',
    },
    {
      title: null,
      url: 'https://example.com/no-text',
      text: null,
      id: 'result-3',
    },
  ],
  requestId: 'req-123',
};

describe('exa-search', () => {
  const originalEnv = process.env.EXA_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    resetClient();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EXA_API_KEY = originalEnv;
    } else {
      delete process.env.EXA_API_KEY;
    }
  });

  describe('isAvailable', () => {
    it('should return true when EXA_API_KEY is set', () => {
      process.env.EXA_API_KEY = 'test-key';
      expect(isAvailable()).toBe(true);
    });

    it('should return false when EXA_API_KEY is not set', () => {
      delete process.env.EXA_API_KEY;
      expect(isAvailable()).toBe(false);
    });

    it('should return false when EXA_API_KEY is empty', () => {
      process.env.EXA_API_KEY = '';
      expect(isAvailable()).toBe(false);
    });
  });

  describe('searchSupplier', () => {
    it('should return empty array when EXA_API_KEY is not set', async () => {
      delete process.env.EXA_API_KEY;
      const results = await searchSupplier('Acme Corporation');
      expect(results).toEqual([]);
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('should call Exa search with supplier name', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValueOnce(MOCK_SEARCH_RESPONSE);

      await searchSupplier('Acme Corporation');

      expect(MockExa).toHaveBeenCalledWith('test-key');
      expect(mockSearch).toHaveBeenCalledWith(
        'Acme Corporation company information business',
        {
          numResults: 5,
          type: 'auto',
          contents: { text: { maxCharacters: 3000 } },
        }
      );
    });

    it('should include address in search query when provided', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValueOnce({ results: [], requestId: 'req-456' });

      await searchSupplier('Acme Corporation', '123 Main St, Springfield, IL');

      expect(mockSearch).toHaveBeenCalledWith(
        'Acme Corporation 123 Main St, Springfield, IL company information',
        expect.any(Object)
      );
    });

    it('should accept custom numResults', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValueOnce({ results: [], requestId: 'req-789' });

      await searchSupplier('Test Corp', undefined, 3);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ numResults: 3 })
      );
    });

    it('should filter out results without text', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValueOnce(MOCK_SEARCH_RESPONSE);

      const results = await searchSupplier('Acme Corporation');

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Acme Corporation - Industrial Supplies');
      expect(results[1].title).toBe('Acme Corp | LinkedIn');
    });

    it('should map results to ExaSearchResult shape', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValueOnce(MOCK_SEARCH_RESPONSE);

      const results = await searchSupplier('Acme Corporation');

      expect(results[0]).toEqual({
        title: 'Acme Corporation - Industrial Supplies',
        url: 'https://acme.example.com',
        text: 'Acme Corporation is a global provider of industrial supplies and equipment, serving manufacturing, construction, and mining industries.',
        publishedDate: '2024-06-15',
      });
    });

    it('should use "Untitled" for results with null title', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValueOnce({
        results: [
          { title: null, url: 'https://example.com', text: 'Some text', id: 'r1' },
        ],
        requestId: 'req-000',
      });

      const results = await searchSupplier('Test');
      expect(results[0].title).toBe('Untitled');
    });

    it('should reuse the client on subsequent calls', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockResolvedValue({ results: [], requestId: 'req-reuse' });

      await searchSupplier('First');
      await searchSupplier('Second');

      // Exa constructor should only be called once
      expect(MockExa).toHaveBeenCalledTimes(1);
    });

    it('should propagate Exa API errors', async () => {
      process.env.EXA_API_KEY = 'test-key';
      mockSearch.mockRejectedValueOnce(new Error('Exa API rate limit'));

      await expect(searchSupplier('Test')).rejects.toThrow('Exa API rate limit');
    });
  });

  describe('resetClient', () => {
    it('should allow creating a new client after reset', async () => {
      process.env.EXA_API_KEY = 'key-1';
      mockSearch.mockResolvedValue({ results: [], requestId: 'req-a' });

      await searchSupplier('First');
      expect(MockExa).toHaveBeenCalledTimes(1);

      resetClient();
      process.env.EXA_API_KEY = 'key-2';

      await searchSupplier('Second');
      expect(MockExa).toHaveBeenCalledTimes(2);
      expect(MockExa).toHaveBeenLastCalledWith('key-2');
    });
  });
});
