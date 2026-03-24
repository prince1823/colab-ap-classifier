import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ipc } from '../lib/ipc'
import { makeEmptyGroup, OPERATOR_LABELS, GroupedFilterBuilder } from '../components/FilterConditionBuilder'
import AdvancedFilterModal from '../components/review/AdvancedFilterModal'
import type { OverrideRule } from '../../shared/types/rules'
import type { RuleBucket } from '../../shared/types/rules'
import type { FieldDefinition, GroupedFilter } from '../../shared/types/transactions'
import type { TaxonomyNode } from '../../shared/types/taxonomy'

// ─── Drag type constants ────────────────────────────────────────────────────
const DRAG_TYPE_RULE = 'application/x-rule-drag'
const DRAG_TYPE_BUCKET = 'application/x-bucket-drag'

export default function OverrideRulesPage() {
  const [rules, setRules] = useState<OverrideRule[]>([])
  const [buckets, setBuckets] = useState<RuleBucket[]>([])
  const [taxonomyNodes, setTaxonomyNodes] = useState<TaxonomyNode[]>([])
  const [filterFields, setFilterFields] = useState<FieldDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create/edit editor
  const [showEditor, setShowEditor] = useState(false)
  const [editingRule, setEditingRule] = useState<OverrideRule | null>(null)
  const [name, setName] = useState('')
  const [grouped, setGrouped] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [targetNodeId, setTargetNodeId] = useState('')
  const [editorBucketId, setEditorBucketId] = useState('')
  const [saving, setSaving] = useState(false)
  const [taxonomySearch, setTaxonomySearch] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  type SourceFilter = 'all' | 'manual' | 'auto'
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [taxonomyDropdownOpen, setTaxonomyDropdownOpen] = useState(false)
  const taxonomyDropdownRef = useRef<HTMLDivElement>(null)

  // Bucket UI state
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set())
  const [editingBucketId, setEditingBucketId] = useState<string | null>(null)
  const [editingBucketName, setEditingBucketName] = useState('')
  const [showNewBucketInput, setShowNewBucketInput] = useState(false)
  const [newBucketName, setNewBucketName] = useState('')
  const [newBucketConditions, setNewBucketConditions] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
  const [deletingBucketId, setDeletingBucketId] = useState<string | null>(null)

  // Conditions modals
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false)
  // For editing existing bucket conditions
  const [editingBucketConditionsId, setEditingBucketConditionsId] = useState<string | null>(null)
  const [editingBucketConditionsData, setEditingBucketConditionsData] = useState<GroupedFilter>({ groupConnector: 'AND', groups: [makeEmptyGroup()] })

  // No-match popup for auto-assign
  const [showNoBucketMatch, setShowNoBucketMatch] = useState(false)
  const [pendingRuleConditions, setPendingRuleConditions] = useState<GroupedFilter | null>(null)

  // Expanded conditions per rule
  const [expandedConditions, setExpandedConditions] = useState<Set<string>>(new Set())

  // Drag-and-drop refs — no React state during drag for performance
  const dragTypeRef = useRef<'rule' | 'bucket' | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const dragSourceBucketRef = useRef<string | null>(null)
  const prevOverRow = useRef<HTMLElement | null>(null)

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, b, n, fields] = await Promise.all([
        ipc.rules.list(),
        ipc.rules.listBuckets(),
        ipc.taxonomy.getNodes(),
        ipc.transactions.getFilterFields(),
      ])
      setRules(r ?? [])
      setBuckets(b ?? [])
      setTaxonomyNodes(n ?? [])
      setFilterFields(fields ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const defaultBucketId = useMemo(() => {
    return buckets.find(b => b.isDefault)?.id ?? buckets[0]?.id ?? ''
  }, [buckets])

  const openCreate = (bucketId?: string) => {
    setEditingRule(null)
    setName('')
    setGrouped({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setTargetNodeId(taxonomyNodes[0]?.id || '')
    setEditorBucketId(bucketId ?? defaultBucketId)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setShowEditor(true)
  }

  const openEdit = (rule: OverrideRule) => {
    setEditingRule(rule)
    setName(rule.name)
    setGrouped(rule.groupedConditions?.groups?.length > 0 ? rule.groupedConditions : { groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setTargetNodeId(rule.targetTaxonomyNodeId)
    setEditorBucketId(rule.bucketId)
    setTaxonomySearch('')
    setTaxonomyDropdownOpen(false)
    setShowEditor(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      // Find a matching bucket by auto-filter conditions
      let matchedBucketId: string | null = null
      for (const bucket of buckets) {
        if (bucket.groupedConditions) {
          // Build a temporary rule-like object to check
          const tempRule = { groupedConditions: grouped } as OverrideRule
          if (ruleMatchesBucketFilter(tempRule, bucket.groupedConditions)) {
            matchedBucketId = bucket.id
            break
          }
        }
      }

      const targetBucketId = matchedBucketId ?? defaultBucketId

      if (editingRule) {
        await ipc.rules.update(editingRule.id, { name, groupedConditions: grouped, targetTaxonomyNodeId: targetNodeId })
        // Move to matched bucket (or keep in default)
        if (matchedBucketId && matchedBucketId !== editingRule.bucketId) {
          await ipc.rules.moveRule(editingRule.id, matchedBucketId)
        }
      } else {
        await ipc.rules.create({ name, groupedConditions: grouped, targetTaxonomyNodeId: targetNodeId, bucketId: targetBucketId })
      }

      setShowEditor(false)
      await loadData()

      // If no bucket matched, prompt user to create one
      if (!matchedBucketId) {
        setPendingRuleConditions(grouped)
        setShowNoBucketMatch(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  const handleCreateBucketFromPrompt = () => {
    setShowNoBucketMatch(false)
    setNewBucketName('')
    setNewBucketConditions(pendingRuleConditions ?? { groupConnector: 'AND', groups: [makeEmptyGroup()] })
    setPendingRuleConditions(null)
    setShowNewBucketInput(true)
  }

  const handleDelete = async (ruleId: string) => {
    try {
      await ipc.rules.delete(ruleId)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete rule')
    }
  }

  const handleToggle = async (rule: OverrideRule) => {
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r))
    try {
      await ipc.rules.update(rule.id, { isActive: !rule.isActive })
    } catch (e) {
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: rule.isActive } : r))
      setError(e instanceof Error ? e.message : 'Failed to toggle rule')
    }
  }

  // ─── Bucket CRUD ──────────────────────────────────────────────────────────

  const handleCreateBucket = async () => {
    if (!newBucketName.trim()) return
    try {
      // Check if conditions have any real content
      const hasConditions = newBucketConditions.groups.some(g => g.conditions.some(c => c.field))
      await ipc.rules.createBucket({
        name: newBucketName.trim(),
        groupedConditions: hasConditions ? newBucketConditions : undefined,
      })
      setNewBucketName('')
      setNewBucketConditions({ groupConnector: 'AND', groups: [makeEmptyGroup()] })
      setShowNewBucketInput(false)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create bucket')
    }
  }

  const handleUpdateBucketConditions = async (bucketId: string, conditions: GroupedFilter | null) => {
    try {
      const hasConditions = conditions && conditions.groups.some(g => g.conditions.some(c => c.field))
      await ipc.rules.updateBucket(bucketId, { groupedConditions: hasConditions ? conditions : null })
      setEditingBucketConditionsId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update bucket conditions')
    }
  }

  const handleRenameBucket = async (bucketId: string) => {
    if (!editingBucketName.trim()) { setEditingBucketId(null); return }
    try {
      await ipc.rules.updateBucket(bucketId, { name: editingBucketName.trim() })
      setEditingBucketId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename bucket')
    }
  }

  const handleDeleteBucket = async (bucketId: string) => {
    try {
      await ipc.rules.deleteBucket(bucketId)
      setDeletingBucketId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete bucket')
    }
  }

  // ─── Drag-and-drop: Rule reorder / cross-bucket move ─────────────────────

  const handleRuleDragStart = useCallback((e: React.DragEvent, ruleId: string, bucketId: string) => {
    dragTypeRef.current = 'rule'
    dragIdRef.current = ruleId
    dragSourceBucketRef.current = bucketId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE_RULE, ruleId)
    requestAnimationFrame(() => {
      if (e.currentTarget instanceof HTMLElement) {
        e.currentTarget.style.opacity = '0.4'
      }
    })
  }, [])

  const handleRuleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    if (prevOverRow.current) {
      prevOverRow.current.style.borderTop = ''
      prevOverRow.current = null
    }
    dragTypeRef.current = null
    dragIdRef.current = null
    dragSourceBucketRef.current = null
  }, [])

  const handleRuleDragOver = useCallback((e: React.DragEvent) => {
    if (dragTypeRef.current !== 'rule') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const row = e.currentTarget as HTMLElement
    if (prevOverRow.current !== row) {
      if (prevOverRow.current) prevOverRow.current.style.borderTop = ''
      row.style.borderTop = '2px solid #60a5fa'
      prevOverRow.current = row
    }
  }, [])

  const handleRuleDropOnRule = useCallback(async (e: React.DragEvent, targetRule: OverrideRule, bucketRuleIds: string[]) => {
    e.preventDefault()
    if (prevOverRow.current) {
      prevOverRow.current.style.borderTop = ''
      prevOverRow.current = null
    }
    const draggedId = dragIdRef.current
    const sourceBucket = dragSourceBucketRef.current
    if (!draggedId || draggedId === targetRule.id) return

    try {
      if (sourceBucket === targetRule.bucketId) {
        // Intra-bucket reorder
        const newOrder = bucketRuleIds.filter(id => id !== draggedId)
        const targetIdx = newOrder.indexOf(targetRule.id)
        newOrder.splice(targetIdx, 0, draggedId)
        await ipc.rules.reorderInBucket(targetRule.bucketId, newOrder)
      } else {
        // Cross-bucket move
        const targetIdx = bucketRuleIds.indexOf(targetRule.id)
        await ipc.rules.moveRule(draggedId, targetRule.bucketId, targetIdx)
      }
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder rule')
      await loadData()
    }
  }, [])

  // Drop rule onto bucket header (move to end of bucket)
  const handleRuleDropOnBucket = useCallback(async (e: React.DragEvent, targetBucketId: string) => {
    e.preventDefault()
    if (prevOverRow.current) {
      prevOverRow.current.style.borderTop = ''
      prevOverRow.current = null
    }
    const draggedId = dragIdRef.current
    if (!draggedId || dragTypeRef.current !== 'rule') return
    if (dragSourceBucketRef.current === targetBucketId) return

    try {
      await ipc.rules.moveRule(draggedId, targetBucketId)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move rule')
      await loadData()
    }
  }, [])

  // ─── Drag-and-drop: Bucket reorder ────────────────────────────────────────

  const handleBucketDragStart = useCallback((e: React.DragEvent, bucketId: string) => {
    dragTypeRef.current = 'bucket'
    dragIdRef.current = bucketId
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE_BUCKET, bucketId)
    requestAnimationFrame(() => {
      if (e.currentTarget instanceof HTMLElement) {
        e.currentTarget.style.opacity = '0.5'
      }
    })
  }, [])

  const handleBucketDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    if (prevOverRow.current) {
      prevOverRow.current.style.borderTop = ''
      prevOverRow.current = null
    }
    dragTypeRef.current = null
    dragIdRef.current = null
  }, [])

  const handleBucketDragOver = useCallback((e: React.DragEvent) => {
    if (dragTypeRef.current === 'bucket') {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const el = e.currentTarget as HTMLElement
      if (prevOverRow.current !== el) {
        if (prevOverRow.current) prevOverRow.current.style.borderTop = ''
        el.style.borderTop = '2px solid #818cf8'
        prevOverRow.current = el
      }
    } else if (dragTypeRef.current === 'rule') {
      // Also accept rule drops on bucket headers
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const el = e.currentTarget as HTMLElement
      if (prevOverRow.current !== el) {
        if (prevOverRow.current) prevOverRow.current.style.borderTop = ''
        el.style.borderTop = '2px solid #60a5fa'
        prevOverRow.current = el
      }
    }
  }, [])

  const handleBucketDrop = useCallback(async (e: React.DragEvent, targetBucketId: string) => {
    e.preventDefault()
    if (prevOverRow.current) {
      prevOverRow.current.style.borderTop = ''
      prevOverRow.current = null
    }

    if (dragTypeRef.current === 'bucket') {
      const draggedId = dragIdRef.current
      if (!draggedId || draggedId === targetBucketId) return
      // Reorder buckets
      const currentOrder = buckets.map(b => b.id)
      const newOrder = currentOrder.filter(id => id !== draggedId)
      const targetIdx = newOrder.indexOf(targetBucketId)
      newOrder.splice(targetIdx, 0, draggedId)
      try {
        await ipc.rules.reorderBuckets(newOrder)
        await loadData()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to reorder buckets')
        await loadData()
      }
    } else if (dragTypeRef.current === 'rule') {
      await handleRuleDropOnBucket(e, targetBucketId)
    }
  }, [buckets, handleRuleDropOnBucket])

  // ─── Taxonomy dropdown ────────────────────────────────────────────────────

  const filteredTaxonomyNodes = useMemo(() => {
    const l3Only = taxonomyNodes.filter(n => n.l3 !== null)
    if (!taxonomySearch.trim()) return l3Only
    const q = taxonomySearch.toLowerCase()
    return l3Only.filter(n => n.fullPath.toLowerCase().includes(q))
  }, [taxonomyNodes, taxonomySearch])

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (taxonomyDropdownRef.current && !taxonomyDropdownRef.current.contains(e.target as Node)) {
        setTaxonomyDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [])

  const selectTaxonomyNode = (nodeId: string) => {
    setTargetNodeId(nodeId)
    setTaxonomyDropdownOpen(false)
    setTaxonomySearch('')
  }

  const getNodePath = (nodeId: string) => taxonomyNodes.find((n) => n.id === nodeId)?.fullPath || nodeId

  const formatGroupedFilter = (gf: GroupedFilter) => {
    if (!gf?.groups?.length) return 'No conditions'
    const hasConditions = gf.groups.some(g => g.conditions.some(c => c.field))
    if (!hasConditions) return 'No conditions configured'
    return gf.groups.map((g, gi) => {
      const groupStr = g.conditions
        .filter(c => c.field)
        .map((c, ci, arr) => {
          const part = `${c.field} ${OPERATOR_LABELS[c.operator]} "${c.value}"`
          if (ci < arr.length - 1) return `${part} ${c.connector || g.connector}`
          return part
        })
        .join(' ')
      const prefix = gi > 0 ? ` ${g.groupConnector || gf.groupConnector} ` : ''
      return gf.groups.length > 1 ? `${prefix}(${groupStr})` : `${prefix}${groupStr}`
    }).join('')
  }

  const formatConditionSummary = (rule: OverrideRule) => {
    const { groupedConditions } = rule
    if (!groupedConditions?.groups?.length) return 'No conditions'
    return formatGroupedFilter(groupedConditions)
  }

  // ─── Filtering ────────────────────────────────────────────────────────────

  const filteredRules = useMemo(() => {
    let result = rules
    if (sourceFilter === 'manual') {
      result = result.filter(r => r.source !== 'auto_generated')
    } else if (sourceFilter === 'auto') {
      result = result.filter(r => r.source === 'auto_generated')
    }
    if (ruleSearch.trim()) {
      const q = ruleSearch.toLowerCase()
      result = result.filter(r => {
        const target = getNodePath(r.targetTaxonomyNodeId).toLowerCase()
        const conditions = formatConditionSummary(r).toLowerCase()
        const source = r.source === 'auto_generated' ? 'auto' : 'manual'
        const status = r.isActive ? 'active' : 'inactive'
        return (
          r.name.toLowerCase().includes(q) ||
          target.includes(q) ||
          conditions.includes(q) ||
          source.includes(q) ||
          status.includes(q)
        )
      })
    }
    return result
  }, [rules, ruleSearch, taxonomyNodes, sourceFilter])

  // Check if a rule's conditions match a bucket's auto-filter conditions
  const ruleMatchesBucketFilter = useCallback((rule: OverrideRule, bucketFilter: GroupedFilter): boolean => {
    // Field-only matching: for each field used in the bucket filter,
    // check if the rule has ANY condition on the same field (regardless of operator/value)
    const bucketFields = new Set<string>()
    for (const bucketGroup of bucketFilter.groups) {
      for (const bucketCond of bucketGroup.conditions) {
        if (bucketCond.field) bucketFields.add(bucketCond.field)
      }
    }
    if (bucketFields.size === 0) return false

    const ruleFields = new Set<string>()
    for (const ruleGroup of (rule.groupedConditions?.groups ?? [])) {
      for (const ruleCond of ruleGroup.conditions) {
        if (ruleCond.field) ruleFields.add(ruleCond.field)
      }
    }

    // Every field in the bucket filter must appear in the rule's conditions
    for (const field of bucketFields) {
      if (!ruleFields.has(field)) return false
    }
    return true
  }, [])

  const rulesByBucket = useMemo(() => {
    const map = new Map<string, OverrideRule[]>()
    const assigned = new Set<string>() // track rules already placed by auto-filter

    for (const bucket of buckets) {
      map.set(bucket.id, [])
    }

    // First pass: auto-filter buckets claim matching rules
    for (const bucket of buckets) {
      if (!bucket.groupedConditions) continue
      for (const rule of filteredRules) {
        if (ruleMatchesBucketFilter(rule, bucket.groupedConditions)) {
          map.get(bucket.id)!.push(rule)
          assigned.add(rule.id)
        }
      }
    }

    // Second pass: remaining rules go to their manually assigned bucket
    for (const rule of filteredRules) {
      if (assigned.has(rule.id)) continue
      const list = map.get(rule.bucketId) ?? map.get(defaultBucketId)
      if (list) list.push(rule)
    }

    // Sort each list by priorityScore
    for (const list of map.values()) {
      list.sort((a, b) => a.priorityScore - b.priorityScore)
    }
    return map
  }, [filteredRules, buckets, defaultBucketId, ruleMatchesBucketFilter])

  const toggleBucket = (bucketId: string) => {
    setCollapsedBuckets(prev => {
      const next = new Set(prev)
      if (next.has(bucketId)) next.delete(bucketId)
      else next.add(bucketId)
      return next
    })
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="h-8 w-8 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-6">
      {/* Header toolbar */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Override Rules</h2>
          <p className="mt-1 text-sm text-gray-500">{rules.length} rules in {buckets.length} bucket{buckets.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSourceFilter(prev => prev === 'all' ? 'manual' : prev === 'manual' ? 'auto' : 'all')}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              sourceFilter === 'all'
                ? 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                : sourceFilter === 'manual'
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-purple-300 bg-purple-50 text-purple-700'
            }`}
            title={`Showing: ${sourceFilter === 'all' ? 'All rules' : sourceFilter === 'manual' ? 'Manual rules only' : 'Auto-generated rules only'}. Click to cycle.`}
          >
            {sourceFilter === 'all' && 'All Rules'}
            {sourceFilter === 'manual' && 'Manual'}
            {sourceFilter === 'auto' && 'Auto'}
          </button>
          {/* Collapse / Expand all */}
          <button
            onClick={() => {
              const allCollapsed = collapsedBuckets.size === buckets.length
              if (allCollapsed) {
                setCollapsedBuckets(new Set())
              } else {
                setCollapsedBuckets(new Set(buckets.map(b => b.id)))
              }
            }}
            title={collapsedBuckets.size === buckets.length ? 'Expand all' : 'Collapse all'}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            {collapsedBuckets.size === buckets.length ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 9L3.75 3.75M9 9H3.75M9 9V3.75m6 11.25l5.25 5.25M15 15h5.25M15 15v5.25" /></svg>
            )}
          </button>
          <div className="relative">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search rules..."
              value={ruleSearch}
              onChange={(e) => setRuleSearch(e.target.value)}
              className="w-64 rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => setShowNewBucketInput(true)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            + Bucket
          </button>
          <button onClick={() => openCreate()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Add Rule
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {/* Rule editor panel */}
      {showEditor && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
          <h3 className="text-sm font-medium text-gray-700">{editingRule ? 'Edit Rule' : 'New Rule'}</h3>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Conditions</label>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <span className="text-xs text-gray-600 truncate" title={formatGroupedFilter(grouped)}>
                {formatGroupedFilter(grouped)}
              </span>
              <button
                type="button"
                onClick={() => setConditionsModalOpen(true)}
                className="ml-3 shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50"
              >
                Configure
              </button>
            </div>
            <AdvancedFilterModal
              isOpen={conditionsModalOpen}
              onClose={() => setConditionsModalOpen(false)}
              groupedFilter={grouped}
              onApply={(g) => setGrouped(g ?? { groupConnector: 'AND', groups: [makeEmptyGroup()] })}
              availableFields={filterFields}
              title="Rule Conditions"
              subtitle="Define when this override rule applies"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Bucket</label>
              <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                Auto-assigned based on conditions</p>
            </div>
          </div>
          <div ref={taxonomyDropdownRef} className="relative">
            <label className="mb-1 block text-xs font-medium text-gray-600">Target Classification</label>
            <button
              type="button"
              onClick={() => setTaxonomyDropdownOpen(!taxonomyDropdownOpen)}
              className="flex w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm hover:border-gray-400"
            >
              <span className={targetNodeId ? 'text-gray-900 truncate' : 'text-gray-400'}>
                {targetNodeId ? getNodePath(targetNodeId) : 'Select classification...'}
              </span>
              <svg className={`ml-2 h-4 w-4 shrink-0 text-gray-400 transition-transform ${taxonomyDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
            </button>
            {taxonomyDropdownOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
                <div className="border-b border-gray-100 p-2">
                  <input
                    value={taxonomySearch}
                    onChange={(e) => setTaxonomySearch(e.target.value)}
                    placeholder="Search taxonomy..."
                    autoFocus
                    className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                </div>
                <ul className="max-h-48 overflow-y-auto py-1">
                  {filteredTaxonomyNodes.length === 0 && (
                    <li className="px-3 py-2 text-xs text-gray-400">No matches</li>
                  )}
                  {filteredTaxonomyNodes.map((n) => (
                    <li
                      key={n.id}
                      onMouseDown={(e) => { e.preventDefault(); selectTaxonomyNode(n.id) }}
                      className={`cursor-pointer px-3 py-1.5 text-xs leading-snug ${
                        n.id === targetNodeId
                          ? 'bg-blue-50 font-medium text-blue-700'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {n.fullPath}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setShowEditor(false)} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      )}

      {/* Delete bucket confirmation */}
      {deletingBucketId && (() => {
        const bucket = buckets.find(b => b.id === deletingBucketId)
        const ruleCount = rulesByBucket.get(deletingBucketId)?.length ?? 0
        return (
          <div className="rounded-md border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-700">
              Delete bucket &ldquo;{bucket?.name}&rdquo;? {ruleCount > 0 ? `Its ${ruleCount} rule${ruleCount !== 1 ? 's' : ''} will be moved to the default bucket.` : ''}
            </p>
            <div className="mt-2 flex gap-2">
              <button onClick={() => handleDeleteBucket(deletingBucketId)} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">Delete</button>
              <button onClick={() => setDeletingBucketId(null)} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )
      })()}

      {/* No bucket match prompt */}
      {showNoBucketMatch && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            No existing bucket's auto-filter matches this rule's conditions. Would you like to create a new bucket for it?
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick={handleCreateBucketFromPrompt} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Create Bucket</button>
            <button onClick={() => { setShowNoBucketMatch(false); setPendingRuleConditions(null); }} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Skip</button>
          </div>
        </div>
      )}

      {/* Kanban board */}
      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 280px)' }}>
        {buckets.map((bucket, bucketIndex) => {
          const bucketRules = rulesByBucket.get(bucket.id) ?? []
          // Hide empty buckets when searching
          if (ruleSearch.trim() && bucketRules.length === 0) return null

          return (
            <div
              key={bucket.id}
              className="flex w-80 min-w-[320px] shrink-0 flex-col rounded-xl border border-gray-200 bg-gray-50"
            >
              {/* Column header */}
              <div
                draggable
                onDragStart={(e) => handleBucketDragStart(e, bucket.id)}
                onDragEnd={handleBucketDragEnd}
                onDragOver={handleBucketDragOver}
                onDrop={(e) => handleBucketDrop(e, bucket.id)}
                className="flex flex-col gap-1.5 rounded-t-xl bg-white px-3 py-3 border-b border-gray-200 cursor-grab active:cursor-grabbing select-none"
              >
                <div className="flex items-center gap-2">
                  {/* Drag handle */}
                  <svg className="h-3.5 w-3.5 text-gray-300 hover:text-gray-500 shrink-0" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>

                  {/* Bucket name */}
                  {editingBucketId === bucket.id ? (
                    <input
                      autoFocus
                      value={editingBucketName}
                      onChange={(e) => setEditingBucketName(e.target.value)}
                      onBlur={() => handleRenameBucket(bucket.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameBucket(bucket.id); if (e.key === 'Escape') setEditingBucketId(null); }}
                      className="min-w-0 flex-1 rounded border border-blue-300 px-1.5 py-0.5 text-xs font-semibold text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-800"
                      onDoubleClick={() => { setEditingBucketId(bucket.id); setEditingBucketName(bucket.name); }}
                      title={bucket.name}
                    >
                      {bucket.name}
                    </span>
                  )}

                  {/* Count + priority */}
                  <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-medium text-gray-600 shrink-0">
                    {bucketRules.length}
                  </span>
                  <span className="text-[9px] text-gray-400 shrink-0" title="Evaluation order">#{bucketIndex + 1}</span>
                </div>

                {/* Auto-filter + actions row */}
                <div className="flex items-center gap-1">
                  {bucket.groupedConditions && (
                    <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium text-indigo-600 truncate max-w-[160px]" title={formatGroupedFilter(bucket.groupedConditions)}>
                      {formatGroupedFilter(bucket.groupedConditions)}
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingBucketConditionsId(bucket.id)
                      setEditingBucketConditionsData(bucket.groupedConditions ?? { groupConnector: 'AND', groups: [makeEmptyGroup()] })
                    }}
                    className={`rounded p-0.5 ${bucket.groupedConditions ? 'text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                    title={bucket.groupedConditions ? 'Edit auto-filter' : 'Add auto-filter'}
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" /></svg>
                  </button>
                  <button
                    onClick={() => { setEditingBucketId(bucket.id); setEditingBucketName(bucket.name); }}
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    title="Rename"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
                  </button>
                  {!bucket.isDefault && (
                    <button
                      onClick={() => setDeletingBucketId(bucket.id)}
                      className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      title="Delete"
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Inline bucket conditions editor */}
              {editingBucketConditionsId === bucket.id && (
                <div className="border-b border-gray-200 bg-white px-2 py-2 space-y-1.5">
                  <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Auto-filter conditions</p>
                  <GroupedFilterBuilder
                    value={editingBucketConditionsData}
                    onChange={setEditingBucketConditionsData}
                    availableFields={filterFields}
                  />
                  <div className="flex gap-1.5 pt-1">
                    <button
                      onClick={() => handleUpdateBucketConditions(bucket.id, editingBucketConditionsData)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-blue-700"
                    >Save</button>
                    <button
                      onClick={() => handleUpdateBucketConditions(bucket.id, null)}
                      className="rounded-md border border-gray-300 px-2.5 py-1 text-[10px] text-gray-600 hover:bg-gray-50"
                    >Clear</button>
                    <button
                      onClick={() => setEditingBucketConditionsId(null)}
                      className="rounded-md border border-gray-300 px-2.5 py-1 text-[10px] text-gray-600 hover:bg-gray-50"
                    >Cancel</button>
                  </div>
                </div>
              )}

              {/* Card list */}
              <div
                className="flex-1 space-y-2 overflow-y-auto p-2"
                style={{ maxHeight: 'calc(100vh - 340px)' }}
                onDragOver={(e) => { if (dragTypeRef.current === 'rule') { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
                onDrop={(e) => handleRuleDropOnBucket(e, bucket.id)}
              >
                {bucketRules.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 px-3 py-8 text-center text-[11px] text-gray-400">
                    Drop rules here
                  </div>
                )}
                {bucketRules.map((rule) => (
                  <div
                    key={rule.id}
                    draggable
                    onDragStart={(e) => handleRuleDragStart(e, rule.id, bucket.id)}
                    onDragEnd={handleRuleDragEnd}
                    onDragOver={handleRuleDragOver}
                    onDrop={(e) => handleRuleDropOnRule(e, rule, bucketRules.map(r => r.id))}
                    className="group cursor-grab rounded-lg border border-gray-200 bg-white p-2.5 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
                  >
                    {/* Card header: name + actions */}
                    <div className="flex items-start gap-1.5">
                      <svg className="mt-0.5 h-3 w-3 shrink-0 text-gray-300 group-hover:text-gray-400" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900" title={rule.name}>
                        {rule.name}
                      </span>
                      <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEdit(rule)} className="rounded p-0.5 text-blue-500 hover:bg-blue-50" title="Edit">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
                        </button>
                        <button onClick={() => handleDelete(rule.id)} className="rounded p-0.5 text-red-400 hover:bg-red-50" title="Delete">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                        </button>
                      </div>
                    </div>

                    {/* Conditions summary */}
                    <p className="mt-1 text-[10px] leading-tight text-gray-500 line-clamp-2">
                      {formatConditionSummary(rule)}
                    </p>

                    {/* Target + badges */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="truncate rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 max-w-[200px]" title={getNodePath(rule.targetTaxonomyNodeId)}>
                        {getNodePath(rule.targetTaxonomyNodeId)}
                      </span>
                      <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                        rule.source === 'auto_generated'
                          ? 'bg-purple-50 text-purple-600'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {rule.source === 'auto_generated' ? 'Auto' : 'Manual'}
                      </span>
                      <button
                        onClick={() => handleToggle(rule)}
                        className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                          rule.isActive
                            ? 'bg-green-50 text-green-600'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {rule.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {/* Add bucket column */}
        {showNewBucketInput ? (
          <div className="flex w-80 min-w-[320px] shrink-0 flex-col rounded-xl border border-dashed border-gray-300 bg-gray-50 overflow-hidden">
            <div className="border-b border-gray-200 bg-white px-3 py-2.5 space-y-2">
              <input
                autoFocus
                value={newBucketName}
                onChange={(e) => setNewBucketName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newBucketName.trim()) handleCreateBucket(); if (e.key === 'Escape') { setShowNewBucketInput(false); setNewBucketName(''); } }}
                placeholder="Bucket name..."
                className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <div className="flex gap-1.5">
                <button onClick={handleCreateBucket} className="flex-1 rounded-md bg-blue-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Create</button>
                <button onClick={() => { setShowNewBucketInput(false); setNewBucketName(''); setNewBucketConditions({ groupConnector: 'AND', groups: [makeEmptyGroup()] }); }} className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
              </div>
            </div>
            {/* Inline condition builder */}
            <div className="flex-1 overflow-y-auto p-2">
              <p className="mb-1.5 text-[10px] font-medium text-gray-500 uppercase tracking-wide">Auto-filter conditions</p>
              <GroupedFilterBuilder
                value={newBucketConditions}
                onChange={setNewBucketConditions}
                availableFields={filterFields}
              />
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowNewBucketInput(true)}
            className="flex w-16 min-w-[64px] shrink-0 items-center justify-center rounded-xl border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-500 hover:bg-gray-50 transition-colors"
            title="Add bucket"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          </button>
        )}
      </div>

      {rules.length === 0 && buckets.length <= 1 && (
        <div className="text-center py-8 text-gray-500 text-sm">
          No override rules yet. Create buckets to organize your rules, then add rules to classify vendors.
        </div>
      )}
    </div>
  )
}
