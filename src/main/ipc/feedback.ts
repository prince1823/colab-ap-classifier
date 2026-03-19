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
        const oldDescs: Record<string, string | null> = {};
        const newDescs: Record<string, string> = {};
        for (const update of details.updates) {
          oldDescs[update.nodePath] = update.currentDescription;
          newDescs[update.nodePath] = update.proposedDescription;
          await taxonomy.updateNode(update.nodeId, { description: update.proposedDescription });
        }
        const pathSummary = details.updates.length === 1
          ? details.updates[0].nodePath.replace(/\|/g, ' > ')
          : `${details.updates.length} nodes`;
        await changelog.logChange({
          source: 'feedback',
          affectedTable: 'taxonomy',
          affectedIds: details.updates.map(u => u.nodeId),
          affectedCount: details.updates.length,
          oldValues: { descriptions: oldDescs },
          newValues: { descriptions: newDescs },
          description: `Feedback: Updated taxonomy description for ${pathSummary}`,
        });
        break;
      }

      case 'update_supplier_info': {
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
        await changelog.logChange({
          source: 'feedback',
          affectedTable: 'project_suppliers',
          affectedIds: [details.supplierName],
          affectedCount: 1,
          oldValues: { [details.field]: details.currentValue },
          newValues: { [details.field]: details.proposedValue },
          description: `Feedback: Updated ${details.field} for ${details.supplierName}`,
        });
        break;
      }

      case 'update_company_context': {
        const currentContext = (await project.getSetting('company_context') as CompanyContext | null) || {};
        const updatedContext: CompanyContext = {
          ...currentContext,
          [details.field]: details.proposedValue,
        };
        await project.setSetting('company_context', updatedContext);
        await changelog.logChange({
          source: 'feedback',
          affectedTable: 'project_settings',
          affectedIds: ['company_context'],
          affectedCount: 1,
          oldValues: { [details.field]: details.currentValue },
          newValues: { [details.field]: details.proposedValue },
          description: `Feedback: Updated company context (${details.field})`,
        });
        break;
      }

      case 'update_column_priority': {
        await project.setSetting('column_priorities', details.proposedPriorities);
        await changelog.logChange({
          source: 'feedback',
          affectedTable: 'project_settings',
          affectedIds: ['column_priorities'],
          affectedCount: 1,
          oldValues: { priorities: details.currentPriorities },
          newValues: { priorities: details.proposedPriorities },
          description: `Feedback: Updated column priorities`,
        });
        break;
      }

      case 'create_rule': {
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
        await changelog.logChange({
          source: 'feedback',
          affectedTable: 'override_rules',
          affectedIds: [details.name],
          affectedCount: 1,
          oldValues: null,
          newValues: { name: details.name, conditions: details.conditions, targetPath: details.targetTaxonomyPath },
          description: `Feedback: Created rule "${details.name}"`,
        });
        break;
      }

      case 'no_change':
        // No-op — nothing to log
        break;

      default:
        throw new Error(`Unknown feedback action type: ${(details as { type: string }).type}`);
    }
  });
}
