import React, { useState, useMemo, useEffect } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { useClassifiedCsv } from '../hooks/useClassifiedCsv'
import Dashboard from '../components/review/Dashboard'

const DashboardContent = () => {
  const { rows, loading, error } = useClassifiedCsv()
  
  // Transform rows to match expected format
  const initialTransactions = useMemo(() => {
    return rows.map((row, idx) => {
      // Ensure gl_description comes from the CSV gl_description column, not line_description
      const glDescription = row.raw['gl_description'] || row.raw['GL Description'] || '';
      
      return {
        ...row.raw,
        supplier_name: row.supplierName,
        gl_description: glDescription, // Use gl_description from CSV, not lineDescription
        classification_path: [row.l1, row.l2, row.l3, row.l4].filter(Boolean).join('|'),
        taxonomy_path: [row.l1, row.l2, row.l3, row.l4].filter(Boolean).join('|'),
        L1: row.l1,
        L2: row.l2,
        L3: row.l3,
        L4: row.l4,
        amount: row.spendAmount,
        invoice_amount: row.spendAmount,
        review_score: row.reviewScore,
        row_index: idx,
      }
    })
  }, [rows])

  // Local state for transactions (can be updated by reclassification)
  const [transactions, setTransactions] = useState(initialTransactions)
  
  // Update transactions when rows change
  useEffect(() => {
    setTransactions(initialTransactions)
  }, [initialTransactions])

  const datasetId = 'default'
  const foldername = 'default'
  const setDatasetId = () => {}
  const setFoldername = () => {}
  const refreshTransactions = () => {}

  return (
    <Dashboard
      transactions={transactions}
      loading={loading}
      error={error}
      datasetId={datasetId}
      setDatasetId={setDatasetId}
      foldername={foldername}
      setFoldername={setFoldername}
      refreshTransactions={refreshTransactions}
      setTransactions={setTransactions}
    />
  )
}

export default function ReviewPage() {
  return (
    <DndProvider backend={HTML5Backend}>
      <DashboardContent />
    </DndProvider>
  )
}
