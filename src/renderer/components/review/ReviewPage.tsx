import React, { useMemo, useState } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useClassifiedCsv } from './useClassifiedCsv';
import type {
  ColumnConfig,
  LogicalOperator,
  TableFilter,
  FilterOperator,
  ReviewRow,
  MetricsSummary,
} from './types';
import './review.css';

const FLAGGED_THRESHOLD_DEFAULT = 50;
const TAIL_SPEND_DEFAULT = 10000;

const AVAILABLE_COLUMNS: ColumnConfig[] = [
  {
    id: 'supplierName',
    label: 'Supplier Name',
    accessorKey: 'supplierName',
    isDefault: true,
  },
  {
    id: 'lineDescription',
    label: 'Line Description',
    accessorKey: 'lineDescription',
    isDefault: true,
  },
  {
    id: 'classificationPath',
    label: 'Classification (L1/L2/L3/L4)',
    accessorKey: 'classificationPath',
    isDefault: true,
  },
  {
    id: 'spendAmount',
    label: 'Spend Amount',
    accessorKey: 'spendAmount',
    isDefault: true,
  },
  {
    id: 'reviewScore',
    label: 'Review Score',
    accessorKey: 'reviewScore',
  },
];

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'greater_than', label: 'Greater than' },
  { value: 'less_than', label: 'Less than' },
  { value: 'in', label: 'In (comma-separated)' },
];

const LOGICAL_OPERATORS: LogicalOperator[] = ['AND', 'OR'];

let filterIdCounter = 0;

function createFilterFromDrag(columnId: string, value: string): TableFilter {
  return {
    id: `f-${filterIdCounter++}`,
    columnId,
    operator: 'equals',
    value,
  };
}

function applyFilters(
  rows: ReviewRow[],
  filters: TableFilter[],
  logic: LogicalOperator,
  reviewScoreRange: [number, number],
  flaggedOnly: boolean,
  flaggedThreshold: number,
  hideTailSpend: boolean,
  supplierSpend: Record<string, number>,
  tailSpendThreshold: number,
): { filteredRows: ReviewRow[]; metrics: MetricsSummary } {
  const [minScore, maxScore] = reviewScoreRange;

  const basePredicate = (row: ReviewRow): boolean => {
    const filterMatches = filters.map((f) => {
      const rawValue =
        f.columnId === 'supplierName'
          ? row.supplierName
          : f.columnId === 'lineDescription'
            ? row.lineDescription
            : f.columnId === 'classificationPath'
              ? row.classificationPath
              : f.columnId === 'spendAmount'
                ? String(row.spendAmount)
                : f.columnId === 'reviewScore'
                  ? String(row.reviewScore)
                  : (row.raw[f.columnId] ?? '');

      const v = String(rawValue ?? '');
      const target = f.value;

      switch (f.operator) {
        case 'equals':
          return v === target;
        case 'not_equals':
          return v !== target;
        case 'contains':
          return v.toLowerCase().includes(target.toLowerCase());
        case 'greater_than':
          return Number(v) > Number(target);
        case 'less_than':
          return Number(v) < Number(target);
        case 'in':
          return target
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .includes(v);
        default:
          return true;
      }
    });

    const combinedFilters =
      filters.length === 0
        ? true
        : logic === 'AND'
          ? filterMatches.every(Boolean)
          : filterMatches.some(Boolean);

    const inScoreRange =
      row.reviewScore >= minScore && row.reviewScore <= maxScore;

    const isFlagged = row.reviewScore >= flaggedThreshold;
    const matchesFlagged = !flaggedOnly || isFlagged;

    const isTailSpendSupplier =
      supplierSpend[row.supplierName] !== undefined &&
      supplierSpend[row.supplierName] < tailSpendThreshold;
    const matchesTailSpend = !hideTailSpend || !isTailSpendSupplier;

    return combinedFilters && inScoreRange && matchesFlagged && matchesTailSpend;
  };

  const filteredRows = rows.filter(basePredicate);

  let filteredSpend = 0;
  let flaggedPending = 0;
  let flaggedReviewed = 0;
  let scoreSum = 0;

  for (const row of filteredRows) {
    filteredSpend += row.spendAmount;
    scoreSum += row.reviewScore;
    const isFlagged = row.reviewScore >= flaggedThreshold;
    if (isFlagged) {
      if (row.overrideRuleApplied && row.overrideRuleApplied.length > 0) {
        flaggedReviewed += 1;
      } else {
        flaggedPending += 1;
      }
    }
  }

  const avgScore =
    filteredRows.length > 0 ? Math.round(scoreSum / filteredRows.length) : null;

  const metrics: MetricsSummary = {
    totalRows: rows.length,
    totalSpend: rows.reduce((sum, r) => sum + r.spendAmount, 0),
    filteredRows: filteredRows.length,
    filteredSpend,
    flaggedPending,
    flaggedReviewed,
    averageReviewScore: avgScore,
  };

  return { filteredRows, metrics };
}

