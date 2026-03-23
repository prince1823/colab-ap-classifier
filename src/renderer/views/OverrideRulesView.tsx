import DependencyGate from '../components/DependencyGate'
import ErrorBoundary from '../components/review/ErrorBoundary'
import OverrideRulesPage from '../pages/OverrideRulesPage'
import { useWorkflowStore } from '../stores/workflowStore'

export default function OverrideRulesView() {
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)

  return (
    <DependencyGate
      requires={[
        {
          met: hasUploadedData,
          message: 'Upload transaction data before configuring override rules.',
          linkTo: '/data',
          linkLabel: 'Go to Data',
        },
      ]}
    >
      <ErrorBoundary>
        <OverrideRulesPage />
      </ErrorBoundary>
    </DependencyGate>
  )
}
