import { useState, useCallback, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import type { ProjectSupplierView, SupplierParent } from '../../shared/types/suppliers'
import { suppliersToCSV } from '../lib/csv-normalize'
import type { AliasData } from '../lib/csv-normalize'

export type { AliasData }

interface UseNormalizeDataOptions {
  onDataChange?: () => void
}

export interface NormalizeDataSource {
  suppliers: ProjectSupplierView[]
  parents: SupplierParent[]
  aliasCache: Map<string, AliasData[]>
  loading: boolean
  error: string | null
  setError: (e: string | null) => void

  rename(supplierId: string, newName: string): Promise<void>
  deleteSupplier(supplierId: string): Promise<void>
  deleteAlias(alias: AliasData, normalizedId: string): void
  changeParent(supplierId: string, parentId: string | null): Promise<void>
  renameParent(parentId: string, newName: string): Promise<void>
  deleteParent(parentId: string): Promise<void>
  createParentAndAssign(supplierId: string, name: string): Promise<void>
  mergeSuppliers(survivorId: string, losingIds: string[]): Promise<void>
  mergeParents(survivorId: string, losingIds: string[]): Promise<void>
  reassignAlias(aliasName: string, fromId: string, toId: string): Promise<void>

  refresh(): Promise<void>
  exportCsv(): Promise<void>
}

export function useNormalizeData({ onDataChange }: UseNormalizeDataOptions = {}): NormalizeDataSource {
  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [parents, setParents] = useState<SupplierParent[]>([])
  const [aliasCache, setAliasCache] = useState<Map<string, AliasData[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── Data loading ────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setError(null)
    try {
      const [supplierData, parentData] = await Promise.all([
        ipc.suppliers.list(),
        ipc.suppliers.listParents(),
      ])
      setSuppliers(supplierData as ProjectSupplierView[])
      setParents(parentData as SupplierParent[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Auto-load aliases
  const loadAllAliases = useCallback(async (supplierIds: string[]) => {
    const results = await Promise.all(
      supplierIds.map(async (id) => {
        try {
          const aliases = await ipc.suppliers.getAliases(id)
          return [id, (aliases as string[]).map(name => ({ rawName: name, spend: 0, txnCount: 0 }))] as const
        } catch {
          return [id, [] as AliasData[]] as const
        }
      })
    )
    setAliasCache(prev => {
      const next = new Map(prev)
      for (const [id, data] of results) next.set(id, data)
      return next
    })
  }, [])

  useEffect(() => {
    if (suppliers.length > 0) {
      const unloaded = suppliers.filter(s => !aliasCache.has(s.id))
      if (unloaded.length > 0) loadAllAliases(unloaded.map(s => s.id))
    }
  }, [suppliers, aliasCache, loadAllAliases])

  // ── Refresh (called after ingest modal completes) ───────────────────

  const refresh = useCallback(async () => {
    setLoading(true)
    setAliasCache(new Map())
    await loadData()
  }, [loadData])

  // ── Export ──────────────────────────────────────────────────────────

  const exportCsv = useCallback(async () => {
    const csvString = suppliersToCSV(suppliers, parents, aliasCache)
    try {
      await ipc.export.saveContent(csvString, 'normalized-suppliers.csv')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save CSV')
    }
  }, [suppliers, parents, aliasCache])

  // ── Mutations ─────────────────────────────────────────────────────

  const rename = useCallback(async (supplierId: string, newName: string) => {
    try {
      await ipc.suppliers.rename(supplierId, newName)
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, supplierName: newName } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed')
    }
  }, [onDataChange])

  const deleteSupplier = useCallback(async (supplierId: string) => {
    try {
      await ipc.suppliers.delete(supplierId)
      setSuppliers(prev => prev.filter(s => s.id !== supplierId))
      setAliasCache(prev => {
        const next = new Map(prev)
        next.delete(supplierId)
        return next
      })
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [onDataChange])

  const deleteAlias = useCallback((alias: AliasData, normalizedId: string) => {
    setAliasCache(prev => {
      const next = new Map(prev)
      const aliases = next.get(normalizedId) ?? []
      next.set(normalizedId, aliases.filter(a => a.rawName !== alias.rawName))
      return next
    })
  }, [])

  const changeParent = useCallback(async (supplierId: string, parentId: string | null) => {
    try {
      await ipc.suppliers.assignParent([supplierId], parentId)
      const parent = parentId ? parents.find(p => p.id === parentId) : null
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parentId, parentName: parent?.name ?? null } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change parent')
    }
  }, [parents, onDataChange])

  const renameParent = useCallback(async (parentId: string, newName: string) => {
    try {
      await ipc.suppliers.renameParent(parentId, newName)
      setParents(prev => prev.map(p => p.id === parentId ? { ...p, name: newName } : p))
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentName: newName } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename parent failed')
    }
  }, [onDataChange])

  const deleteParent = useCallback(async (parentId: string) => {
    try {
      const children = suppliers.filter(s => s.parentSupplierId === parentId)
      await ipc.suppliers.assignParent(children.map(s => s.id), null)
      await ipc.suppliers.deleteParent(parentId)
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentSupplierId: null, parentName: null } : s
      ))
      setParents(prev => prev.filter(p => p.id !== parentId))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete parent')
    }
  }, [suppliers, onDataChange])

  const createParentAndAssign = useCallback(async (supplierId: string, name: string) => {
    try {
      const parent = await ipc.suppliers.addParent(name) as SupplierParent
      await ipc.suppliers.assignParent([supplierId], parent.id)
      setParents(prev => [...prev, parent])
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parent.id, parentName: parent.name } : s
      ))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create parent')
    }
  }, [onDataChange])

  const mergeSuppliers = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      const losingSet = new Set(losingIds)
      await ipc.suppliers.merge(survivorId, losingIds)

      setSuppliers(prev => prev.filter(s => !losingSet.has(s.id)))
      setAliasCache(prev => {
        const n = new Map(prev)
        losingSet.forEach(id => n.delete(id))
        n.delete(survivorId)
        return n
      })

      ipc.suppliers.getAliases(survivorId).then(aliases => {
        const aliasData: AliasData[] = (aliases as string[]).map(name => ({
          rawName: name, spend: 0, txnCount: 0,
        }))
        setAliasCache(c => new Map(c).set(survivorId, aliasData))
      }).catch((e) => showError('Failed to reload supplier aliases', e))

      ipc.suppliers.list().then(fresh => {
        setSuppliers(fresh as ProjectSupplierView[])
      }).catch((e) => showError('Failed to refresh supplier list', e))

      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    }
  }, [suppliers, aliasCache, onDataChange])

  const mergeParents = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      const losingSet = new Set(losingIds)
      const survivorParent = parents.find(p => p.id === survivorId)

      await ipc.suppliers.mergeParents(survivorId, losingIds)

      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId && losingSet.has(s.parentSupplierId)
          ? { ...s, parentSupplierId: survivorId, parentName: survivorParent?.name ?? null }
          : s
      ))
      setParents(prev => prev.filter(p => !losingSet.has(p.id)))

      Promise.all([
        ipc.suppliers.list(),
        ipc.suppliers.listParents(),
      ]).then(([freshSuppliers, freshParents]) => {
        setSuppliers(freshSuppliers as ProjectSupplierView[])
        setParents(freshParents as SupplierParent[])
      }).catch((e) => showError('Failed to refresh supplier data after parent merge', e))

      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge parents failed')
    }
  }, [parents, onDataChange])

  const reassignAlias = useCallback(async (aliasName: string, fromId: string, toId: string) => {
    try {
      await ipc.suppliers.assignAlias(toId, aliasName)
      setAliasCache(prev => {
        const next = new Map(prev)
        const fromAliases = next.get(fromId) ?? []
        next.set(fromId, fromAliases.filter(a => a.rawName !== aliasName))
        const toAliases = next.get(toId) ?? []
        next.set(toId, [...toAliases, { rawName: aliasName, spend: 0, txnCount: 0 }])
        return next
      })
      ipc.suppliers.list().then(fresh => {
        setSuppliers(fresh as ProjectSupplierView[])
      }).catch((e) => showError('Failed to refresh supplier list after alias reassign', e))
      onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
    }
  }, [onDataChange])

  return {
    suppliers,
    parents,
    aliasCache,
    loading,
    error,
    setError,
    rename,
    deleteSupplier,
    deleteAlias,
    changeParent,
    renameParent,
    deleteParent,
    createParentAndAssign,
    mergeSuppliers,
    mergeParents,
    reassignAlias,
    refresh,
    exportCsv,
  }
}