export const ReviewPage: React.FC = () => {
  const { rows, loading, error, metrics: baseMetrics, supplierSpend } =
    useClassifiedCsv();

  const [selectedDatasetId] = useState('default');
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(
    AVAILABLE_COLUMNS.filter((c) => c.isDefault).map((c) => c.id),
  );
  const [filters, setFilters] = useState<TableFilter[]>([]);
  const [logic, setLogic] = useState<LogicalOperator>('AND');
  const [reviewScoreRange, setReviewScoreRange] = useState<[number, number]>([
    0, 100,
  ]);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [flaggedThreshold] = useState(FLAGGED_THRESHOLD_DEFAULT);
  const [hideTailSpend, setHideTailSpend] = useState(false);
  const [tailSpendThreshold, setTailSpendThreshold] =
    useState<number>(TAIL_SPEND_DEFAULT);

  const [sorting, setSorting] = useState<SortingState>([
    { id: 'spendAmount', desc: true },
  ]);

  const activeColumns = useMemo(
    () =>
      AVAILABLE_COLUMNS.filter((c) => visibleColumnIds.includes(c.id)).map<
        ColumnDef<ReviewRow>
      >((c) => ({
        id: c.id,
        accessorKey: c.accessorKey,
        header: c.label,
        cell: (info) => {
          const value = info.getValue();
          const columnId = info.column.id;
          const display =
            typeof value === 'number'
              ? columnId === 'spendAmount'
                ? `$${value.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : value.toLocaleString()
              : (value as string);

          return (
            <span
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/x-filter',
                  JSON.stringify({
                    columnId,
                    value: String(value ?? ''),
                  }),
                );
              }}
            >
              {display}
            </span>
          );
        },
      })),
    [visibleColumnIds],
  );

  const columns = useMemo<ColumnDef<ReviewRow>[]>(
    () => [
      {
        id: 'select',
        header: () => null,
        cell: (info) => (
          <input
            type="checkbox"
            checked={info.row.getIsSelected()}
            onChange={info.row.getToggleSelectedHandler()}
          />
        ),
        enableSorting: false,
        size: 32,
      },
      ...activeColumns,
    ],
    [activeColumns],
  );

  const { filteredRows, metrics } = useMemo(
    () =>
      applyFilters(
        rows,
        filters,
        logic,
        reviewScoreRange,
        flaggedOnly,
        flaggedThreshold,
        hideTailSpend,
        supplierSpend,
        tailSpendThreshold,
      ),
    [
      rows,
      filters,
      logic,
      reviewScoreRange,
      flaggedOnly,
      flaggedThreshold,
      hideTailSpend,
      supplierSpend,
      tailSpendThreshold,
    ],
  );

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
  });

  const tableContainerRef = React.useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  const clearFilters = () => {
    setFilters([]);
    setLogic('AND');
    setReviewScoreRange([0, 100]);
    setFlaggedOnly(false);
    setHideTailSpend(false);
  };

  const handleDropToFilters: React.DragEventHandler<HTMLDivElement> = (event) => {
    const payload = event.dataTransfer.getData('application/x-filter');
    if (!payload) return;

    try {
      const { columnId, value } = JSON.parse(payload) as {
        columnId: string;
        value: string;
      };
      if (!value) return;
      setFilters((prev) => [...prev, createFilterFromDrag(columnId, value)]);
    } catch {
      // no-op — ignore malformed drops
    }
  };

  const aggregateVisibleSpend = useMemo(
    () => filteredRows.reduce((sum, row) => sum + row.spendAmount, 0),
    [filteredRows],
  );

  return (
    <div className="review-root">
      <header className="review-header">
        <div className="review-header-left">
          <h1>Classification Review</h1>
          <p>Explore and correct classifications across your datasets.</p>
        </div>
        <div className="review-header-right">
          <label className="dataset-selector">
            <span>Dataset</span>
            <select value={selectedDatasetId} readOnly>
              <option value="default">Sample Classified Dataset</option>
            </select>
          </label>
          <button
            type="button"
            className="help-button"
            title="Drag values from the table into the Filter panel to create filters. Use the Filter Builder for advanced conditions."
          >
            ?
          </button>
        </div>
      </header>

      <section className="metrics-section">
        <details open>
          <summary>Metrics</summary>
          <div className="metrics-grid">
            <MetricCard label="Total Rows" value={metrics.totalRows} />
            <MetricCard
              label="Total Spend"
              value={`$${metrics.totalSpend.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`}
            />
            <MetricCard
              label="Filtered Rows"
              value={`${metrics.filteredRows} ${
                metrics.filteredRows !== baseMetrics.totalRows ? '(filtered)' : ''
              }`}
            />
            <MetricCard
              label="Filtered Spend"
              value={`$${metrics.filteredSpend.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`}
            />
            <MetricCard
              label="Flagged Pending Review"
              value={metrics.flaggedPending}
            />
            <MetricCard
              label="Flagged Reviewed"
              value={metrics.flaggedReviewed}
            />
            <MetricCard
              label="Average Review Score"
              value={
                metrics.averageReviewScore != null
                  ? `${metrics.averageReviewScore}`
                  : '—'
              }
            />
            <div className="metrics-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={clearFilters}
                disabled={
                  !filters.length &&
                  !flaggedOnly &&
                  !hideTailSpend &&
                  reviewScoreRange[0] === 0 &&
                  reviewScoreRange[1] === 100
                }
              >
                Clear Filters
              </button>
            </div>
          </div>
        </details>
      </section>

      <main className="review-main">
        <aside
          className="filter-panel"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropToFilters}
        >
          <header className="filter-panel-header">
            <h2>Filters</h2>
            <span className="filter-panel-subtitle">
              Drag table values here to filter
            </span>
          </header>

          <div className="filter-builder">
            <div className="filter-builder-header">
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  setFilters((prev) => [
                    ...prev,
                    {
                      id: `f-${filterIdCounter++}`,
                      columnId: 'supplierName',
                      operator: 'contains',
                      value: '',
                    },
                  ])
                }
              >
                + Add Filter
              </button>
              <div className="logic-toggle">
                {LOGICAL_OPERATORS.map((op) => (
                  <button
                    key={op}
                    type="button"
                    className={`logic-chip ${
                      logic === op ? 'logic-chip-active' : ''
                    }`}
                    onClick={() => setLogic(op)}
                  >
                    {op}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-list">
              {filters.map((filter) => (
                <div className="filter-row" key={filter.id}>
                  <select
                    value={filter.columnId}
                    onChange={(e) =>
                      setFilters((prev) =>
                        prev.map((f) =>
                          f.id === filter.id
                            ? { ...f, columnId: e.target.value }
                            : f,
                        ),
                      )
                    }
                  >
                    {AVAILABLE_COLUMNS.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filter.operator}
                    onChange={(e) =>
                      setFilters((prev) =>
                        prev.map((f) =>
                          f.id === filter.id
                            ? {
                                ...f,
                                operator: e.target.value as FilterOperator,
                              }
                            : f,
                        ),
                      )
                    }
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={filter.value}
                    onChange={(e) =>
                      setFilters((prev) =>
                        prev.map((f) =>
                          f.id === filter.id
                            ? { ...f, value: e.target.value }
                            : f,
                        ),
                      )
                    }
                    placeholder="Value"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() =>
                      setFilters((prev) => prev.filter((f) => f.id !== filter.id))
                    }
                    aria-label="Remove filter"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {!filters.length && (
                <div className="filter-empty-state">
                  No filters yet. Drag values from the table or click &quot;Add
                  Filter&quot;.
                </div>
              )}
            </div>
          </div>

          <div className="filter-controls">
            <label className="slider-label">
              <span>Review Score Range</span>
              <span className="slider-value">
                {reviewScoreRange[0]}–{reviewScoreRange[1]}
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={reviewScoreRange[0]}
              onChange={(e) =>
                setReviewScoreRange([
                  Number(e.target.value),
                  reviewScoreRange[1],
                ])
              }
            />
            <input
              type="range"
              min={0}
              max={100}
              value={reviewScoreRange[1]}
              onChange={(e) =>
                setReviewScoreRange([
                  reviewScoreRange[0],
                  Number(e.target.value),
                ])
              }
            />
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={flaggedOnly}
                  onChange={(e) => setFlaggedOnly(e.target.checked)}
                  disabled={!rows.some((r) => r.reviewScore >= flaggedThreshold)}
                />
                <span>Show only flagged rows</span>
              </label>
              {!rows.some((r) => r.reviewScore >= flaggedThreshold) && (
                <span className="toggle-hint">No flagged rows in dataset</span>
              )}
            </div>

            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={hideTailSpend}
                  onChange={(e) => setHideTailSpend(e.target.checked)}
                />
                <span>Hide tail spend suppliers</span>
              </label>
              <div className="tail-spend-inline">
                <span>
                  Threshold:{' '}
                  <strong>
                    $
                    {tailSpendThreshold.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </strong>
                </span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={tailSpendThreshold}
                  onChange={(e) =>
                    setTailSpendThreshold(
                      Number.isNaN(Number(e.target.value))
                        ? TAIL_SPEND_DEFAULT
                        : Number(e.target.value),
                    )
                  }
                />
              </div>
            </div>
          </div>
        </aside>

        <section className="table-section">
          <div className="table-header">
            <h2>Transactions</h2>
            <div className="table-header-right">
              <ColumnSelector
                columns={AVAILABLE_COLUMNS}
                visibleColumnIds={visibleColumnIds}
                onChange={setVisibleColumnIds}
              />
              <div className="table-aggregate">
                Visible Spend:{' '}
                <strong>
                  $
                  {aggregateVisibleSpend.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </strong>
              </div>
            </div>
          </div>

          {loading && (
            <div className="table-loading">Loading classified.csv…</div>
          )}
          {error && <div className="table-error">Error: {error}</div>}

          <div className="table-container" ref={tableContainerRef}>
            <table>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize() }}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className="th-content">
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {{
                            asc: '▲',
                            desc: '▼',
                          }[header.column.getIsSorted() as string] ?? null}
                        </div>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody
                style={{
                  position: 'relative',
                  display: 'block',
                  height: `${rowVirtualizer.getTotalSize()}px`,
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = table.getRowModel().rows[virtualRow.index];
                  return (
                    <tr
                      key={row.id}
                      data-index={virtualRow.index}
                      style={{
                        position: 'absolute',
                        transform: `translateY(${virtualRow.start}px)`,
                        display: 'table',
                        width: '100%',
                        tableLayout: 'fixed',
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ClassificationTaxonomyPanel rows={filteredRows} />
        </section>
      </main>
    </div>
  );
};

interface MetricCardProps {
  label: string;
  value: number | string;
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value }) => (
  <div className="metric-card">
    <span className="metric-label">{label}</span>
    <span className="metric-value">{value}</span>
  </div>
);

interface ColumnSelectorProps {
  columns: ColumnConfig[];
  visibleColumnIds: string[];
  onChange(ids: string[]): void;
}

const ColumnSelector: React.FC<ColumnSelectorProps> = ({
  columns,
  visibleColumnIds,
  onChange,
}) => {
  const toggleColumn = (id: string) => {
    if (visibleColumnIds.includes(id)) {
      onChange(visibleColumnIds.filter((c) => c !== id));
    } else {
      onChange([...visibleColumnIds, id]);
    }
  };

  return (
    <details className="column-selector">
      <summary>Columns</summary>
      <div className="column-selector-list">
        {columns.map((col) => (
          <label key={col.id}>
            <input
              type="checkbox"
              checked={visibleColumnIds.includes(col.id)}
              onChange={() => toggleColumn(col.id)}
            />
            <span>{col.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
};

interface ClassificationTaxonomyPanelProps {
  rows: ReviewRow[];
}

const ClassificationTaxonomyPanel: React.FC<ClassificationTaxonomyPanelProps> = ({
  rows,
}) => {
  const levels = useMemo(() => {
    const byL1 = new Map<
      string,
      { spend: number; l2: Map<string, { spend: number; l3: Map<string, { spend: number; l4: Map<string, number> }> }> }
    >();

    for (const row of rows) {
      const l1 = row.l1 || 'Unclassified';
      const l2 = row.l2 || '—';
      const l3 = row.l3 || '—';
      const l4 = row.l4 || '—';

      if (!byL1.has(l1)) {
        byL1.set(l1, {
          spend: 0,
          l2: new Map(),
        });
      }
      const l1Entry = byL1.get(l1)!;
      l1Entry.spend += row.spendAmount;

      if (!l1Entry.l2.has(l2)) {
        l1Entry.l2.set(l2, {
          spend: 0,
          l3: new Map(),
        });
      }
      const l2Entry = l1Entry.l2.get(l2)!;
      l2Entry.spend += row.spendAmount;

      if (!l2Entry.l3.has(l3)) {
        l2Entry.l3.set(l3, {
          spend: 0,
          l4: new Map(),
        });
      }
      const l3Entry = l2Entry.l3.get(l3)!;
      l3Entry.spend += row.spendAmount;

      l3Entry.l4.set(l4, (l3Entry.l4.get(l4) ?? 0) + row.spendAmount);
    }

    return byL1;
  }, [rows]);

  if (!rows.length) {
    return null;
  }

  return (
    <section className="taxonomy-panel">
      <h3>Classification Taxonomy</h3>
      <div className="taxonomy-columns">
        <div className="taxonomy-column">
          <header>
            <span>Level 1</span>
          </header>
          <ul>
            {Array.from(levels.entries()).map(([l1, data]) => (
              <li key={l1}>
                <span className="taxonomy-label">{l1}</span>
                <span className="taxonomy-amount">
                  $
                  {data.spend.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="taxonomy-column">
          <header>
            <span>Level 2</span>
          </header>
          <ul>
            {Array.from(levels.values())
              .flatMap((l1) => Array.from(l1.l2.entries()))
              .map(([l2, data]) => (
                <li key={l2}>
                  <span className="taxonomy-label">{l2}</span>
                  <span className="taxonomy-amount">
                    $
                    {data.spend.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                </li>
              ))}
          </ul>
        </div>

        <div className="taxonomy-column">
          <header>
            <span>Level 3</span>
          </header>
          <ul>
            {Array.from(levels.values())
              .flatMap((l1) =>
                Array.from(l1.l2.values()).flatMap((l2) =>
                  Array.from(l2.l3.entries()),
                ),
              )
              .map(([l3, data]) => (
                <li key={l3}>
                  <span className="taxonomy-label">{l3}</span>
                  <span className="taxonomy-amount">
                    $
                    {data.spend.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                </li>
              ))}
          </ul>
        </div>

        <div className="taxonomy-column">
          <header>
            <span>Level 4</span>
          </header>
          <ul>
            {Array.from(levels.values())
              .flatMap((l1) =>
                Array.from(l1.l2.values()).flatMap((l2) =>
                  Array.from(l2.l3.values()).flatMap((l3) =>
                    Array.from(l3.l4.entries()),
                  ),
                ),
              )
              .map(([l4, spend]) => (
                <li key={l4}>
                  <span className="taxonomy-label">{l4}</span>
                  <span className="taxonomy-amount">
                    $
                    {spend.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </section>
  );
};

export { createFilterFromDrag, applyFilters };

