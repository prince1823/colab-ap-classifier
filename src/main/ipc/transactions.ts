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

  registerHandler('transactions:queryGrouped', async (_event, column: unknown, filters: unknown) => {
    return (transactions as import('../services/transactions').TransactionStore).queryGroupedByColumn(
      column as string,
      filters as TransactionFilter | undefined
    );
  });

  registerHandler('transactions:distinctValues', async (_event, column: unknown, limit: unknown) => {
    return (transactions as import('../services/transactions').TransactionStore).queryDistinctValues(
      column as string,
      limit as number | undefined
    );
  });

  registerHandler('transactions:getIdsByValue', async (_event, column: unknown, value: unknown, filters: unknown) => {
    return (transactions as import('../services/transactions').TransactionStore).getTransactionIdsByColumnValue(
      column as string,
      value as string,
      filters as TransactionFilter | undefined
    );
  });

  registerHandler('transactions:pivotAggregation', async (_event, dimensions: unknown, valueDimension: unknown, filters: unknown) => {
    return (transactions as import('../services/transactions').TransactionStore).queryPivotAggregation(
      dimensions as string[],
      valueDimension as string,
      filters as TransactionFilter | undefined
    );
  });
}
