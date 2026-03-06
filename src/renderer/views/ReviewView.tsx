import DependencyGate from '../components/DependencyGate'
import ReviewPage from '../pages/ReviewPage'
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
      <ReviewPage />
    </DependencyGate>
  )
}
