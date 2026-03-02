import type { TransactionStats } from '../../../shared/types/transactions'
import { fmtAbbrev } from '../../utils/formatSpend'

interface Props {
  stats: TransactionStats
}

export default function StatsCards({ stats }: Props) {
  const cards = [
    { label: 'Total Rows', value: stats.totalRows.toLocaleString() },
    {
      label: 'Total Spend',
      value: fmtAbbrev(stats.totalSpend),
    },
    { label: 'Unique Suppliers', value: stats.uniqueSuppliers.toLocaleString() },
    { label: 'Classified', value: stats.classifiedRows.toLocaleString() },
    { label: 'Flagged for Review', value: stats.flaggedForReviewRows.toLocaleString() },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-gray-500">{card.label}</p>
          <p className="mt-1 text-xl font-semibold text-gray-900">{card.value}</p>
        </div>
      ))}
    </div>
  )
}
