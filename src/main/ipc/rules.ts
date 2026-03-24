import { registerHandler } from './register';
import type { RuleStore } from '../../shared/types/services';
import type { OverrideRuleCreate, OverrideRuleUpdate, RuleBucketCreate, RuleBucketUpdate } from '../../shared/types';

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

  // Bucket operations
  registerHandler('rules:listBuckets', async () => {
    return rules.listBuckets();
  });

  registerHandler('rules:createBucket', async (_event, input: unknown) => {
    return rules.createBucket(input as RuleBucketCreate);
  });

  registerHandler('rules:updateBucket', async (_event, bucketId: unknown, updates: unknown) => {
    return rules.updateBucket(bucketId as string, updates as RuleBucketUpdate);
  });

  registerHandler('rules:deleteBucket', async (_event, bucketId: unknown) => {
    return rules.deleteBucket(bucketId as string);
  });

  registerHandler('rules:reorderBuckets', async (_event, orderedIds: unknown) => {
    return rules.reorderBuckets(orderedIds as string[]);
  });

  registerHandler('rules:moveRule', async (_event, ruleId: unknown, targetBucketId: unknown, position: unknown) => {
    return rules.moveRuleToBucket(ruleId as string, targetBucketId as string, position as number | undefined);
  });

  registerHandler('rules:reorderInBucket', async (_event, bucketId: unknown, orderedRuleIds: unknown) => {
    return rules.reorderRulesInBucket(bucketId as string, orderedRuleIds as string[]);
  });
}
