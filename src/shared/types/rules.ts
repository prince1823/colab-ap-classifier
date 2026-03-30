import type { GroupedFilter } from './transactions';

export type RuleSource = 'manual' | 'auto_generated' | 'supplier_universe';

export interface OverrideRule {
  id: string;
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  groupId: string | null;
  isActive: boolean;
  source: RuleSource;
  categoryASupplier: boolean;
  createdAt: string;
}

export interface OverrideRuleCreate {
  name: string;
  groupedConditions: GroupedFilter;
  targetTaxonomyNodeId: string;
  groupId?: string | null;
  source?: RuleSource;
  categoryASupplier?: boolean;
}

export interface OverrideRuleUpdate {
  name?: string;
  groupedConditions?: GroupedFilter;
  targetTaxonomyNodeId?: string;
  groupId?: string | null;
  isActive?: boolean;
  categoryASupplier?: boolean;
}

export interface GenerateRulesResult {
  rulesCreated: number;
  suppliersProcessed: number;
}

// ─── Rule Groups ─────────────────────────────────────────────────────────────

export interface RuleGroup {
  id: string;
  name: string;
  priority: number;       // >= 1; higher = evaluated first
  createdAt: string;
  ruleCount: number;
}

export interface RuleGroupCreate {
  name: string;
  priority: number;
}

export interface RuleGroupUpdate {
  name?: string;
  priority?: number;
}
