import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

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

// Point ColabIP service to test fixtures
vi.mock('../../../src/main/services/colabip', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { setColabipBasePath } = actual as { setColabipBasePath: (p: string) => void };
  setColabipBasePath(path.join(__dirname, '../../fixtures/colabip'));
  return actual;
});

import { registerColabipHandlers } from '../../../src/main/ipc/colabip';

describe('ColabIP IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should register colabip:listTaxonomies handler', () => {
    registerColabipHandlers();
    expect(handlers.has('colabip:listTaxonomies')).toBe(true);
  });

  // listRulePacks handler was removed in v2 — rule import happens via readRulePack() directly.

  it('should return taxonomy list wrapped in IPCResponse', async () => {
    registerColabipHandlers();

    const handler = handlers.get('colabip:listTaxonomies')!;
    const result = await handler({} /* fake event */);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'healthcare' }),
        expect.objectContaining({ name: 'general' }),
      ])
    );
  });
});
