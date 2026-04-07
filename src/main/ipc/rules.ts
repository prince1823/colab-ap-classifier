import { registerHandler } from './register';
import type { RuleStore, SupplierService, TaxonomyStore } from '../../shared/types/services';
import type { OverrideRuleCreate, OverrideRuleUpdate, RuleGroupCreate, RuleGroupUpdate } from '../../shared/types';
import type { GroupedFilter } from '../../shared/types/transactions';
import { extractSupplierNameCondition } from '../services/rules';

/**
 * Shared Cat A state sync — replaces duplicated logic in delete and setCategoryA handlers.
 * Updates the project supplier's categoryASupplier flag and mappedTaxonomyPaths.
 */
async function syncCatAState(
  rule: { groupedConditions: GroupedFilter; targetTaxonomyNodeId: string; id: string },
  categoryA: boolean,
  rules: RuleStore,
  suppliers: SupplierService,
  taxonomy: TaxonomyStore,
): Promise<void> {
  const supplierName = extractSupplierNameCondition(rule as Parameters<typeof extractSupplierNameCondition>[0]);
  if (!supplierName) return;

  const projectSupplier = await suppliers.getProjectSupplierByName(supplierName);
  if (!projectSupplier) return;

  const nodes = await taxonomy.getNodes();
  const node = nodes.find((n) => n.id === rule.targetTaxonomyNodeId);
  if (node) {
    const currentPaths: string[] = projectSupplier.mappedTaxonomyPaths ?? [];
    const updatedPaths = categoryA
      ? (currentPaths.includes(node.fullPath) ? currentPaths : [...currentPaths, node.fullPath])
      : currentPaths.filter((p) => p !== node.fullPath);
    await suppliers.updateSupplier(projectSupplier.id, { mappedTaxonomyPaths: updatedPaths });
  }

  // Check remaining Cat A rules before clearing the supplier flag
  if (!categoryA) {
    const remainingCatA = await rules.getCatARuleForSupplier(supplierName);
    const effectiveCatA = remainingCatA !== null && remainingCatA.id !== rule.id;
    await suppliers.updateSupplier(projectSupplier.id, { categoryASupplier: effectiveCatA });
  } else {
    await suppliers.updateSupplier(projectSupplier.id, { categoryASupplier: true });
  }
}

export function registerRulesHandlers(
  rules: RuleStore,
  suppliers: SupplierService,
  taxonomy: TaxonomyStore,
): void {
  registerHandler('rules:list', async () => {
    return rules.listRules();
  });

  registerHandler('rules:listPaginated', async (_event, opts: unknown) => {
    return rules.listRulesPaginated(opts as { limit: number; offset: number; search?: string });
  });

  registerHandler('rules:listByGroup', async (_event, groupId: unknown, limit: unknown, offset: unknown) => {
    return rules.listRulesByGroup(groupId as string, limit as number, offset as number);
  });

  registerHandler('rules:create', async (_event, input: unknown) => {
    return rules.createRule(input as OverrideRuleCreate);
  });

  registerHandler('rules:createAndApply', async (_event, input: unknown) => {
    return rules.createAndApplyRule(input as OverrideRuleCreate);
  });

  registerHandler('rules:update', async (_event, ruleId: unknown, updates: unknown) => {
    return rules.updateRule(ruleId as string, updates as OverrideRuleUpdate);
  });

  // Delete: deactivate is preferred in the UI, but keep internal delete with Cat A cleanup
  registerHandler('rules:delete', async (_event, ruleId: unknown) => {
    const id = ruleId as string;
    const rule = await rules.getRule(id);

    if (rule?.categoryASupplier) {
      await syncCatAState(rule, false, rules, suppliers, taxonomy);
    }

    return rules.deleteRule(id);
  });

  registerHandler('rules:previewConflicts', async (_event, candidateIds: unknown, newRuleGroupId: unknown) => {
    return rules.previewRuleConflicts(candidateIds as string[], (newRuleGroupId as string | null | undefined) ?? null);
  });

  registerHandler('rules:generate', async () => {
    return rules.generate_rules_preview();
  });

  // Group operations
  registerHandler('rules:listGroups', async () => {
    return rules.listGroups();
  });

  registerHandler('rules:createGroup', async (_event, input: unknown) => {
    return rules.createGroup(input as RuleGroupCreate);
  });

  registerHandler('rules:updateGroup', async (_event, groupId: unknown, updates: unknown) => {
    return rules.updateGroup(groupId as string, updates as RuleGroupUpdate);
  });

  registerHandler('rules:deleteGroup', async (_event, groupId: unknown) => {
    return rules.deleteGroup(groupId as string);
  });

  registerHandler('rules:reorderGroups', async (_event, orderedIds: unknown) => {
    return rules.reorderGroups(orderedIds as string[]);
  });

  registerHandler('rules:moveRule', async (_event, ruleId: unknown, targetGroupId: unknown) => {
    return rules.moveRuleToGroup(ruleId as string, (targetGroupId as string | null) ?? null);
  });

  registerHandler('rules:assignToGroup', async (_event, ruleIds: unknown, groupId: unknown) => {
    return rules.assignToGroup(ruleIds as string[], (groupId as string | null) ?? null);
  });

  registerHandler('rules:filterAssign', async (_event, filter: unknown, targetGroupId: unknown) => {
    return rules.filterAndAssignToGroup(filter as GroupedFilter, (targetGroupId as string | null) ?? null);
  });

  registerHandler('rules:previewApply', async (_event, ruleIds: unknown) => {
    return rules.previewRules(ruleIds as string[]);
  });

  registerHandler('rules:apply', async (_event, ruleIds: unknown, token: unknown) => {
    return rules.applyRules(ruleIds as string[], (token as string | undefined) ?? undefined);
  });

  /**
   * Toggle category_a_supplier on a rule (supplier-only rules only).
   * Uses shared syncCatAState helper.
   */
  registerHandler('rules:setCategoryA', async (_event, ruleId: unknown, value: unknown) => {
    const id = ruleId as string;
    const categoryA = value as boolean;

    const rule = await rules.getRule(id);
    if (!rule) throw new Error(`Rule not found: ${id}`);

    const supplierName = extractSupplierNameCondition(rule);
    if (!supplierName) throw new Error('rules:setCategoryA only applies to supplier-only rules');

    // Enforce one cat A rule per supplier
    if (categoryA) {
      const existingCatARule = await rules.getCatARuleForSupplier(supplierName);
      if (existingCatARule && existingCatARule.id !== id) {
        throw new Error(`A Cat A rule already exists for "${supplierName}"`);
      }
    }

    // Update rule
    await rules.updateRule(id, { categoryASupplier: categoryA });

    // Sync supplier state
    await syncCatAState(rule, categoryA, rules, suppliers, taxonomy);
  });
}
