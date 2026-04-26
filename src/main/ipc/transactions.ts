import { registerHandler } from './register';
import type { TransactionStore } from '../../shared/types/services';
import type { TransactionFilter, TransactionUpdate, GroupedFilter } from '../../shared/types';

export function registerTransactionsHandlers(transactions: TransactionStore): void {
  registerHandler('transactions:query', async (_event, filters: unknown) => {
    return transactions.queryTransactionsPaginated(filters as TransactionFilter | undefined);
  });

  registerHandler('transactions:stats', async () => {
    return transactions.getStats();
  });

  registerHandler('transactions:getColumns', async () => {
    return transactions.getColumnsForPivot();
  });

  registerHandler('transactions:update', async (_event, update: unknown) => {
    return transactions.updateTransactions(update as TransactionUpdate, 'manual');
  });

  registerHandler('transactions:queryGrouped', async (_event, column: unknown, filters: unknown) => {
    return transactions.queryGroupedByColumn(
      column as string,
      filters as TransactionFilter | undefined
    );
  });

  registerHandler('transactions:distinctValues', async (_event, column: unknown, limit: unknown) => {
    return transactions.queryDistinctValues(
      column as string,
      limit as number | undefined
    );
  });

  registerHandler('transactions:countDistinct', async (_event, column: unknown) => {
    return transactions.countDistinctValues(column as string);
  });

  registerHandler('transactions:getIdsByValue', async (_event, column: unknown, value: unknown, filters: unknown) => {
    return transactions.getTransactionIdsByColumnValue(
      column as string,
      value as string,
      filters as TransactionFilter | undefined
    );
  });

  registerHandler('transactions:pivotAggregation', async (_event, dimensions: unknown, valueDimension: unknown, filters: unknown) => {
    return transactions.queryPivotAggregation(
      dimensions as string[],
      valueDimension as string,
      filters as TransactionFilter | undefined
    );
  });

  registerHandler('transactions:getIdsByGroupedConditions', async (_event, grouped: unknown) => {
    return transactions.getIdsByGroupedConditions(grouped as GroupedFilter);
  });

  registerHandler('transactions:getFilterFields', async () => {
    return transactions.getFilterFields();
  });

  registerHandler('transactions:markAllReviewed', async () => {
    return transactions.markAllReviewed();
  });
}
