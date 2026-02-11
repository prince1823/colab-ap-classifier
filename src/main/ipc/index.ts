import { registerHandler } from './register';

export function registerAllHandlers(): void {
  // Test channel — proves IPC is working end-to-end
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers will be registered here as services are built
}
