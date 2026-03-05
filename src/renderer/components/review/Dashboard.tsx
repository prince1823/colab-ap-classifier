import React, { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import TablesTab from './TablesTab'
import MetricsTabContainer from './MetricsTabContainer'
import ReclassifyConfirmModal from './ReclassifyConfirmModal'
import { X, CheckCircle } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import { useReclassification } from '../../hooks/useReclassification'
import { useUndoRedo } from '../../hooks/useUndoRedo'
import type { DashboardTransactionRow } from '../../utils/transactionTransform'
import '../../styles/Dashboard.css'
import '../../styles/Tabs.css'

interface DashboardProps {
  transactions: DashboardTransactionRow[];
  loading: boolean;
  error: string | null;
  datasetId: string | null;
  setDatasetId: (id: string | null) => void;
  foldername: string | null;
  setFoldername: (name: string | null) => void;
  refreshTransactions: (() => Promise<void>) | null;
}

const Dashboard = ({ transactions, loading, error, datasetId, foldername, refreshTransactions }: DashboardProps) => {
  const [showDashboardModal, setShowDashboardModal] = useState(false)
  const [pendingReclassification, setPendingReclassification] = useState<{ transactionIds: string[]; targetPath: string } | null>(null)
  const [reclassToast, setReclassToast] = useState<{ show: boolean; rowCount: number; targetPath: string; undoable: boolean }>({ show: false, rowCount: 0, targetPath: '', undoable: false })
  const reclassToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ref so TablesTab can register its refetch — called after reclassification
  const refetchGroupedRef = useRef<(() => void) | null>(null)
  const registerRefetchGrouped = useCallback((fn: () => void) => {
    refetchGroupedRef.current = fn
  }, [])

  const undoRedo = useUndoRedo({
    onUndoRedo: async () => {
      if (refreshTransactions) await refreshTransactions()
      refetchGroupedRef.current?.()
    },
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { reclassify, isReclassifying } = useReclassification({
    onSuccess: async () => {
      if (refreshTransactions) await refreshTransactions()
      refetchGroupedRef.current?.()
    },
  })

  const executeReclassification = useCallback(async (transactionIds: string[], targetPath: string): Promise<boolean> => {
    if (transactionIds.length === 0) return false
    try {
      const taxonomyNodes = await ipc.taxonomy.getNodes()
      const cleanPath = targetPath.replace(/^root\|/, '')
      const targetNode = taxonomyNodes.find((n) => n.fullPath === cleanPath)
      if (!targetNode) {
        console.warn(`[Reclassify] No taxonomy node found for path: ${cleanPath}`)
        return false
      }

      await ipc.transactions.update({
        ids: transactionIds,
        taxonomyNodeId: targetNode.id,
        classificationStatus: 'classified_by_ai',
      })

      try {
        const changelog = await ipc.changelog.list()
        if (changelog.length > 0) {
          undoRedo.push({ type: 'reclassify', changelogId: changelog[0].id })
        }
      } catch (e) {
        console.warn('[Undo] Failed to capture changelog entry:', e)
      }

      if (refreshTransactions) await refreshTransactions()
      refetchGroupedRef.current?.()

      const displayPath = cleanPath.replace(/\|/g, ' → ')
      if (reclassToastTimer.current) clearTimeout(reclassToastTimer.current)
      setReclassToast({ show: true, rowCount: transactionIds.length, targetPath: displayPath, undoable: true })
      reclassToastTimer.current = setTimeout(() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false }), 5000)

      return true
    } catch (err) {
      console.error('Failed to reclassify:', err)
      return false
    }
  }, [refreshTransactions, undoRedo])

  const handleConfirmReclassify = useCallback(async () => {
    if (!pendingReclassification) return
    const { transactionIds, targetPath } = pendingReclassification
    setPendingReclassification(null)
    await executeReclassification(transactionIds, targetPath)
  }, [pendingReclassification, executeReclassification])

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading classification data...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <h2>Error Loading Data</h2>
        <p>{error}</p>
        <p style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
          Please try reopening the project or restarting the application.
        </p>
      </div>
    )
  }

  if (!transactions || transactions.length === 0) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading classification data...</p>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <div className="content-container">
        <TablesTab
          transactions={transactions}
          onReclassify={executeReclassification}
          onOpenMetrics={() => setShowDashboardModal(true)}
          onRegisterRefetchGrouped={registerRefetchGrouped}
        />
      </div>

      {pendingReclassification && (
        <ReclassifyConfirmModal
          rowCount={pendingReclassification.transactionIds.length}
          targetPath={pendingReclassification.targetPath}
          onConfirm={handleConfirmReclassify}
          onCancel={() => setPendingReclassification(null)}
        />
      )}

      {showDashboardModal && (
        <>
          <div className="dashboard-modal-backdrop" onClick={() => setShowDashboardModal(false)} />
          <div className="dashboard-modal">
            <div className="dashboard-modal-header">
              <h2>Dashboard</h2>
              <button className="dashboard-modal-close" onClick={() => setShowDashboardModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="dashboard-modal-content">
              <MetricsTabContainer onClose={() => setShowDashboardModal(false)} />
            </div>
          </div>
        </>
      )}

      {reclassToast.show && createPortal(
        <div className="reclass-toast">
          <CheckCircle size={16} />
          <span>
            Reclassified <strong>{reclassToast.rowCount}</strong> row{reclassToast.rowCount !== 1 ? 's' : ''} → <strong>{reclassToast.targetPath}</strong>
          </span>
          {reclassToast.undoable && <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '8px' }}>Ctrl+Z to undo</span>}
          <button className="reclass-toast-close" onClick={() => setReclassToast({ show: false, rowCount: 0, targetPath: '', undoable: false })}>
            <X size={14} />
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

export default Dashboard
