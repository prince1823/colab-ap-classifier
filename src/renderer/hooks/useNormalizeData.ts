import { useState, useCallback, useEffect } from 'react'
import { ipc } from '../lib/ipc'
import { showError } from '../lib/toast-errors'
import type { ProjectSupplierView, SupplierParent } from '../../shared/types/suppliers'
import { parseCsvToSuppliers, suppliersToCSV } from '../lib/csv-normalize'
import type { AliasData } from '../lib/csv-normalize'

export type { AliasData }

interface UseNormalizeDataOptions {
  onDataChange?: () => void
}

export interface NormalizeDataSource {
  mode: 'project' | 'csv'
  csvFileName: string | null
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

  loadCsv(file: File): Promise<void>
  exitCsvMode(): void
  exportCsv(): Promise<void>
}

export function useNormalizeData({ onDataChange }: UseNormalizeDataOptions = {}): NormalizeDataSource {
  const [mode, setMode] = useState<'project' | 'csv'>('project')
  const [csvFileName, setCsvFileName] = useState<string | null>(null)

  const [suppliers, setSuppliers] = useState<ProjectSupplierView[]>([])
  const [parents, setParents] = useState<SupplierParent[]>([])
  const [aliasCache, setAliasCache] = useState<Map<string, AliasData[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── Project mode: data loading ────────────────────────────────────

  const loadData = useCallback(async () => {
    if (mode !== 'project') return
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
  }, [mode])

  useEffect(() => { loadData() }, [loadData])

  // Auto-load aliases for project mode
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
    if (mode !== 'project') return
    if (suppliers.length > 0) {
      const unloaded = suppliers.filter(s => !aliasCache.has(s.id))
      if (unloaded.length > 0) loadAllAliases(unloaded.map(s => s.id))
    }
  }, [mode, suppliers, aliasCache, loadAllAliases])

  // ── CSV mode ──────────────────────────────────────────────────────

  const loadCsv = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const result = parseCsvToSuppliers(text)
      setSuppliers(result.suppliers)
      setParents(result.parents)
      setAliasCache(result.aliasCache)
      setCsvFileName(file.name)
      setMode('csv')
      setLoading(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse CSV')
    }
  }, [])

  const exitCsvMode = useCallback(() => {
    setMode('project')
    setCsvFileName(null)
    setAliasCache(new Map())
    setLoading(true)
    // loadData will fire via the mode-dependent useEffect
  }, [])

  const exportCsv = useCallback(async () => {
    const csvString = suppliersToCSV(suppliers, parents, aliasCache)
    try {
      await ipc.export.saveContent(csvString, csvFileName ?? 'normalized-suppliers.csv')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save CSV')
    }
  }, [suppliers, parents, aliasCache, csvFileName])

  // ── Mutations ─────────────────────────────────────────────────────

  const rename = useCallback(async (supplierId: string, newName: string) => {
    try {
      if (mode === 'project') {
        await ipc.suppliers.rename(supplierId, newName)
      }
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, supplierName: newName } : s
      ))
      if (mode === 'project') onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed')
    }
  }, [mode, onDataChange])

  const deleteSupplier = useCallback(async (supplierId: string) => {
    try {
      if (mode === 'project') {
        await ipc.suppliers.delete(supplierId)
      }
      setSuppliers(prev => prev.filter(s => s.id !== supplierId))
      setAliasCache(prev => {
        const next = new Map(prev)
        next.delete(supplierId)
        return next
      })
      if (mode === 'project') onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }, [mode, onDataChange])

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
      if (mode === 'project') {
        await ipc.suppliers.assignParent([supplierId], parentId)
      }
      const parent = parentId ? parents.find(p => p.id === parentId) : null
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parentId, parentName: parent?.name ?? null } : s
      ))
      if (mode === 'project') onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change parent')
    }
  }, [mode, parents, onDataChange])

  const renameParent = useCallback(async (parentId: string, newName: string) => {
    try {
      if (mode === 'project') {
        await ipc.suppliers.renameParent(parentId, newName)
      }
      setParents(prev => prev.map(p => p.id === parentId ? { ...p, name: newName } : p))
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentName: newName } : s
      ))
      if (mode === 'project') onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename parent failed')
    }
  }, [mode, onDataChange])

  const deleteParent = useCallback(async (parentId: string) => {
    try {
      const children = suppliers.filter(s => s.parentSupplierId === parentId)
      if (mode === 'project') {
        await ipc.suppliers.assignParent(children.map(s => s.id), null)
        await ipc.suppliers.deleteParent(parentId)
      }
      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId === parentId ? { ...s, parentSupplierId: null, parentName: null } : s
      ))
      setParents(prev => prev.filter(p => p.id !== parentId))
      if (mode === 'project') onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete parent')
    }
  }, [mode, suppliers, onDataChange])

  const createParentAndAssign = useCallback(async (supplierId: string, name: string) => {
    try {
      let parent: SupplierParent
      if (mode === 'project') {
        parent = await ipc.suppliers.addParent(name) as SupplierParent
        await ipc.suppliers.assignParent([supplierId], parent.id)
      } else {
        parent = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() }
      }
      setParents(prev => [...prev, parent])
      setSuppliers(prev => prev.map(s =>
        s.id === supplierId ? { ...s, parentSupplierId: parent.id, parentName: parent.name } : s
      ))
      if (mode === 'project') onDataChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create parent')
    }
  }, [mode, onDataChange])

  const mergeSuppliers = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      const losingSet = new Set(losingIds)

      if (mode === 'project') {
        await ipc.suppliers.merge(survivorId, losingIds)
      }

      // In CSV mode: absorb losers' aliases and aggregate spend/txns
      if (mode === 'csv') {
        const survivor = suppliers.find(s => s.id === survivorId)
        const losers = suppliers.filter(s => losingSet.has(s.id))
        if (survivor) {
          const extraSpend = losers.reduce((sum, s) => sum + s.totalSpend, 0)
          const extraTxns = losers.reduce((sum, s) => sum + s.transactionCount, 0)

          // Merge aliases
          const survivorAliases = aliasCache.get(survivorId) ?? []
          const loserAliases = losers.flatMap(s => aliasCache.get(s.id) ?? [])
          setAliasCache(prev => {
            const next = new Map(prev)
            next.set(survivorId, [...survivorAliases, ...loserAliases])
            losingIds.forEach(id => next.delete(id))
            return next
          })

          setSuppliers(prev => prev
            .filter(s => !losingSet.has(s.id))
            .map(s => s.id === survivorId
              ? { ...s, totalSpend: s.totalSpend + extraSpend, transactionCount: s.transactionCount + extraTxns }
              : s
            )
          )
        }
      } else {
        // Project mode: remove losers, invalidate survivor aliases, background refresh
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
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    }
  }, [mode, suppliers, aliasCache, onDataChange])

  const mergeParents = useCallback(async (survivorId: string, losingIds: string[]) => {
    try {
      const losingSet = new Set(losingIds)
      const survivorParent = parents.find(p => p.id === survivorId)

      if (mode === 'project') {
        await ipc.suppliers.mergeParents(survivorId, losingIds)
      }

      setSuppliers(prev => prev.map(s =>
        s.parentSupplierId && losingSet.has(s.parentSupplierId)
          ? { ...s, parentSupplierId: survivorId, parentName: survivorParent?.name ?? null }
          : s
      ))
      setParents(prev => prev.filter(p => !losingSet.has(p.id)))

      if (mode === 'project') {
        Promise.all([
          ipc.suppliers.list(),
          ipc.suppliers.listParents(),
        ]).then(([freshSuppliers, freshParents]) => {
          setSuppliers(freshSuppliers as ProjectSupplierView[])
          setParents(freshParents as SupplierParent[])
        }).catch((e) => showError('Failed to refresh supplier data after parent merge', e))

        onDataChange?.()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge parents failed')
    }
  }, [mode, parents, onDataChange])

  const reassignAlias = useCallback(async (aliasName: string, fromId: string, toId: string) => {
    try {
      if (mode === 'project') {
        await ipc.suppliers.assignAlias(toId, aliasName)
      }
      setAliasCache(prev => {
        const next = new Map(prev)
        const fromAliases = next.get(fromId) ?? []
        next.set(fromId, fromAliases.filter(a => a.rawName !== aliasName))
        const toAliases = next.get(toId) ?? []
        next.set(toId, [...toAliases, { rawName: aliasName, spend: 0, txnCount: 0 }])
        return next
      })
      if (mode === 'project') {
        ipc.suppliers.list().then(fresh => {
          setSuppliers(fresh as ProjectSupplierView[])
        }).catch((e) => showError('Failed to refresh supplier list after alias reassign', e))
        onDataChange?.()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
    }
  }, [mode, onDataChange])

  return {
    mode,
    csvFileName,
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
    loadCsv,
    exitCsvMode,
    exportCsv,
  }
}
