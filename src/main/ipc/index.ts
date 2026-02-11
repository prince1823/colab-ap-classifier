import { registerHandler } from './register';
import { registerColabipHandlers } from './colabip';

export function registerAllHandlers(): void {
  // Test channel — proves IPC is working end-to-end
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers
  registerColabipHandlers();
}
