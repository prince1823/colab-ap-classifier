import { shell } from 'electron';
import { registerHandler } from './register';

export function registerShellHandlers(): void {
  registerHandler('shell:openExternal', async (_event, ...args: unknown[]) => {
    const url = args[0] as string;
    await shell.openExternal(url);
  });
}
