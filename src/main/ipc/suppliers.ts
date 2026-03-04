import { registerHandler } from './register';
import type { SupplierService, SupplierResearcher } from '../../shared/types/services';
import type { SupplierConfirmationStatus } from '../../shared/types/suppliers';

export function registerSuppliersHandlers(
  suppliers: SupplierService,
  researcher: SupplierResearcher
): void {
  registerHandler('suppliers:list', async () => {
    return suppliers.listProjectSuppliers();
  });

  registerHandler('suppliers:update', async (_event, supplierId: unknown, newName: unknown) => {
    await suppliers.renameSupplier(supplierId as string, newName as string);
  });

  registerHandler('suppliers:confirm', async (_event, id: unknown, status: unknown) => {
    await suppliers.confirmSupplier(id as string, status as SupplierConfirmationStatus);
  });
}
