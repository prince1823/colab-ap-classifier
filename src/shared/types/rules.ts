import type { GroupedFilter } from './transactions';

export type RuleSource = 'manual' | 'auto_generated';

export interface OverrideRule {
  id: string;
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  priorityScore: number;
  bucketId: string;
  isActive: boolean;
  source: RuleSource;
  createdAt: string;
}

export interface OverrideRuleCreate {
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  priorityScore?: number;
  bucketId?: string;
  source?: RuleSource;
}

export interface OverrideRuleUpdate {
  name?: string;
  groupedConditions?: GroupedFilter;
  targetTaxonomyNodeId?: string;
  priorityScore?: number;
  bucketId?: string;
  isActive?: boolean;
}

export interface GenerateRulesResult {
  rulesCreated: number;
  suppliersProcessed: number;
}

// ─── Rule Buckets ────────────────────────────────────────────────────────────

export interface RuleBucket {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  groupedConditions: GroupedFilter | null;
  createdAt: string;
}

export interface RuleBucketCreate {
  name: string;
  sortOrder?: number;
  groupedConditions?: GroupedFilter;
}

export interface RuleBucketUpdate {
  name?: string;
  sortOrder?: number;
  groupedConditions?: GroupedFilter | null;
}
