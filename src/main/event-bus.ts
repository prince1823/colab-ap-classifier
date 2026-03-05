import { EventEmitter } from 'events';
import type { EventBus } from '../shared/types/services';

class AppEventBus extends EventEmitter implements EventBus {
  emit(channel: string, ...args: unknown[]): boolean {
    return super.emit(channel, ...args);
  }
}

export const eventBus: EventBus = new AppEventBus();
