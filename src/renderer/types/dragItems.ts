// Shared drag item type for react-dnd drag payloads between MultiTableSystem and ClassificationTree
export interface DragItem {
  type: string
  column: string
  value: string
  selectedValues: string[]
  transactionRows: Record<string, unknown>[]  // kept for compat; IDs extracted server-side
  serverSide: boolean
  isSelected: boolean
  isMultiSelect: boolean
}
