import DependencyGate from '../components/DependencyGate'
import ClassificationPage from '../pages/ClassificationPage'
import { useWorkflowStore } from '../stores/workflowStore'

export default function ClassificationView() {
  const hasTaxonomy = useWorkflowStore((s) => s.hasTaxonomy)
  const hasConfirmedSuppliers = useWorkflowStore((s) => s.hasConfirmedSuppliers)

  return (
    <DependencyGate
      requires={[
        {
          met: hasTaxonomy,
          message: 'Import a taxonomy before running classification.',
          linkTo: '/taxonomy',
          linkLabel: 'Go to Taxonomy',
        },
        {
          met: hasConfirmedSuppliers,
          message: 'Confirm at least one supplier before running classification.',
          linkTo: '/suppliers',
          linkLabel: 'Go to Suppliers',
        },
      ]}
    >
      <ClassificationPage />
    </DependencyGate>
  )
}
