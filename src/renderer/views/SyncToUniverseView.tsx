import DependencyGate from '../components/DependencyGate'
import SyncToUniversePage from '../pages/SyncToUniversePage'
import { useWorkflowStore } from '../stores/workflowStore'

export default function SyncToUniverseView() {
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)

  return (
    <DependencyGate
      requires={[
        {
          met: hasUploadedData,
          message: 'Upload transaction data before syncing suppliers.',
          linkTo: '/data',
          linkLabel: 'Go to Data',
        },
      ]}
    >
      <SyncToUniversePage />
    </DependencyGate>
  )
}
