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

/** A single segment in the path from root to a pivot row */
export interface PathSegment {
  dimensionField: string
  value: string
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
  /** Full path from root to this row — used for filter/reclassify scope */
  pathSegments: PathSegment[]
  /** Key of the depth-0 ancestor (first dimension) — used for percentage base */
  depth0AncestorKey: string
  /** Which dimension column this row represents */
  dimensionField: string
}

export type Aggregation = 'sum' | 'count' | 'average'
export type SpendDisplayMode = 'absolute' | 'percentage' | 'both'
export type PivotFilterState = Record<string, string[]>
