import { registerHandler } from './register';
import * as feedbackService from '../services/feedback';
import type { FeedbackActionDetails } from '../../shared/types';

export function registerFeedbackHandlers(): void {
  registerHandler('feedback:list', async () => {
    return feedbackService.listFeedback();
  });

  registerHandler(
    'feedback:approve',
    async (_event, feedbackId: unknown, modifications: unknown) => {
      return feedbackService.approveFeedback(
        feedbackId as string,
        modifications as Partial<FeedbackActionDetails> | undefined
      );
    }
  );

  registerHandler(
    'feedback:reject',
    async (_event, feedbackId: unknown, reason: unknown) => {
      return feedbackService.rejectFeedback(
        feedbackId as string,
        reason as string | undefined
      );
    }
  );
}
