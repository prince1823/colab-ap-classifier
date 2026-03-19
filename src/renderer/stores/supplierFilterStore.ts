import { create } from 'zustand'
import type { GroupedFilter } from '../../shared/types/transactions'

interface SupplierFilterState {
  advancedGrouped: GroupedFilter | null
  setAdvancedGrouped: (grouped: GroupedFilter | null) => void
  reset: () => void
}

export const useSupplierFilterStore = create<SupplierFilterState>()((set) => ({
  advancedGrouped: null,
  setAdvancedGrouped: (grouped) => set({ advancedGrouped: grouped }),
  reset: () => set({ advancedGrouped: null }),
}))
