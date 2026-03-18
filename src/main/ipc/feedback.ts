import { registerHandler } from './register';
import type {
  FeedbackAgent,
  ChangelogStore,
  TaxonomyStore,
  ProjectStore,
  SupplierService,
  RuleStore,
} from '../../shared/types/services';
import type { FeedbackAnalyzeInput, FeedbackApplyInput, FeedbackRecommendation } from '../../shared/types/feedback';
import type { CompanyContext } from '../../shared/types/project';
import type { SupplierInfo } from '../../shared/types/suppliers';

export function registerFeedbackHandlers(
  feedbackAgent: FeedbackAgent,
  changelog: ChangelogStore,
  taxonomy: TaxonomyStore,
  project: ProjectStore,
  suppliers: SupplierService,
  rules: RuleStore,
): void {

  registerHandler('feedback:analyze', async (_event, rawInput: unknown): Promise<FeedbackRecommendation> => {
    const input = rawInput as FeedbackAnalyzeInput;

    // 1. Fetch changelog entries and filter to selected IDs
    const allChanges = await changelog.listChanges();
    const selectedSet = new Set(input.changelogIds);
    const selectedChanges = allChanges.filter(c => selectedSet.has(c.id));

    if (selectedChanges.length === 0) {
      throw new Error('No matching changelog entries found for the selected IDs');
    }

    // 2. Fetch current system state
    const [nodes, companyContext, columnPriorities] = await Promise.all([
      taxonomy.getNodes(),
      project.getSetting('company_context') as Promise<CompanyContext | null>,
      project.getSetting('column_priorities') as Promise<string[] | null>,
    ]);

    // 3. Call the feedback agent
    return feedbackAgent.analyze({
      changelogs: selectedChanges,
      userFeedback: input.userFeedback,
      taxonomy: nodes,
      companyContext: companyContext || null,
      columnPriorities: columnPriorities || [],
    });
  });

  registerHandler('feedback:apply', async (_event, rawInput: unknown): Promise<void> => {
    const input = rawInput as FeedbackApplyInput;
    const { details } = input.recommendation;

    switch (details.type) {
      case 'update_taxonomy_description': {
        for (const update of details.updates) {
          await taxonomy.updateNode(update.nodeId, { description: update.proposedDescription });
        }
        break;
      }

      case 'update_supplier_info': {
        // Fetch current supplier info, merge the changed field, write back
        const supplierList = await suppliers.listProjectSuppliers({
          conditions: [{ field: 'supplier_name', operator: 'equals', value: details.supplierName }],
        });
        const existing = supplierList[0];
        const currentInfo: SupplierInfo = existing?.supplierInfo || {};
        const mergedInfo: SupplierInfo = {
          ...currentInfo,
          [details.field]: details.proposedValue,
        };
        await suppliers.updateSupplier(details.supplierName, { supplierInfo: mergedInfo });
        break;
      }

      case 'update_company_context': {
        const currentContext = (await project.getSetting('company_context') as CompanyContext | null) || {};
        const updatedContext: CompanyContext = {
          ...currentContext,
          [details.field]: details.proposedValue,
        };
        await project.setSetting('company_context', updatedContext);
        break;
      }

      case 'update_column_priority': {
        await project.setSetting('column_priorities', details.proposedPriorities);
        break;
      }

      case 'create_rule': {
        // Resolve taxonomy path to node ID
        const nodes = await taxonomy.getNodes();
        const targetNode = nodes.find(n => n.fullPath === details.targetTaxonomyPath);
        if (!targetNode) {
          throw new Error(`Taxonomy path not found: ${details.targetTaxonomyPath}`);
        }
        await rules.createRule({
          name: details.name,
          conditions: details.conditions,
          targetTaxonomyNodeId: targetNode.id,
        });
        break;
      }

      case 'no_change':
        // No-op
        break;

      default:
        throw new Error(`Unknown feedback action type: ${(details as { type: string }).type}`);
    }
  });
}
