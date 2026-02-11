import { registerHandler } from './register';
import { registerColabipHandlers } from './colabip';
import { registerProjectHandlers } from './project';
import { registerSettingsHandlers } from './settings';
import { registerChangelogHandlers } from './changelog';
import { registerTaxonomyHandlers } from './taxonomy';

export function registerAllHandlers(): void {
  // Test channel — proves IPC is working end-to-end
  registerHandler('test:ping', async () => 'pong');

  // Namespace handlers
  registerColabipHandlers();
  registerProjectHandlers();
  registerSettingsHandlers();
  registerChangelogHandlers();
  registerTaxonomyHandlers();
}
