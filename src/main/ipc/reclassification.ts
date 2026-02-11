import { registerHandler } from './register';
import { reclassifyTransactions } from '../services/reclassification';

export function registerReclassificationHandlers(): void {
  registerHandler(
    'transactions:reclassify',
    async (
      _event,
      transactionIds: unknown,
      taxonomyNodeId: unknown,
      feedback: unknown
    ) => {
      return reclassifyTransactions(
        transactionIds as string[],
        taxonomyNodeId as string,
        feedback as string | undefined
      );
    }
  );
}
