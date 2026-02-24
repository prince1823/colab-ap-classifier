import { registerHandler } from './register';
import {
  saveMappings,
  importCSV,
} from '../services/canonicalization';
import type { CanonicalColumnMapping } from '../../shared/types/canonicalization';

export function registerCanonicalizationHandlers(): void {
  // NOTE: canonicalization:suggest was removed — LLM mapping suggestions
  // are now returned automatically as part of upload:parsePreview (LLM-first flow).

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
