import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { clsx } from 'clsx'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  BuildingOfficeIcon,
  BookOpenIcon,
  ArrowUpTrayIcon,
  TruckIcon,
  CpuChipIcon,
  MagnifyingGlassCircleIcon,
  DocumentDuplicateIcon,
  ClockIcon,
  Cog6ToothIcon,
  ArrowsRightLeftIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import SettingsDialog from './SettingsDialog'
import { useWorkflowStore } from '../stores/workflowStore'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onSwitchProject: () => void
}

const navItems = [
  { path: '/project', label: 'Project', icon: BuildingOfficeIcon, gateKey: null },
  { path: '/taxonomy', label: 'Taxonomy', icon: BookOpenIcon, gateKey: null },
  { path: '/data', label: 'Data', icon: ArrowUpTrayIcon, gateKey: null },
  { path: '/suppliers', label: 'Suppliers', icon: TruckIcon, gateKey: 'hasSupplierDeps' as const },
  { path: '/classification', label: 'Classification', icon: CpuChipIcon, gateKey: 'hasClassificationDeps' as const },
  { path: '/review', label: 'Review', icon: MagnifyingGlassCircleIcon, gateKey: 'hasClassifiedRows' as const },
  { path: '/override-rules', label: 'Override Rules', icon: DocumentDuplicateIcon, gateKey: 'hasUploadedData' as const },
  { path: '/version-history', label: 'Version History', icon: ClockIcon, gateKey: null },
]

export default function Sidebar({ collapsed, onToggle, onSwitchProject }: SidebarProps) {
  const [showSettings, setShowSettings] = useState(false)
  const projectMetadata = useWorkflowStore((s) => s.projectMetadata)
  const hasUploadedData = useWorkflowStore((s) => s.hasUploadedData)
  const hasTaxonomy = useWorkflowStore((s) => s.hasTaxonomy)
  const hasConfirmedSuppliers = useWorkflowStore((s) => s.hasConfirmedSuppliers)
  const hasClassifiedRows = useWorkflowStore((s) => s.hasClassifiedRows)
  const location = useLocation()

  const gatesMet: Record<string, boolean> = {
    hasUploadedData,
    hasSupplierDeps: hasTaxonomy && hasUploadedData,
    hasClassificationDeps: hasTaxonomy && hasConfirmedSuppliers,
    hasClassifiedRows,
  }

  return (
    <>
      <Tooltip.Provider delayDuration={300}>
        <aside
          className={clsx(
            'flex flex-col border-r border-gray-200 bg-white transition-all duration-300',
            collapsed ? 'w-16' : 'w-64'
          )}
        >
          {/* Project name + switch at top */}
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-3">
            {!collapsed && (
              <div className="flex-1 min-w-0 mr-2">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {projectMetadata?.projectName ?? 'No Project'}
                </p>
                <button
                  onClick={onSwitchProject}
                  className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600"
                >
                  <ArrowsRightLeftIcon className="h-3 w-3" />
                  Switch
                </button>
              </div>
            )}
            <button
              onClick={onToggle}
              className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 flex-shrink-0"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <ChevronRightIcon className="h-5 w-5" />
              ) : (
                <ChevronLeftIcon className="h-5 w-5" />
              )}
            </button>
          </div>

          {/* Nav items */}
          <nav className="flex-1 overflow-y-auto p-2">
            <ul className="space-y-0.5">
              {navItems.map((item) => {
                const Icon = item.icon
                const isActive = location.pathname === item.path
                const gateUnmet = item.gateKey ? !gatesMet[item.gateKey] : false

                const itemContent = (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      className={clsx(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-700 hover:bg-gray-100',
                        collapsed && 'justify-center'
                      )}
                    >
                      <div className="relative flex-shrink-0">
                        <Icon className="h-5 w-5" />
                        {gateUnmet && !collapsed && (
                          <ExclamationTriangleIcon className="absolute -right-1.5 -top-1.5 h-3.5 w-3.5 text-amber-500" />
                        )}
                      </div>
                      {!collapsed && (
                        <span className="flex-1">{item.label}</span>
                      )}
                      {!collapsed && gateUnmet && (
                        <span className="text-[10px] font-bold text-amber-500">[!]</span>
                      )}
                    </NavLink>
                  </li>
                )

                if (collapsed) {
                  return (
                    <Tooltip.Root key={item.path}>
                      <Tooltip.Trigger asChild>{itemContent}</Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg z-50"
                          side="right"
                          sideOffset={8}
                        >
                          {item.label}
                          {gateUnmet && ' [!]'}
                          <Tooltip.Arrow className="fill-gray-900" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  )
                }

                return itemContent
              })}
            </ul>
          </nav>

          {/* Settings button at bottom */}
          <div className="border-t border-gray-200 p-2">
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  onClick={() => setShowSettings(true)}
                  className={clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full text-gray-700 hover:bg-gray-100',
                    collapsed && 'justify-center'
                  )}
                >
                  <Cog6ToothIcon className="h-5 w-5 flex-shrink-0" />
                  {!collapsed && <span>Settings</span>}
                </button>
              </Tooltip.Trigger>
              {collapsed && (
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg z-50"
                    side="right"
                    sideOffset={8}
                  >
                    Settings
                    <Tooltip.Arrow className="fill-gray-900" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              )}
            </Tooltip.Root>
          </div>
        </aside>
      </Tooltip.Provider>
      <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  )
}
