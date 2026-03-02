import { useState } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { clsx } from 'clsx'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ArrowUpTrayIcon,
  AdjustmentsHorizontalIcon,
  TableCellsIcon,
  CpuChipIcon,
  MagnifyingGlassCircleIcon,
  ArrowDownTrayIcon,
  BookOpenIcon,
  BuildingOfficeIcon,
  TruckIcon,
  DocumentDuplicateIcon,
  ClockIcon,
  SparklesIcon,
  ChartBarSquareIcon,
  Cog6ToothIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import SettingsDialog from './SettingsDialog'
import { useWorkflowState } from '../contexts/WorkflowStateContext'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

const projectViews = [
  { path: '/project/taxonomy', label: 'Taxonomy', icon: BookOpenIcon },
  { path: '/project/company-context', label: 'Company Context', icon: BuildingOfficeIcon },
  { path: '/project/suppliers', label: 'Suppliers', icon: TruckIcon },
  { path: '/project/override-rules', label: 'Override Rules', icon: DocumentDuplicateIcon },
  { path: '/project/pivot', label: 'Pivot', icon: ChartBarSquareIcon },
  { path: '/project/feedback', label: 'Feedback', icon: SparklesIcon },
  { path: '/project/version-history', label: 'Version History', icon: ClockIcon },
]

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const [showSettings, setShowSettings] = useState(false)
  const ws = useWorkflowState()
  const navigate = useNavigate()
  const location = useLocation()

  const pipelineSteps = [
    {
      path: '/workflow/upload',
      label: 'Upload',
      icon: ArrowUpTrayIcon,
      step: 1,
      disabled: !ws.hasProject,
      completed: ws.hasUploadedData,
      tooltip: !ws.hasProject ? 'Open or create a project first' : '',
    },
    {
      path: '/workflow/canonicalization',
      label: 'Canonicalization',
      icon: AdjustmentsHorizontalIcon,
      step: 2,
      disabled: !ws.hasProject,
      completed: ws.hasCanonicalizedData,
      tooltip: !ws.hasProject ? 'Open or create a project first' : '',
    },
    {
      path: '/workflow/data-review',
      label: 'Data Review',
      icon: TableCellsIcon,
      step: 3,
      disabled: !ws.hasCanonicalizedData,
      completed: ws.hasReviewedData || ws.hasClassifiedData,
      tooltip: !ws.hasCanonicalizedData ? 'Upload and canonicalize data first' : '',
    },
    {
      path: '/workflow/classification',
      label: 'Classification',
      icon: CpuChipIcon,
      step: 4,
      disabled: !(ws.hasCanonicalizedData && ws.hasTaxonomy),
      completed: ws.hasClassifiedData,
      tooltip: !(ws.hasCanonicalizedData && ws.hasTaxonomy) ? 'Requires canonicalized data and taxonomy' : '',
    },
    {
      path: '/workflow/review',
      label: 'Review',
      icon: MagnifyingGlassCircleIcon,
      step: 5,
      disabled: !ws.hasClassifiedData,
      completed: false,
      tooltip: !ws.hasClassifiedData ? 'Classify data first' : '',
    },
    {
      path: '/workflow/output',
      label: 'Output',
      icon: ArrowDownTrayIcon,
      step: 6,
      disabled: !ws.hasClassifiedData,
      completed: false,
      tooltip: !ws.hasClassifiedData ? 'Classify data first' : '',
    },
  ]

  const handleStepClick = (step: typeof pipelineSteps[0], e: React.MouseEvent) => {
    if (step.disabled) {
      e.preventDefault()
      return
    }
    navigate(step.path)
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
          {/* Header with toggle */}
          <div className="flex h-12 items-center justify-between border-b border-gray-200 px-4">
            {!collapsed && <h2 className="text-sm font-semibold text-gray-700">Navigation</h2>}
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

          {/* Scrollable nav area */}
          <nav className="flex-1 overflow-y-auto">
            {/* Pipeline section */}
            <div className="p-2">
              {!collapsed && (
                <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  Pipeline
                </h3>
              )}
              <ul className="space-y-0.5">
                {pipelineSteps.map((step, index) => {
                  const isActive = location.pathname === step.path
                  const isCompleted = step.completed && !isActive
                  const Icon = step.icon
                  const isLast = index === pipelineSteps.length - 1

                  const stepContent = (
                    <li key={step.path} className="relative">
                      {/* Connecting line */}
                      {!isLast && !collapsed && (
                        <div
                          className="absolute left-[19px] top-[36px] h-[calc(100%-8px)] w-0.5 bg-gray-200"
                          aria-hidden="true"
                        />
                      )}

                      <NavLink
                        to={step.path}
                        onClick={(e) => handleStepClick(step, e)}
                        className={clsx(
                          'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-blue-50 text-blue-700'
                            : step.disabled
                            ? 'text-gray-300 cursor-not-allowed'
                            : isCompleted
                            ? 'text-gray-700 hover:bg-gray-100'
                            : 'text-gray-700 hover:bg-gray-100',
                          collapsed && 'justify-center px-0'
                        )}
                      >
                        {/* Step number circle */}
                        <div
                          className={clsx(
                            'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                            isActive && 'bg-blue-100 text-blue-700 ring-2 ring-blue-400',
                            isCompleted && 'bg-green-50 text-green-600',
                            step.disabled && !isActive && 'bg-gray-100 text-gray-300',
                            !isActive && !isCompleted && !step.disabled && 'bg-gray-100 text-gray-600'
                          )}
                        >
                          {isCompleted ? (
                            <CheckIcon className="h-3.5 w-3.5" />
                          ) : (
                            step.step
                          )}
                        </div>

                        {/* Label + icon */}
                        {!collapsed && (
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 flex-shrink-0" />
                            <span>{step.label}</span>
                          </div>
                        )}
                      </NavLink>
                    </li>
                  )

                  // Wrap in tooltip when collapsed or disabled
                  if (collapsed || (step.disabled && step.tooltip)) {
                    const tooltipText = step.disabled && step.tooltip
                      ? step.tooltip
                      : step.label

                    return (
                      <Tooltip.Root key={step.path}>
                        <Tooltip.Trigger asChild>{stepContent}</Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg z-50"
                            side="right"
                            sideOffset={8}
                          >
                            {tooltipText}
                            <Tooltip.Arrow className="fill-gray-900" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    )
                  }

                  return stepContent
                })}
              </ul>
            </div>

            {/* Divider */}
            <div className="mx-3 border-t border-gray-200" />

            {/* Project Setup section */}
            <div className="p-2">
              {!collapsed && (
                <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  Project Setup
                </h3>
              )}
              <ul className="space-y-0.5">
                {projectViews.map((view) => {
                  const Icon = view.icon

                  const viewContent = (
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

                  if (collapsed) {
                    return (
                      <Tooltip.Root key={view.path}>
                        <Tooltip.Trigger asChild>{viewContent}</Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg z-50"
                            side="right"
                            sideOffset={8}
                          >
                            {view.label}
                            <Tooltip.Arrow className="fill-gray-900" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    )
                  }

                  return viewContent
                })}
              </ul>
            </div>
          </nav>

          {/* LLM Settings button at bottom */}
          <div className="border-t border-gray-200 p-2">
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  onClick={() => setShowSettings(true)}
                  className={clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full text-gray-700 hover:bg-gray-100',
                    collapsed && 'justify-center'
                  )}
                  title={collapsed ? undefined : 'LLM Settings'}
                >
                  <Cog6ToothIcon className="h-5 w-5 flex-shrink-0" />
                  {!collapsed && <span>LLM Settings</span>}
                </button>
              </Tooltip.Trigger>
              {collapsed && (
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white shadow-lg z-50"
                    side="right"
                    sideOffset={8}
                  >
                    LLM Settings
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
