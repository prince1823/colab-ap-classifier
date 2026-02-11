import { registerHandler } from './register';
import * as rulesService from '../services/rules';
import type { OverrideRuleCreate, OverrideRuleUpdate } from '../../shared/types';

export function registerRulesHandlers(): void {
  registerHandler('rules:list', async () => {
    return rulesService.listRules();
  });

  registerHandler('rules:create', async (_event, input: unknown) => {
    return rulesService.createRule(input as OverrideRuleCreate);
  });

  registerHandler('rules:update', async (_event, ruleId: unknown, updates: unknown) => {
    return rulesService.updateRule(ruleId as string, updates as OverrideRuleUpdate);
  });

  registerHandler('rules:delete', async (_event, ruleId: unknown) => {
    return rulesService.deleteRule(ruleId as string);
  });

  registerHandler('rules:importFromColabip', async (_event, rulePack: unknown) => {
    return rulesService.importFromColabip(rulePack as string);
  });
}
