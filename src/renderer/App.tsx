import { Routes, Route, Navigate } from 'react-router-dom'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import ErrorBoundary from './components/review/ErrorBoundary'
import AppShell from './components/AppShell'
import LicenseGate from './components/LicenseGate'

function App() {
  return (
    <ErrorBoundary>
    <DndProvider backend={HTML5Backend}>
    <LicenseGate>
      <Routes>
        <Route path="/" element={<Navigate to="/project" replace />} />
        <Route path="*" element={<AppShell />} />
      </Routes>
    </LicenseGate>
    </DndProvider>
    </ErrorBoundary>
  )
}

export default App
