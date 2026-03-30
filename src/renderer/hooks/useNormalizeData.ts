import { useState, useCallback, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import type { ProjectSupplierView, SupplierParent } from '../../shared/types/suppliers'
import { suppliersToCSV } from '../lib/csv-normalize'
import type { AliasData, CsvModeData } from '../lib/csv-normalize'

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

  // CSV mode
  csvMode: boolean
  csvFileName: string | null
  enterCsvMode: (data: CsvModeData, fileName: string) => void
  exitCsvMode: () => void

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
  // ── Project mode state ───────────────────────────────────────────────
  const [projSuppliers, setProjSuppliers] = useState<ProjectSupplierView[]>([])
  const [projParents, setProjParents] = useState<SupplierParent[]>([])
  const [projAliasCache, setProjAliasCache] = useState<Map<string, AliasData[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── CSV mode state ───────────────────────────────────────────────────
  const [csvMode, setCsvMode] = useState(false)
  const [csvFileName, setCsvFileName] = useState<string | null>(null)
  const [csvSuppliers, setCsvSuppliers] = useState<ProjectSupplierView[]>([])
  const [csvParents, setCsvParents] = useState<SupplierParent[]>([])
  const [csvAliasCache, setCsvAliasCache] = useState<Map<string, AliasData[]>>(new Map())

  // ── Active data (switches based on mode) ─────────────────────────────
  const suppliers = csvMode ? csvSuppliers : projSuppliers
  const parents = csvMode ? csvParents : projParents
  const aliasCache = csvMode ? csvAliasCache : projAliasCache

  // Setters that target the active mode
  const setSuppliers = csvMode ? setCsvSuppliers : setProjSuppliers
  const setParents = csvMode ? setCsvParents : setProjParents
  const setAliasCache = csvMode ? setCsvAliasCache : setProjAliasCache

  // ── CSV mode controls ────────────────────────────────────────────────
  const enterCsvMode = useCallback((data: CsvModeData, fileName: string) => {
    setCsvSuppliers(data.suppliers)
    setCsvParents(data.parents)
    setCsvAliasCache(data.aliasCache)
    setCsvFileName(fileName)
    setCsvMode(true)
  }, [])

  const exitCsvMode = useCallback(() => {
    setCsvMode(false)
    setCsvFileName(null)
    setCsvSuppliers([])
    setCsvParents([])
    setCsvAliasCache(new Map())
  }, [])

  // ── Data loading (project mode only) ─────────────────────────────────

  const loadData = useCallback(async () => {
    setError(null)
    try {
      const [supplierData, parentData] = await Promise.all([
        ipc.suppliers.list(),
        ipc.suppliers.listParents(),
      ])
      setProjSuppliers(supplierData as ProjectSupplierView[])
      setProjParents(parentData as SupplierParent[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Auto-load aliases (project mode only)
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
    setProjAliasCache(prev => {
      const next = new Map(prev)
      for (const [id, data] of results) next.set(id, data)
      return next
    })
  }, [])

  useEffect(() => {
    if (!csvMode && projSuppliers.length > 0) {
      const unloaded = projSuppliers.filter(s => !projAliasCache.has(s.id))
      if (unloaded.length > 0) loadAllAliases(unloaded.map(s => s.id))
    }
  }, [csvMode, projSuppliers, projAliasCache, loadAllAliases])

  // ── Refresh (project mode) ──────────────────────────────────────────

  const refresh = useCallback(async () => {
    setLoading(true)
    setProjAliasCache(new Map())
    await loadData()
  }, [loadData])

  // ── Export ──────────────────────────────────────────────────────────

  const exportCsv = useCallback(async () => {
    const csvString = suppliersToCSV(suppliers, parents, aliasCache)
    try {
      await ipc.export.saveContent(csvString, csvMode ? (csvFileName ?? 'normalized-suppliers.csv') : 'normalized-suppliers.csv')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save CSV')
    }
  }, [suppliers, parents, aliasCache, csvMode, csvFileName])

  // ── Mutations ─────────────────────────────────────────────────────

  const rename = useCallback(async (supplierId: string, newName: string) => {
    if (csvMode) {
      setCsvSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, supplierName: newName } : s
      ))
    } else {
      try {
        await ipc.suppliers.rename(supplierId, newName)
        setProjSuppliers(prev => prev.map(s =>
          s.id === supplierId ? { ...s, supplierName: newName } : s
        ))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Rename failed')
      }
    }
  }, [csvMode, onDataChange])

  const deleteSupplier = useCallback(async (supplierId: string) => {
    if (csvMode) {
      setCsvSuppliers(prev => prev.filter(s => s.id !== supplierId))
      setCsvAliasCache(prev => { const n = new Map(prev); n.delete(supplierId); return n })
    } else {
      try {
        await ipc.suppliers.delete(supplierId)
        setProjSuppliers(prev => prev.filter(s => s.id !== supplierId))
        setProjAliasCache(prev => { const n = new Map(prev); n.delete(supplierId); return n })
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Delete failed')
      }
    }
  }, [csvMode, onDataChange])

  const deleteAlias = useCallback((alias: AliasData, normalizedId: string) => {
    setAliasCache(prev => {
      const next = new Map(prev)
      const aliases = next.get(normalizedId) ?? []
      next.set(normalizedId, aliases.filter(a => a.rawName !== alias.rawName))
      return next
    })
  }, [setAliasCache])

  const changeParent = useCallback(async (supplierId: string, parentId: string | null) => {
    if (csvMode) {
      const parent = parentId ? csvParents.find(p => p.id === parentId) : null
      setCsvSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parentId, parentName: parent?.name ?? null } : s
      ))
    } else {
      try {
        await ipc.suppliers.assignParent([supplierId], parentId)
        const parent = parentId ? projParents.find(p => p.id === parentId) : null
        setProjSuppliers(prev => prev.map(s =>
          s.id === supplierId ? { ...s, parentSupplierId: parentId, parentName: parent?.name ?? null } : s
        ))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to change parent')
      }
    }
  }, [csvMode, csvParents, projParents, onDataChange])

  const renameParent = useCallback(async (parentId: string, newName: string) => {
    if (csvMode) {
      setCsvParents(prev => prev.map(p => p.id === parentId ? { ...p, name: newName } : p))
      setCsvSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentName: newName } : s
      ))
    } else {
      try {
        await ipc.suppliers.renameParent(parentId, newName)
        setProjParents(prev => prev.map(p => p.id === parentId ? { ...p, name: newName } : p))
        setProjSuppliers(prev => prev.map(s =>
          s.parentSupplierId === parentId ? { ...s, parentName: newName } : s
        ))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Rename parent failed')
      }
    }
  }, [csvMode, onDataChange])

  const deleteParent = useCallback(async (parentId: string) => {
    if (csvMode) {
      setCsvSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentSupplierId: null, parentName: null } : s
      ))
      setCsvParents(prev => prev.filter(p => p.id !== parentId))
    } else {
      try {
        const children = projSuppliers.filter(s => s.parentSupplierId === parentId)
        await ipc.suppliers.assignParent(children.map(s => s.id), null)
        await ipc.suppliers.deleteParent(parentId)
        setProjSuppliers(prev => prev.map(s =>
          s.parentSupplierId === parentId ? { ...s, parentSupplierId: null, parentName: null } : s
        ))
        setProjParents(prev => prev.filter(p => p.id !== parentId))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete parent')
      }
    }
  }, [csvMode, projSuppliers, onDataChange])

  const createParentAndAssign = useCallback(async (supplierId: string, name: string) => {
    if (csvMode) {
      const id = uuidv4()
      const parent: SupplierParent = { id, name, createdAt: new Date().toISOString() }
      setCsvParents(prev => [...prev, parent])
      setCsvSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: id, parentName: name } : s
      ))
    } else {
      try {
        const parent = await ipc.suppliers.addParent(name) as SupplierParent
        await ipc.suppliers.assignParent([supplierId], parent.id)
        setProjParents(prev => [...prev, parent])
        setProjSuppliers(prev => prev.map(s =>
          s.id === supplierId ? { ...s, parentSupplierId: parent.id, parentName: parent.name } : s
        ))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create parent')
      }
    }
  }, [csvMode, onDataChange])

  const mergeSuppliers = useCallback(async (survivorId: string, losingIds: string[]) => {
    if (csvMode) {
      const losingSet = new Set(losingIds)
      // Merge aliases from losers into survivor
      setCsvAliasCache(prev => {
        const next = new Map(prev)
        const survivorAliases = [...(next.get(survivorId) ?? [])]
        for (const lid of losingIds) {
          const loserAliases = next.get(lid) ?? []
          survivorAliases.push(...loserAliases)
          next.delete(lid)
        }
        next.set(survivorId, survivorAliases)
        return next
      })
      // Sum spend/txns, remove losers
      setCsvSuppliers(prev => {
        const losers = prev.filter(s => losingSet.has(s.id))
        const extraSpend = losers.reduce((sum, s) => sum + s.totalSpend, 0)
        const extraTxns = losers.reduce((sum, s) => sum + s.transactionCount, 0)
        return prev
          .filter(s => !losingSet.has(s.id))
          .map(s => s.id === survivorId
            ? { ...s, totalSpend: s.totalSpend + extraSpend, transactionCount: s.transactionCount + extraTxns }
            : s
          )
      })
    } else {
      try {
        const losingSet = new Set(losingIds)
        await ipc.suppliers.merge(survivorId, losingIds)
        setProjSuppliers(prev => prev.filter(s => !losingSet.has(s.id)))
        setProjAliasCache(prev => {
          const n = new Map(prev)
          losingSet.forEach(id => n.delete(id))
          n.delete(survivorId)
          return n
        })
        ipc.suppliers.getAliases(survivorId).then(aliases => {
          const aliasData: AliasData[] = (aliases as string[]).map(name => ({
            rawName: name, spend: 0, txnCount: 0,
          }))
          setProjAliasCache(c => new Map(c).set(survivorId, aliasData))
        }).catch((e) => showError('Failed to reload supplier aliases', e))
        ipc.suppliers.list().then(fresh => {
          setProjSuppliers(fresh as ProjectSupplierView[])
        }).catch((e) => showError('Failed to refresh supplier list', e))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Merge failed')
      }
    }
  }, [csvMode, onDataChange])

  const mergeParents = useCallback(async (survivorId: string, losingIds: string[]) => {
    if (csvMode) {
      const losingSet = new Set(losingIds)
      const survivorParent = csvParents.find(p => p.id === survivorId)
      setCsvSuppliers(prev => prev.map(s =>
        s.parentSupplierId && losingSet.has(s.parentSupplierId)
          ? { ...s, parentSupplierId: survivorId, parentName: survivorParent?.name ?? null }
          : s
      ))
      setCsvParents(prev => prev.filter(p => !losingSet.has(p.id)))
    } else {
      try {
        const losingSet = new Set(losingIds)
        const survivorParent = projParents.find(p => p.id === survivorId)
        await ipc.suppliers.mergeParents(survivorId, losingIds)
        setProjSuppliers(prev => prev.map(s =>
          s.parentSupplierId && losingSet.has(s.parentSupplierId)
            ? { ...s, parentSupplierId: survivorId, parentName: survivorParent?.name ?? null }
            : s
        ))
        setProjParents(prev => prev.filter(p => !losingSet.has(p.id)))
        Promise.all([
          ipc.suppliers.list(),
          ipc.suppliers.listParents(),
        ]).then(([freshSuppliers, freshParents]) => {
          setProjSuppliers(freshSuppliers as ProjectSupplierView[])
          setProjParents(freshParents as SupplierParent[])
        }).catch((e) => showError('Failed to refresh supplier data after parent merge', e))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Merge parents failed')
      }
    }
  }, [csvMode, csvParents, projParents, onDataChange])

  const reassignAlias = useCallback(async (aliasName: string, fromId: string, toId: string) => {
    if (csvMode) {
      setCsvAliasCache(prev => {
        const next = new Map(prev)
        const fromAliases = next.get(fromId) ?? []
        const movedAlias = fromAliases.find(a => a.rawName === aliasName)
        next.set(fromId, fromAliases.filter(a => a.rawName !== aliasName))
        const toAliases = next.get(toId) ?? []
        next.set(toId, [...toAliases, movedAlias ?? { rawName: aliasName, spend: 0, txnCount: 0 }])
        return next
      })
    } else {
      try {
        await ipc.suppliers.assignAlias(toId, aliasName)
        setProjAliasCache(prev => {
          const next = new Map(prev)
          const fromAliases = next.get(fromId) ?? []
          next.set(fromId, fromAliases.filter(a => a.rawName !== aliasName))
          const toAliases = next.get(toId) ?? []
          next.set(toId, [...toAliases, { rawName: aliasName, spend: 0, txnCount: 0 }])
          return next
        })
        ipc.suppliers.list().then(fresh => {
          setProjSuppliers(fresh as ProjectSupplierView[])
        }).catch((e) => showError('Failed to refresh supplier list after alias reassign', e))
        onDataChange?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Reassign failed')
      }
    }
  }, [csvMode, onDataChange])

  return {
    suppliers,
    parents,
    aliasCache,
    loading,
    error,
    setError,
    csvMode,
    csvFileName,
    enterCsvMode,
    exitCsvMode,
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
