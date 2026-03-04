import { registerHandler } from './register';
import type { TransactionStore } from '../../shared/types/services';
import type { TransactionFilter, TransactionUpdate } from '../../shared/types';

export function registerTransactionsHandlers(transactions: TransactionStore): void {
  registerHandler('transactions:query', async (_event, filters: unknown) => {
    return transactions.queryTransactionsPaginated(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:stats', async () => {
    return transactions.getStats();
  });

  registerHandler('transactions:getColumns', async () => {
    return transactions.getColumns();
  });

  registerHandler('transactions:update', async (_event, update: unknown) => {
    await transactions.updateTransactions(update as TransactionUpdate, 'manual');
  });
}
