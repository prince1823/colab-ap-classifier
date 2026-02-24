import { registerHandler } from './register';
import { researchSingle } from '../services/supplier-research';

export function registerSupplierResearchHandlers(): void {
  registerHandler('suppliers:research', async (_event, supplierName: unknown) => {
    return researchSingle(supplierName as string);
  });
}
