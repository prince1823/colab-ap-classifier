import { registerHandler } from './register';
import { listSuppliers, updateSupplier } from '../services/suppliers';
import type { SupplierUpdateInput } from '../../shared/types/suppliers';

export function registerSuppliersHandlers(): void {
  registerHandler('suppliers:list', async () => {
    return listSuppliers();
  });

  registerHandler('suppliers:update', async (_event, supplierName: unknown, updates: unknown) => {
    await updateSupplier(supplierName as string, updates as SupplierUpdateInput);
  });
}
