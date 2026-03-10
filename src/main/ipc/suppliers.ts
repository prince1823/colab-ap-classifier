import { registerHandler } from './register';
import type { SupplierService, SupplierResearcher } from '../../shared/types/services';
import type { SupplierConfirmationStatus, SupplierUpdateInput } from '../../shared/types/suppliers';
import type { FilterCondition } from '../../shared/types/transactions';

export function registerSuppliersHandlers(
  suppliers: SupplierService,
  researcher: SupplierResearcher
): void {
  registerHandler('suppliers:list', async (_event, filter?: unknown) => {
    if (filter != null) {
      const f = filter as Record<string, unknown>;
      if (!Array.isArray(f.conditions)) {
        throw new Error('suppliers:list filter.conditions must be an array');
      }
    }
    return suppliers.listProjectSuppliers(filter as { conditions: FilterCondition[] } | undefined);
  });

  registerHandler('suppliers:update', async (_event, supplierName: unknown, updates: unknown) => {
    await suppliers.updateSupplier(supplierName as string, updates as SupplierUpdateInput);
  });

  registerHandler('suppliers:confirm', async (_event, id: unknown, status: unknown) => {
    await suppliers.confirmSupplier(id as string, status as SupplierConfirmationStatus);
  });

  registerHandler('suppliers:filterTailSpend', async (_event, threshold: unknown) => {
    const ids = await suppliers.filterTailSpend(threshold as number);
    return { markedCount: ids.length };
  });
}
