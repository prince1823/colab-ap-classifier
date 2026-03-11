import { Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './components/AppShell'
import ProjectView from './views/ProjectView'
import TaxonomyView from './views/TaxonomyView'
import DataView from './views/DataView'
import SuppliersView from './views/SuppliersView'
import ClassificationView from './views/ClassificationView'
import ReviewView from './views/ReviewView'
import OverrideRulesView from './views/OverrideRulesView'
import VersionHistoryView from './views/VersionHistoryView'

function App() {
  return (
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<Navigate to="/project" replace />} />
          <Route path="project" element={<ProjectView />} />
          <Route path="taxonomy" element={<TaxonomyView />} />
          <Route path="data" element={<DataView />} />
          <Route path="suppliers" element={<SuppliersView />} />
          <Route path="classification" element={<ClassificationView />} />
          <Route path="review" element={<ReviewView />} />
          <Route path="override-rules" element={<OverrideRulesView />} />
          <Route path="version-history" element={<VersionHistoryView />} />
        </Route>
      </Routes>
  )
}

export default App
