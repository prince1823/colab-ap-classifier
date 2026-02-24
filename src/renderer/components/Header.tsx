import ProjectSelector from './ProjectSelector'

export default function Header() {
  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6 shadow-sm">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold text-gray-900">AP Classifier</h1>
        <div className="h-6 w-px bg-gray-300" />
        <ProjectSelector />
      </div>
    </header>
  )
}
