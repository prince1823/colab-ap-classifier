import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture registered handlers
const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

import { registerAllHandlers } from '../../../src/main/ipc';
import type { ServiceContainer } from '../../../src/main/container';
import {
  createMockDatabase,
  createMockSupplierUniverse,
  createMockEventBus,
  createMockLLMClient,
  createMockWebSearch,
  createMockClassificationAgent,
  createMockResearchAgent,
  createMockColumnMappingAgent,
  createMockChangelogStore,
  createMockTransactionStore,
  createMockProjectStore,
  createMockTaxonomyStore,
  createMockSupplierService,
  createMockRuleStore,
  createMockIngestService,
  createMockExportService,
  createMockSupplierResearcher,
  createMockClassificationRunner,
} from '../../helpers/mock-services';

function createMockContainer(): ServiceContainer {
  return {
    db: createMockDatabase(),
    supplierUniverse: createMockSupplierUniverse(),
    eventBus: createMockEventBus(),
    llm: createMockLLMClient(),
    webSearch: createMockWebSearch(),
    classificationAgent: createMockClassificationAgent(),
    researchAgent: createMockResearchAgent(),
    columnMappingAgent: createMockColumnMappingAgent(),
    changelog: createMockChangelogStore(),
    transactions: createMockTransactionStore(),
    project: createMockProjectStore(),
    taxonomy: createMockTaxonomyStore(),
    suppliers: createMockSupplierService(),
    rules: createMockRuleStore(),
    ingest: createMockIngestService(),
    export: createMockExportService(),
    researcher: createMockSupplierResearcher(),
    classifier: createMockClassificationRunner(),
  };
}

describe('registerAllHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    // Suppress registration logs in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should register the test:ping handler', () => {
    registerAllHandlers(createMockContainer());

    expect(handlers.has('test:ping')).toBe(true);
  });

  it('should return pong wrapped in IPCResponse for test:ping', async () => {
    registerAllHandlers(createMockContainer());

    const handler = handlers.get('test:ping')!;
    const result = await handler({} /* fake event */);

    expect(result).toEqual({ success: true, data: 'pong' });
  });

  it('should register all namespace handlers', () => {
    registerAllHandlers(createMockContainer());

    // Spot-check a few key channels
    const expectedChannels = [
      'test:ping',
    ];

    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }

    // Should have registered many handlers
    expect(handlers.size).toBeGreaterThan(5);
  });
});
