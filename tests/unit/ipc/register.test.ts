import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture registered handlers so we can invoke them in tests
const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  BrowserWindow: vi.fn(),
}));

import { registerHandler, sendEvent, removeHandler } from '../../../src/main/ipc/register';

describe('registerHandler', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('should wrap a successful return value in IPCResponse', async () => {
    registerHandler('test:success', async () => 'hello');

    const handler = handlers.get('test:success')!;
    const result = await handler({} /* fake event */);

    expect(result).toEqual({ success: true, data: 'hello' });
  });

  it('should wrap sync handlers correctly', async () => {
    registerHandler('test:sync', () => 42);

    const handler = handlers.get('test:sync')!;
    const result = await handler({});

    expect(result).toEqual({ success: true, data: 42 });
  });

  it('should catch thrown Error and return error response', async () => {
    registerHandler('test:error', async () => {
      throw new Error('something broke');
    });

    const handler = handlers.get('test:error')!;
    const result = await handler({});

    expect(result).toEqual({ success: false, error: 'something broke' });
  });

  it('should catch non-Error throws and stringify them', async () => {
    registerHandler('test:string-error', async () => {
      throw 'raw string error';
    });

    const handler = handlers.get('test:string-error')!;
    const result = await handler({});

    expect(result).toEqual({ success: false, error: 'raw string error' });
  });

  it('should pass arguments through to the handler', async () => {
    const spy = vi.fn(async (_event: unknown, arg1: unknown, arg2: unknown) => ({ arg1, arg2 }));
    registerHandler('test:args', spy);

    const handler = handlers.get('test:args')!;
    const result = await handler({}, 'foo', 123);

    expect(spy).toHaveBeenCalledWith({}, 'foo', 123);
    expect(result).toEqual({ success: true, data: { arg1: 'foo', arg2: 123 } });
  });

  it('should log registration to console', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerHandler('test:logged', async () => null);

    expect(logSpy).toHaveBeenCalledWith('[IPC] Registering handler: test:logged');
    logSpy.mockRestore();
  });

  it('should log errors to console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerHandler('test:log-error', async () => {
      throw new Error('fail');
    });

    const handler = handlers.get('test:log-error')!;
    await handler({});

    expect(errorSpy).toHaveBeenCalledWith('[IPC] Error in test:log-error:', 'fail');
    errorSpy.mockRestore();
  });
});

describe('sendEvent', () => {
  it('should send to webContents when window is not destroyed', () => {
    const mockSend = vi.fn();
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: mockSend },
    } as any;

    sendEvent(mockWindow, 'test:event', 'payload1', 'payload2');

    expect(mockSend).toHaveBeenCalledWith('test:event', 'payload1', 'payload2');
  });

  it('should not send when window is destroyed', () => {
    const mockSend = vi.fn();
    const mockWindow = {
      isDestroyed: () => true,
      webContents: { send: mockSend },
    } as any;

    sendEvent(mockWindow, 'test:event', 'payload');

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('removeHandler', () => {
  it('should remove a previously registered handler', () => {
    registerHandler('test:remove', async () => 'value');
    expect(handlers.has('test:remove')).toBe(true);

    removeHandler('test:remove');
    expect(handlers.has('test:remove')).toBe(false);
  });
});
