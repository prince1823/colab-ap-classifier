import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface ReviewTableConfig {
  id: string
  title: string
  column: string
  isHierarchical: boolean
  collapsed: boolean
}

export interface ReviewFilterState {
  activeFilters: Record<string, string[]>
  filterState: Record<string, string[]>
  filterGroupOperators: Record<string, string>
  filterConnectors: Record<string, 'AND' | 'OR'>
  filterCombinator: 'AND' | 'OR'
  showFilterPanel: boolean
  tables: ReviewTableConfig[]
  selectedRows: string[]
  tableLocalFilters: Record<string, Record<string, string[]>>
}

export const defaultReviewFilters: ReviewFilterState = {
  activeFilters: {},
  filterState: {
    supplier: [],
    classificationL1: [],
    classificationL2: [],
    classificationL3: [],
    classificationL4: [],
    glDescription: [],
    company: [],
    year: [],
    quarter: [],
    month: [],
    costCenter: [],
    country: [],
    lineDescription: [],
  },
  filterGroupOperators: {},
  filterConnectors: {},
  filterCombinator: 'AND',
  showFilterPanel: false,
  tables: [
    { id: 'vendor', title: 'supplier_name', column: 'supplier_name', isHierarchical: false, collapsed: false },
    { id: 'commodity', title: 'line_description', column: 'line_description', isHierarchical: false, collapsed: false },
    { id: 'gl', title: 'gl_description', column: 'gl_description', isHierarchical: false, collapsed: false },
  ],
  selectedRows: [],
  tableLocalFilters: {},
}

interface ReviewFilterContextValue {
  filters: ReviewFilterState
  setFilters: (partial: Partial<ReviewFilterState> | ((prev: ReviewFilterState) => Partial<ReviewFilterState>)) => void
  clearFilters: () => void
}

const ReviewFilterContext = createContext<ReviewFilterContextValue | null>(null)

export function ReviewFilterProvider({ children }: { children: ReactNode }) {
  const [filters, setState] = useState<ReviewFilterState>(defaultReviewFilters)

  const setFilters = useCallback((
    partial: Partial<ReviewFilterState> | ((prev: ReviewFilterState) => Partial<ReviewFilterState>)
  ) => {
    setState(prev => {
      const updates = typeof partial === 'function' ? partial(prev) : partial
      return { ...prev, ...updates }
    })
  }, [])

  const clearFilters = useCallback(() => {
    setState(defaultReviewFilters)
  }, [])

  return (
    <ReviewFilterContext.Provider value={{ filters, setFilters, clearFilters }}>
      {children}
    </ReviewFilterContext.Provider>
  )
}

export function useReviewFilterContext() {
  const ctx = useContext(ReviewFilterContext)
  if (!ctx) throw new Error('useReviewFilterContext must be used within ReviewFilterProvider')
  return ctx
}
