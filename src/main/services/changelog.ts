import { v4 as uuidv4 } from 'uuid';
import type { Database, ChangelogStore as IChangelogStore } from '../../shared/types/services';
import type { ChangeLog, ChangeSource, ChangelogFilter, PaginatedChangelog } from '../../shared/types/changelog';
import type { FilterCondition } from '../../shared/types/transactions';

interface ChangeLogRow {
  id: string;
  source: string;
  affected_table: string;
  affected_ids: string;
  affected_count: number;
  old_values: string | null;
  new_values: string | null;
  description: string | null;
  is_reverted: boolean;
  filter_context: string | null;
  rule_id: string | null;
  created_at: string;
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function rowToChangeLog(row: ChangeLogRow): ChangeLog {
  return {
    id: row.id,
    source: row.source as ChangeSource,
    affectedTable: row.affected_table,
    affectedIds: (safeParse(row.affected_ids) as string[]) || [],
    affectedCount: row.affected_count,
    oldValues: safeParse(row.old_values) as Record<string, unknown> | null,
    newValues: safeParse(row.new_values) as Record<string, unknown> | null,
    description: row.description,
    isReverted: Boolean(row.is_reverted),
    filterContext: safeParse(row.filter_context) as FilterCondition[] | null,
    ruleId: row.rule_id ?? null,
    createdAt: String(row.created_at),
  };
}

export class ChangelogStore implements IChangelogStore {
  constructor(private db: Database) {}

  private buildFilterSQL(filter?: ChangelogFilter): { whereSQL: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Always exclude legacy "Reverted:" entries
    conditions.push("(description IS NULL OR description NOT LIKE 'Reverted:%')");

    if (filter?.viewFilter === 'changes') {
      conditions.push("source != 'feedback'");
    } else if (filter?.viewFilter === 'feedback') {
      conditions.push("source = 'feedback'");
    }

    if (filter?.search?.trim()) {
      const pattern = `%${filter.search.trim()}%`;
      conditions.push('(description ILIKE ? OR source ILIKE ?)');
      params.push(pattern, pattern);
    }

    const whereSQL = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSQL, params };
  }

  async getCount(filter?: ChangelogFilter): Promise<number> {
    const { whereSQL, params } = this.buildFilterSQL(filter);
    const result = await this.db.get<{ cnt: number | bigint }>(
      `SELECT COUNT(*) as cnt FROM change_log ${whereSQL}`,
      ...params
    );
    return Number(result?.cnt ?? 0);
  }

  async listChanges(filter?: ChangelogFilter): Promise<ChangeLog[]> {
    const { whereSQL, params } = this.buildFilterSQL(filter);

    const page = filter?.page || 1;
    const pageSize = filter?.pageSize;
    const limitClause = pageSize ? `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` : '';

    const rows = await this.db.all<ChangeLogRow>(
      `SELECT * FROM change_log ${whereSQL} ORDER BY created_at DESC ${limitClause}`,
      ...params
    );
    const entries = rows.map(rowToChangeLog);

    // Enrich transaction changes with supplier names
    const txEntries = entries.filter(e => e.affectedTable === 'transactions' && e.affectedIds.length > 0);
    if (txEntries.length > 0) {
      const allIds = new Set<string>();
      for (const e of txEntries) {
        for (const id of e.affectedIds) allIds.add(id);
      }

      // Batch lookups to avoid exceeding max call stack with large spreads
      const idArray = Array.from(allIds);
      const BATCH = 500;
      const txSupplierMap = new Map<string, string>();
      for (let i = 0; i < idArray.length; i += BATCH) {
        const chunk = idArray.slice(i, i + BATCH);
        const placeholders = chunk.map(() => '?').join(',');
        const txRows = await this.db.all<{ id: string; supplier_name: string | null }>(
          `SELECT CAST(t.id AS VARCHAR) as id, ps.supplier_name
           FROM transactions t
           LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
           WHERE t.id IN (${placeholders})`,
          ...chunk
        );
        for (const r of txRows) {
          if (r.supplier_name) txSupplierMap.set(r.id, r.supplier_name);
        }
      }

      for (const entry of txEntries) {
        const suppliers = new Set<string>();
        for (const id of entry.affectedIds) {
          const name = txSupplierMap.get(id);
          if (name) suppliers.add(name);
        }
        if (suppliers.size > 0) {
          entry.supplierNames = Array.from(suppliers);
        }
      }
    }

    return entries;
  }

  async listChangesPaginated(filter?: ChangelogFilter): Promise<PaginatedChangelog> {
    const page = filter?.page || 1;
    const pageSize = filter?.pageSize || 50;
    const totalCount = await this.getCount(filter);
    const rows = await this.listChanges({ ...filter, page, pageSize });
    return { rows, totalCount, page, pageSize };
  }

