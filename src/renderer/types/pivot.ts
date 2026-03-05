/** One node in the hierarchical row tree (renderer-side representation) */
export interface PivotTreeNode {
  key: string
  label: string
  depth: number
  dimensionField: string
  total: number
  children: PivotTreeNode[]
  isLeaf: boolean
  transactionCount: number
}

/** Full hierarchical pivot result */
export interface HierarchicalPivotData {
  root: PivotTreeNode
  grandTotal: number
  rowDimensions: string[]
}

/** Flattened row ready for table rendering */
export interface FlattenedPivotRow {
  key: string
  label: string
  depth: number
  hasChildren: boolean
  isExpanded: boolean
  isLeaf: boolean
  total: number
  transactionCount: number
  isFirstInL1Group: boolean
  isFirstInL2Group: boolean
}

export type Aggregation = 'sum' | 'count' | 'average'
