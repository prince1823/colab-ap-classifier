import DependencyGate from '../components/DependencyGate'
import SuppliersPage from '../pages/SuppliersPage'
import { useWorkflowStore } from '../stores/workflowStore'

export default function SuppliersView() {
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)

  return (
    <DependencyGate
      requires={[
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
