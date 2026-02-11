import { useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import type { ReviewRow, MetricsSummary } from './types';

const REVIEW_SCORE_FALLBACK = 60;

interface UseClassifiedCsvResult {
  rows: ReviewRow[];
  loading: boolean;
  error: string | null;
  metrics: MetricsSummary;
  supplierSpend: Record<string, number>;
}

export function useClassifiedCsv(): UseClassifiedCsvResult {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/classified.csv');
        if (!response.ok) {
          throw new Error(`Failed to load classified.csv (status ${response.status})`);
        }
        const text = await response.text();

        const parseResult = Papa.parse<Record<string, string>>(text, {
          header: true,
          skipEmptyLines: true,
          trimHeaders: true,
          transformHeader: (header) => header.trim(),
        });

        const records = parseResult.data;

        if (cancelled) return;

        const mapped: ReviewRow[] = records.map((record, index) => {
          const supplierName = record['supplier_name'] ?? '';
          const lineDescription =
            record['line_description'] || record['gl_description'] || '';
          const l1 = record['L1'] || null;
          const l2 = record['L2'] || null;
          const l3 = record['L3'] || null;
          const l4 = record['L4'] || null;
          const classificationPath = [l1, l2, l3, l4].filter(Boolean).join(' / ');

          const spendRaw = record['amount'] ?? '0';
          const spendAmount = Number.parseFloat(spendRaw || '0') || 0;

          const percentileRaw = record['cumulative_spend_percentile'];
          const derivedScore =
            percentileRaw && !Number.isNaN(Number.parseFloat(percentileRaw))
              ? Math.round(Number.parseFloat(percentileRaw) * 100)
              : REVIEW_SCORE_FALLBACK;

          const overrideRuleApplied = record['override_rule_applied'] || null;

          return {
            id: `${record['invoice_key'] ?? 'row'}-${index}`,
            supplierName,
            lineDescription,
            classificationPath,
            l1,
            l2,
            l3,
            l4,
            spendAmount,
            reviewScore: derivedScore,
            overrideRuleApplied,
            raw: record,
          };
        });

        setRows(mapped);
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Unknown error while loading CSV data';
        if (!cancelled) setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const { metrics, supplierSpend } = useMemo(() => {
    if (!rows.length) {
      return {
        metrics: {
          totalRows: 0,
          totalSpend: 0,
          filteredRows: 0,
          filteredSpend: 0,
          flaggedPending: 0,
          flaggedReviewed: 0,
          averageReviewScore: null,
        },
        supplierSpend: {},
      };
    }

    let totalSpend = 0;
    const supplierSpendAcc: Record<string, number> = {};

    for (const row of rows) {
      totalSpend += row.spendAmount;
      supplierSpendAcc[row.supplierName] =
        (supplierSpendAcc[row.supplierName] ?? 0) + row.spendAmount;
    }

    // Base metrics treat "filtered" as unfiltered; filters are applied later in ReviewPage.
    const flaggedRows = rows.filter((r) => r.reviewScore >= 50);
    const flaggedReviewed = flaggedRows.filter(
      (r) => r.overrideRuleApplied && r.overrideRuleApplied.length > 0,
    ).length;
    const flaggedPending = flaggedRows.length - flaggedReviewed;

    const avgScore =
      rows.reduce((sum, r) => sum + r.reviewScore, 0) / rows.length || 0;

    const baseMetrics: MetricsSummary = {
      totalRows: rows.length,
      totalSpend,
      filteredRows: rows.length,
      filteredSpend: totalSpend,
      flaggedPending,
      flaggedReviewed,
      averageReviewScore: Number.isFinite(avgScore) ? Math.round(avgScore) : null,
    };

    return { metrics: baseMetrics, supplierSpend: supplierSpendAcc };
  }, [rows]);

  return { rows, loading, error, metrics, supplierSpend };
}

