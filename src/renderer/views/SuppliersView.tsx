import DependencyGate from '../components/DependencyGate'
import SuppliersPage from '../pages/SuppliersPage'
import { useWorkflowStore } from '../stores/workflowStore'

export default function SuppliersView() {
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)
  const hasTaxonomy = useWorkflowStore((s) => s.hasTaxonomy)

  return (
    <DependencyGate
      requires={[
        {
          met: hasTaxonomy,
          message: 'Import a taxonomy before managing suppliers.',
          linkTo: '/taxonomy',
          linkLabel: 'Go to Taxonomy',
        },
        {
          met: hasUploadedData,
          message: 'Upload transaction data before managing suppliers.',
          linkTo: '/data',
          linkLabel: 'Go to Data',
        },
      ]}
    >
      <SuppliersPage />
    </DependencyGate>
  )
}
