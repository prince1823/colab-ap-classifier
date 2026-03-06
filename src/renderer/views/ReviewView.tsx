import DependencyGate from '../components/DependencyGate'
import PivotPage from '../pages/PivotPage'
import { useWorkflowStore } from '../stores/workflowStore'

export default function ReviewView() {
  const hasClassifiedRows = useWorkflowStore((s) => s.hasClassifiedRows)

  return (
    <DependencyGate
      requires={[
        {
          met: hasClassifiedRows,
          message: 'Run classification before reviewing results.',
          linkTo: '/classification',
          linkLabel: 'Go to Classification',
        },
      ]}
    >
      <PivotPage />
    </DependencyGate>
  )
}