  async logChange(entry: Omit<ChangeLog, 'id' | 'createdAt'>): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO change_log (id, source, affected_table, affected_ids, affected_count, old_values, new_values, description, is_reverted, filter_context, rule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)`,
      id,
      entry.source,
      entry.affectedTable,
      JSON.stringify(entry.affectedIds),
      entry.affectedCount,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      entry.description ?? null,
      entry.filterContext ? JSON.stringify(entry.filterContext) : null,
      entry.ruleId ?? null
    );
    return id;
  }

  async revertChange(changeId: string): Promise<string | undefined> {
    const row = await this.db.get<ChangeLogRow>(
      'SELECT * FROM change_log WHERE id = ?',
      changeId
    );

    if (!row) throw new Error(`Changelog entry not found: ${changeId}`);
    const change = rowToChangeLog(row);

    if (change.isReverted) {
      // Revert is one-way — once reverted, it cannot be undone
      throw new Error(`Change ${changeId} has already been reverted`);
    } else {
      // Revert: restore the old values
      if (!change.oldValues) throw new Error(`Cannot revert change ${changeId}: no old_values recorded`);

      // Determine which columns to revert (exclude internal metadata key)
      const columns = Object.keys(change.oldValues).filter((k) => k !== '_perTransaction');
      if (columns.length > 0 && change.affectedIds.length > 0) {
        const BATCH = 500;
        // Existence check: use inline values for large sets to avoid stack overflow
        const existingIds = new Set<string>();
        if (change.affectedIds.length > BATCH) {
          const escaped = change.affectedIds.map(v => `'${String(v).replace(/'/g, "''")}'`).join(', ');
          const rows = await this.db.all<{ id: string }>(
            `SELECT CAST(id AS VARCHAR) as id FROM ${change.affectedTable} WHERE id IN (${escaped})`
          );
          for (const r of rows) existingIds.add(r.id);
        } else {
          const placeholders = change.affectedIds.map(() => '?').join(', ');
          const rows = await this.db.all<{ id: string }>(
            `SELECT CAST(id AS VARCHAR) as id FROM ${change.affectedTable} WHERE id IN (${placeholders})`,
            ...change.affectedIds
          );
          for (const r of rows) existingIds.add(r.id);
        }
        const missingIds = change.affectedIds.filter((id) => !existingIds.has(id));
        const revertableIds = change.affectedIds.filter((id) => existingIds.has(id));

        if (revertableIds.length > 0) {
          const perTransaction = change.oldValues._perTransaction as
            | Record<string, Record<string, unknown>>
            | undefined;

          if (perTransaction) {
            // Per-row revert: restore each transaction to its own prior state
            // Group by unique old-value signature to batch identical updates
            const skipKeys = new Set(['supplier_name']);
            const groups = new Map<string, { cols: string[]; vals: unknown[]; ids: string[] }>();
            for (const id of revertableIds) {
              const rowOld = perTransaction[id];
              if (!rowOld) continue;
              const rowCols = Object.keys(rowOld).filter((k) => !skipKeys.has(k));
              if (rowCols.length === 0) continue;
              const key = rowCols.map((c) => `${c}=${JSON.stringify(rowOld[c])}`).join('|');
              let group = groups.get(key);
              if (!group) {
                group = { cols: rowCols, vals: rowCols.map((c) => rowOld[c]), ids: [] };
                groups.set(key, group);
              }
              group.ids.push(id);
            }
            // Execute one batched UPDATE per unique old-value combination
            for (const group of groups.values()) {
              const setClauses = group.cols.map((col) => `${col} = ?`).join(', ');
              for (let i = 0; i < group.ids.length; i += BATCH) {
                const chunk = group.ids.slice(i, i + BATCH);
                const placeholders = chunk.map(() => '?').join(', ');
                await this.db.run(
                  `UPDATE ${change.affectedTable} SET ${setClauses} WHERE id IN (${placeholders})`,
                  ...group.vals,
                  ...chunk
                );
              }
            }
          } else {
            // Legacy fallback: apply same old values to all rows (batched)
            const setClauses = columns.map((col) => `${col} = ?`).join(', ');
            const setValues = columns.map((col) => change.oldValues![col]);
            for (let i = 0; i < revertableIds.length; i += BATCH) {
              const chunk = revertableIds.slice(i, i + BATCH);
              const revertPlaceholders = chunk.map(() => '?').join(', ');
              await this.db.run(
                `UPDATE ${change.affectedTable} SET ${setClauses} WHERE id IN (${revertPlaceholders})`,
                ...setValues,
                ...chunk
              );
            }
          }
        }

        await this.db.run('UPDATE change_log SET is_reverted = TRUE WHERE id = ?', changeId);

        if (missingIds.length > 0) {
          return `${missingIds.length} of ${change.affectedIds.length} affected rows no longer exist and were skipped`;
        }
      } else {
        await this.db.run('UPDATE change_log SET is_reverted = TRUE WHERE id = ?', changeId);
      }
    }
  }

  /**
   * List changelog entries for a specific rule, filtering affected IDs
   * to only include transactions still owned by that rule.
   */
  async listByRuleId(ruleId: string): Promise<ChangeLog[]> {
    const rows = await this.db.all<ChangeLogRow>(
      `SELECT * FROM change_log WHERE rule_id = ? ORDER BY created_at DESC`,
      ruleId
    );
    const entries = rows.map(rowToChangeLog);

    // Get all transaction IDs still owned by this rule
    const ownedRows = await this.db.all<{ id: string }>(
      `SELECT CAST(id AS VARCHAR) as id FROM transactions WHERE CAST(applied_rule_id AS VARCHAR) = ?`,
      ruleId
    );
    const ownedIds = new Set(ownedRows.map(r => r.id));

    const result: ChangeLog[] = [];
    for (const entry of entries) {
      if (entry.isReverted) {
        // Already-reverted entries shown as-is for display
        result.push(entry);
        continue;
      }
      // Filter affected IDs to only still-owned transactions
      const filteredIds = entry.affectedIds.filter(id => ownedIds.has(id));
      if (filteredIds.length === 0) continue; // All txns reclassified by other rules
      result.push({
        ...entry,
        affectedIds: filteredIds,
        affectedCount: filteredIds.length,
      });
    }
    return result;
  }
}
