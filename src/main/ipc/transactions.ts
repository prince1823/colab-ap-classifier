import { registerHandler } from './register';
import * as transactionsService from '../services/transactions';
import type { TransactionFilter, TransactionUpdate } from '../../shared/types';

export function registerTransactionsHandlers(): void {
  registerHandler('transactions:query', async (_event, filters: unknown) => {
    return transactionsService.queryTransactionsPaginated(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:stats', async () => {
    return transactionsService.getStats();
  });

  registerHandler('transactions:getColumns', async () => {
    return transactionsService.getColumns();
  });

  registerHandler('transactions:update', async (_event, update: unknown) => {
    await transactionsService.updateTransactions(update as TransactionUpdate, 'manual');
  });
}
