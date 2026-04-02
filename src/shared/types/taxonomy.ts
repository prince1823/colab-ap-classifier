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

