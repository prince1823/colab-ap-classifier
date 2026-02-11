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

describe('registerAllHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    // Suppress registration logs in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should register the test:ping handler', () => {
    registerAllHandlers();

    expect(handlers.has('test:ping')).toBe(true);
  });

  it('should return pong wrapped in IPCResponse for test:ping', async () => {
    registerAllHandlers();

    const handler = handlers.get('test:ping')!;
    const result = await handler({} /* fake event */);

    expect(result).toEqual({ success: true, data: 'pong' });
  });
});
