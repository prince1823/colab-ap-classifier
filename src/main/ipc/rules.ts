import { registerHandler } from './register';
import type { RuleStore } from '../../shared/types/services';
import type { OverrideRuleCreate, OverrideRuleUpdate, RuleGroupCreate, RuleGroupUpdate } from '../../shared/types';
import type { GroupedFilter } from '../../shared/types/transactions';

export function registerRulesHandlers(rules: RuleStore): void {
  registerHandler('rules:list', async () => {
    return rules.listRules();
  });

  registerHandler('rules:listPaginated', async (_event, opts: unknown) => {
    return rules.listRulesPaginated(opts as { limit: number; offset: number; search?: string });
  });

  registerHandler('rules:create', async (_event, input: unknown) => {
    return rules.createRule(input as OverrideRuleCreate);
  });

  registerHandler('rules:update', async (_event, ruleId: unknown, updates: unknown) => {
    return rules.updateRule(ruleId as string, updates as OverrideRuleUpdate);
  });

  registerHandler('rules:delete', async (_event, ruleId: unknown) => {
    return rules.deleteRule(ruleId as string);
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
}
