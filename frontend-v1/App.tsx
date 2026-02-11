import { Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './components/AppShell'
import ReviewPage from './pages/ReviewPage'
import { WorkflowStateProvider } from './contexts/WorkflowStateContext'
import ProtectedRoute from './components/ProtectedRoute'

// "Coming soon" message for workflow tabs other than Review
const ComingSoonPage = ({ title }: { title?: string }) => (
  <div className="flex flex-1 items-center justify-center bg-gray-50 p-8">
    <div className="text-center">
      <p className="text-2xl font-semibold text-gray-700">Coming soon</p>
      {title && (
        <p className="mt-2 text-gray-500">{title}</p>
      )}
    </div>
  </div>
)

// Placeholder pages for workflow tabs (except Review, which uses ReviewPage)
const UploadPage = () => <ComingSoonPage title="Upload" />
const CanonicalizationPage = () => <ComingSoonPage title="Canonicalization" />
const DataReviewPage = () => <ComingSoonPage title="Data Review" />
const ClassificationPage = () => <ComingSoonPage title="Classification" />
const OutputPage = () => <ComingSoonPage title="Output" />

// Placeholder pages for project views
const TaxonomyPage = () => <div className="p-8">Taxonomy Page</div>
const CompanyContextPage = () => <div className="p-8">Company Context Page</div>
const SuppliersPage = () => <div className="p-8">Suppliers Page</div>
const OverrideRulesPage = () => <div className="p-8">Override Rules Page</div>
const VersionHistoryPage = () => <div className="p-8">Version History Page</div>

function App() {
  return (
    <WorkflowStateProvider>
      <Routes>
        <Route path="/" element={<AppShell />}>
          {/* Workflow tabs */}
          <Route index element={<Navigate to="/workflow/review" replace />} />
          <Route
            path="workflow/upload"
            element={
              <ProtectedRoute>
                <UploadPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="workflow/canonicalization"
            element={
              <ProtectedRoute>
                <CanonicalizationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="workflow/data-review"
            element={
              <ProtectedRoute>
                <DataReviewPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="workflow/classification"
            element={
              <ProtectedRoute>
                <ClassificationPage />
              </ProtectedRoute>
            }
          />
          <Route path="workflow/review" element={<ReviewPage />} />
          <Route
            path="workflow/output"
            element={
              <ProtectedRoute>
                <OutputPage />
              </ProtectedRoute>
            }
          />

          {/* Project views */}
          <Route
            path="project/taxonomy"
            element={
              <ProtectedRoute>
                <TaxonomyPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="project/company-context"
            element={
              <ProtectedRoute>
                <CompanyContextPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="project/suppliers"
            element={
              <ProtectedRoute>
                <SuppliersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="project/override-rules"
            element={
              <ProtectedRoute>
                <OverrideRulesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="project/version-history"
            element={
              <ProtectedRoute>
                <VersionHistoryPage />
              </ProtectedRoute>
            }
          />
        </Route>
      </Routes>
    </WorkflowStateProvider>
  )
}

export default App
