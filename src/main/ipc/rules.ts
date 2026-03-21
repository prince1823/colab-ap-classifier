import { registerHandler } from './register';
import type { RuleStore } from '../../shared/types/services';
import type { OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types';

export function registerRulesHandlers(rules: RuleStore): void {
  registerHandler('rules:list', async () => {
    return rules.listRules();
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
}
