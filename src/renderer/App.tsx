import { Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './components/AppShell'
import ReviewPage from './pages/ReviewPage'
import UploadPage from './pages/UploadPage'
import DataReviewPage from './pages/DataReviewPage'
import ClassificationPage from './pages/ClassificationPage'
import OutputPage from './pages/OutputPage'
import TaxonomyPage from './pages/TaxonomyPage'
import CompanyContextPage from './pages/CompanyContextPage'
import SuppliersPage from './pages/SuppliersPage'
import OverrideRulesPage from './pages/OverrideRulesPage'
import VersionHistoryPage from './pages/VersionHistoryPage'
import PivotPage from './pages/PivotPage'
import ProtectedRoute from './components/ProtectedRoute'

function App() {
  return (
      <Routes>
        <Route path="/" element={<AppShell />}>
          {/* Default → Upload (step 3) */}
          <Route index element={<Navigate to="/workflow/upload" replace />} />

          {/* Workflow steps */}
          <Route
            path="workflow/upload"
            element={
              <ProtectedRoute>
                <UploadPage />
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
          <Route
            path="workflow/review"
            element={
              <ProtectedRoute>
                <ReviewPage />
              </ProtectedRoute>
            }
          />
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
            path="project/details"
            element={
              <ProtectedRoute>
                <CompanyContextPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="project/taxonomy"
            element={
              <ProtectedRoute>
                <TaxonomyPage />
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
          <Route
            path="workflow/pivot"
            element={
              <ProtectedRoute>
                <PivotPage />
              </ProtectedRoute>
            }
          />
        </Route>
      </Routes>
  )
}

export default App
