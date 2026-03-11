import { dialog } from 'electron';
import { registerHandler } from './register';
import type { SupplierUniverse } from '../../shared/types/services';

export function registerSupplierUniverseHandlers(supplierUniverse: SupplierUniverse): void {
  registerHandler('supplier-universe:getPath', async () => {
    return supplierUniverse.getConfiguredPath();
  });

  registerHandler('supplier-universe:selectFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Supplier Universe Database',
      filters: [{ name: 'DuckDB Database', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const p = result.filePaths[0];
    await supplierUniverse.configure(p);
    return p;
  });

  registerHandler('supplier-universe:createNew', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Create Supplier Universe Database',
      defaultPath: 'supplier_universe.db',
      filters: [{ name: 'DuckDB Database', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const p = result.filePath;
    await supplierUniverse.configure(p);
    return p;
  });
}
