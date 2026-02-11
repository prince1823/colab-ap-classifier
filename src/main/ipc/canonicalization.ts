import { registerHandler } from './register';
import {
  suggestMappings,
  saveMappings,
  importCSV,
} from '../services/canonicalization';
import type { CanonicalColumnMapping } from '../../shared/types/canonicalization';

export function registerCanonicalizationHandlers(): void {
  registerHandler(
    'canonicalization:suggest',
    async (
      _event,
      columns: unknown,
      sampleData: unknown
    ) => {
      return suggestMappings(
        columns as string[],
        sampleData as Record<string, string>[]
      );
    }
  );

  registerHandler(
    'canonicalization:save',
    async (
      _event,
      mapping: unknown,
      groupingColumns: unknown
    ) => {
      await saveMappings(
        mapping as CanonicalColumnMapping,
        groupingColumns as string[]
      );
    }
  );

  registerHandler(
    'upload:csv',
    async (_event, filePath: unknown) => {
      return importCSV(filePath as string);
    }
  );
}
