import { registerHandler } from './register';
import * as transactionsService from '../services/transactions';
import type { TransactionFilter } from '../../shared/types';

export function registerTransactionsHandlers(): void {
  registerHandler('transactions:query', async (_event, filters: unknown) => {
    return transactionsService.queryTransactions(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:stats', async () => {
    return transactionsService.getStats();
  });

  registerHandler('transactions:getColumns', async () => {
    return transactionsService.getColumns();
  });
}
