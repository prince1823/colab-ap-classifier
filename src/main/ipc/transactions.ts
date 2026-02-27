import { registerHandler } from './register';
import * as transactionsService from '../services/transactions';
import type { TransactionFilter } from '../../shared/types';

export function registerTransactionsHandlers(): void {
  registerHandler('transactions:query', async (_event, filters: unknown) => {
    return transactionsService.queryTransactions(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:queryPaginated', async (_event, filters: unknown) => {
    return transactionsService.queryTransactionsPaginated(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:count', async (_event, filters: unknown) => {
    return transactionsService.getCount(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:stats', async () => {
    return transactionsService.getStats();
  });

  registerHandler('transactions:getColumns', async () => {
    return transactionsService.getColumns();
  });

  registerHandler('transactions:queryGrouped', async (_event, column: unknown, filters: unknown) => {
    return transactionsService.queryGroupedByColumn(
      column as string,
      filters as TransactionFilter | undefined
    );
  });

  registerHandler('transactions:distinctValues', async (_event, column: unknown, limit: unknown) => {
    return transactionsService.queryDistinctValues(
      column as string,
      limit as number | undefined
    );
  });

  registerHandler('transactions:getIdsByValue', async (_event, column: unknown, value: unknown, filters: unknown) => {
    return transactionsService.getTransactionIdsByColumnValue(
      column as string,
      value as string,
      filters as TransactionFilter | undefined
    );
  });
}
