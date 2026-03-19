import { registerHandler } from './register';
import type { SupplierService, SupplierResearcher } from '../../shared/types/services';
import type { SupplierConfirmationStatus, SupplierUpdateInput } from '../../shared/types/suppliers';
import type { FilterCondition, GroupedFilter } from '../../shared/types/transactions';

export function registerSuppliersHandlers(
  suppliers: SupplierService,
  researcher: SupplierResearcher
): void {
  registerHandler('suppliers:list', async (_event, filter?: unknown) => {
    if (filter != null) {
      const f = filter as Record<string, unknown>;
      // Accept either flat conditions or grouped conditions
      if (!Array.isArray(f.conditions) && !f.groupedConditions) {
        throw new Error('suppliers:list filter must have conditions array or groupedConditions');
      }
    }
    return suppliers.listProjectSuppliers(filter as { conditions?: FilterCondition[]; groupedConditions?: GroupedFilter } | undefined);
  });

  registerHandler('suppliers:update', async (_event, supplierId: unknown, updates: unknown) => {
    await suppliers.updateSupplier(supplierId as string, updates as SupplierUpdateInput);
  });

  registerHandler('suppliers:confirm', async (_event, id: unknown, status: unknown) => {
    await suppliers.confirmSupplier(id as string, status as SupplierConfirmationStatus);
  });

  registerHandler('suppliers:filterTailSpend', async (_event, threshold: unknown) => {
    const ids = await suppliers.filterTailSpend(threshold as number);
    return { markedCount: ids.length };
  });

  registerHandler('suppliers:getFilterFields', async () => {
    return suppliers.getFilterFields();
  });

  registerHandler('suppliers:distinctValues', async (_event, field: unknown, limit: unknown) => {
    return suppliers.queryDistinctValues(field as string, (limit as number) ?? 200);
  });

  registerHandler('suppliers:getAliases', async (_event, supplierId: unknown) => {
    return suppliers.getProjectAliases(supplierId as string);
  });

  registerHandler('suppliers:assignAlias', async (_event, supplierId: unknown, rawName: unknown) => {
    await suppliers.assignAlias(supplierId as string, rawName as string);
  });

  registerHandler('suppliers:rename', async (_event, supplierId: unknown, newName: unknown) => {
    await suppliers.renameSupplier(supplierId as string, newName as string);
  });

  registerHandler('suppliers:merge', async (_event, survivorId: unknown, losingIds: unknown) => {
    await suppliers.mergeSuppliers(survivorId as string, losingIds as string[]);
  });

  registerHandler('suppliers:delete', async (_event, supplierId: unknown) => {
    await suppliers.deleteSupplier(supplierId as string);
  });


  registerHandler('suppliers:listParents', async () => {
    return suppliers.listParents();
  });

  registerHandler('suppliers:addParent', async (_event, name: unknown) => {
    return suppliers.addParent(name as string);
  });

  registerHandler('suppliers:changeParent', async (_event, supplierId: unknown, parentId: unknown) => {
    await suppliers.changeParent(supplierId as string, (parentId as string | null));
  });

  registerHandler('suppliers:removeParent', async (_event, supplierId: unknown) => {
    await suppliers.removeParent(supplierId as string);
  });

  registerHandler('suppliers:renameParent', async (_event, parentId: unknown, newName: unknown) => {
    await suppliers.renameParent(parentId as string, newName as string);
  });

  registerHandler('suppliers:deleteParent', async (_event, parentId: unknown) => {
    await suppliers.deleteParent(parentId as string);
  });
}
