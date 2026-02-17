import { NavLink } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  BookOpenIcon,
  BuildingOfficeIcon,
  TruckIcon,
  DocumentDuplicateIcon,
  ClockIcon,
  SparklesIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

const projectViews = [
  { path: '/project/taxonomy', label: 'Taxonomy', icon: BookOpenIcon },
  { path: '/project/company-context', label: 'Company Context', icon: BuildingOfficeIcon },
  { path: '/project/suppliers', label: 'Suppliers', icon: TruckIcon },
  { path: '/project/override-rules', label: 'Override Rules', icon: DocumentDuplicateIcon },
  { path: '/project/version-history', label: 'Version History', icon: ClockIcon },
  { path: '/project/feedback', label: 'Feedback', icon: SparklesIcon },
  { path: '/project/pivot', label: 'Pivot', icon: TableCellsIcon },
]

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={clsx(
        'flex flex-col border-r border-gray-200 bg-white transition-all duration-300',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className="flex h-12 items-center justify-between border-b border-gray-200 px-4">
        {!collapsed && <h2 className="text-sm font-semibold text-gray-700">Project Views</h2>}
        <button
          onClick={onToggle}
          className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRightIcon className="h-5 w-5" />
          ) : (
            <ChevronLeftIcon className="h-5 w-5" />
          )}
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {projectViews.map((view) => {
            const Icon = view.icon
            return (
              <li key={view.path}>
                <NavLink
                  to={view.path}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-700 hover:bg-gray-100',
                      collapsed && 'justify-center'
                    )
                  }
                >
                  <Icon className="h-5 w-5 flex-shrink-0" />
                  {!collapsed && <span>{view.label}</span>}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}
