import { v4 as uuidv4 } from 'uuid';
import type { Database, ChangelogStore as IChangelogStore } from '../../shared/types/services';
import type { ChangeLog, ChangeSource, ChangelogFilter, PaginatedChangelog } from '../../shared/types/changelog';

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

      const idArray = Array.from(allIds);
      const placeholders = idArray.map(() => '?').join(',');
      const txRows = await this.db.all<{ id: string; supplier_name: string | null }>(
        `SELECT CAST(t.id AS VARCHAR) as id, ps.supplier_name
         FROM transactions t
         LEFT JOIN project_suppliers ps ON t.project_supplier_id = ps.id
         WHERE t.id IN (${placeholders})`,
        ...idArray
      );

      const txSupplierMap = new Map<string, string>();
      for (const r of txRows) {
        if (r.supplier_name) txSupplierMap.set(r.id, r.supplier_name);
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
      `INSERT INTO change_log (id, source, affected_table, affected_ids, affected_count, old_values, new_values, description, is_reverted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
      id,
      entry.source,
      entry.affectedTable,
      JSON.stringify(entry.affectedIds),
      entry.affectedCount,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      entry.description ?? null
    );
    return id;
  }

  async revertChange(changeId: string): Promise<void> {
    const row = await this.db.get<ChangeLogRow>(
      'SELECT * FROM change_log WHERE id = ?',
      changeId
    );

    if (!row) throw new Error(`Changelog entry not found: ${changeId}`);
    const change = rowToChangeLog(row);

    if (change.isReverted) {
      // Un-revert: re-apply the new values
      if (!change.newValues) throw new Error(`Cannot un-revert change ${changeId}: no new_values recorded`);
      const columns = Object.keys(change.newValues);
      if (columns.length > 0 && change.affectedIds.length > 0) {
        const setClauses = columns.map((col) => `${col} = ?`).join(', ');
        const setValues = columns.map((col) => change.newValues![col]);
        const placeholders = change.affectedIds.map(() => '?').join(', ');
        await this.db.run(
          `UPDATE ${change.affectedTable} SET ${setClauses} WHERE id IN (${placeholders})`,
          ...setValues,
          ...change.affectedIds
        );
      }
      await this.db.run('UPDATE change_log SET is_reverted = FALSE WHERE id = ?', changeId);
    } else {
      // Revert: restore the old values
      if (!change.oldValues) throw new Error(`Cannot revert change ${changeId}: no old_values recorded`);
      const columns = Object.keys(change.oldValues);
      if (columns.length > 0 && change.affectedIds.length > 0) {
        const setClauses = columns.map((col) => `${col} = ?`).join(', ');
        const setValues = columns.map((col) => change.oldValues![col]);
        const placeholders = change.affectedIds.map(() => '?').join(', ');
        await this.db.run(
          `UPDATE ${change.affectedTable} SET ${setClauses} WHERE id IN (${placeholders})`,
          ...setValues,
          ...change.affectedIds
        );
      }
      await this.db.run('UPDATE change_log SET is_reverted = TRUE WHERE id = ?', changeId);
    }
  }
}
