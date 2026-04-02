import { registerHandler } from './register';
import type { RuleStore, SupplierService, TaxonomyStore } from '../../shared/types/services';
import type { OverrideRuleCreate, OverrideRuleUpdate, RuleGroupCreate, RuleGroupUpdate } from '../../shared/types';
import type { GroupedFilter } from '../../shared/types/transactions';

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

  registerHandler('rules:create', async (_event, input: unknown) => {
    return rules.createRule(input as OverrideRuleCreate);
  });

  registerHandler('rules:createAndApply', async (_event, input: unknown) => {
    return rules.createAndApplyRule(input as OverrideRuleCreate);
  });

  registerHandler('rules:update', async (_event, ruleId: unknown, updates: unknown) => {
    return rules.updateRule(ruleId as string, updates as OverrideRuleUpdate);
  });

  registerHandler('rules:delete', async (_event, ruleId: unknown) => {
    const id = ruleId as string;
    const rule = await rules.getRule(id);

    // Cascade cat A cleanup before deleting
    if (rule?.categoryASupplier) {
      const conditions = rule.groupedConditions.groups.flatMap((g) => g.conditions);
      const supplierCondition = conditions.find((c) => c.field === 'supplier_name' && c.operator === 'equals');

      if (supplierCondition) {
        const supplierName = String(supplierCondition.value);

        // Remove this rule's taxonomy path from project supplier's mappedTaxonomyPaths
        const allSuppliers = await suppliers.listProjectSuppliers();
        const projectSupplier = allSuppliers.find(
          (s) => s.supplierName.toLowerCase() === supplierName.toLowerCase()
        );
        if (projectSupplier) {
          const nodes = await taxonomy.getNodes();
          const node = nodes.find((n) => n.id === rule.targetTaxonomyNodeId);
          if (node) {
            const currentPaths: string[] = projectSupplier.mappedTaxonomyPaths ?? [];
            const updatedPaths = currentPaths.filter((p) => p !== node.fullPath);
            await suppliers.updateSupplier(projectSupplier.id, { mappedTaxonomyPaths: updatedPaths });
          }
        }

        // Delete the rule first, then check remaining cat A rules
        await rules.deleteRule(id);

        const remainingCatARule = await rules.getCatARuleForSupplier(supplierName);
        if (!remainingCatARule && projectSupplier) {
          // No cat A rules remain — clear project supplier flag
          await suppliers.updateSupplier(projectSupplier.id, { categoryASupplier: false });
        }

        return;
      }
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

  registerHandler('rules:apply', async (_event, ruleIds: unknown) => {
    return rules.applyRules(ruleIds as string[]);
  });

  /**
   * Toggle category_a_supplier on a rule (supplier-only rules only).
   * Updates the rule and project supplier; universe is updated via suppliers:syncToUniverse.
   */
  registerHandler('rules:setCategoryA', async (_event, ruleId: unknown, value: unknown) => {
    const id = ruleId as string;
    const categoryA = value as boolean;

    const rule = await rules.getRule(id);
    if (!rule) throw new Error(`Rule not found: ${id}`);

    // Extract supplier name from the single supplier_name condition
    const conditions = rule.groupedConditions.groups.flatMap((g) => g.conditions);
    const supplierCondition = conditions.find((c) => c.field === 'supplier_name' && c.operator === 'equals');
    if (!supplierCondition) throw new Error('rules:setCategoryA only applies to supplier-only rules');

    const supplierName = String(supplierCondition.value);

    // Enforce one cat A rule per supplier
    if (categoryA) {
      const existingCatARule = await rules.getCatARuleForSupplier(supplierName);
      if (existingCatARule && existingCatARule.id !== id) {
        throw new Error(`A Cat A rule already exists for "${supplierName}"`);
      }
    }

    // Update rule
    await rules.updateRule(id, { categoryASupplier: categoryA });

    // Find the project supplier and update its flag and mappedTaxonomyPaths
    const allSuppliers = await suppliers.listProjectSuppliers();
    const projectSupplier = allSuppliers.find(
      (s) => s.supplierName.toLowerCase() === supplierName.toLowerCase()
    );
    if (projectSupplier) {
      await suppliers.updateSupplier(projectSupplier.id, { categoryASupplier: categoryA });

      const nodes = await taxonomy.getNodes();
      const node = nodes.find((n) => n.id === rule.targetTaxonomyNodeId);
      if (node) {
        const currentPaths: string[] = projectSupplier.mappedTaxonomyPaths ?? [];
        let updatedPaths: string[];
        if (categoryA) {
          updatedPaths = currentPaths.includes(node.fullPath)
            ? currentPaths
            : [...currentPaths, node.fullPath];
        } else {
          updatedPaths = currentPaths.filter((p) => p !== node.fullPath);
        }
        await suppliers.updateSupplier(projectSupplier.id, { mappedTaxonomyPaths: updatedPaths });
      }
    }
  });
}
