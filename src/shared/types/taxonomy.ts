export interface TaxonomyNode {
  id: string;
  fullPath: string;
  l1: string;
  l2: string | null;
  l3: string | null;
  depth: number;
  description: string | null;
  parentPath: string | null;
  createdAt: string;
}

export interface TaxonomyMetadata {
  name: string;
  nodeCount: number;
}

export interface TaxonomySetInput {
  name: string;
  nodes: Array<{
    path: string;
    description?: string;
  }>;
}

export interface TaxonomyInfo {
  name: string;
  nodeCount: number;
}

export interface RulePackInfo {
  name: string;
  ruleCount: number;
}
