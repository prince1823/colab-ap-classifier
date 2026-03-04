import { v4 as uuidv4 } from 'uuid';
import type { Database, ChangelogStore as IChangelogStore } from '../../shared/types/services';
import type { ChangeLog, ChangeSource } from '../../shared/types/changelog';

interface ChangeLogRow {
  id: string;
  source: string;
  affected_table: string;
  affected_ids: string;
  affected_count: number;
  old_values: string | null;
  new_values: string | null;
  description: string | null;
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
    createdAt: String(row.created_at),
  };
}

export class ChangelogStore implements IChangelogStore {
  constructor(private db: Database) {}

  async listChanges(): Promise<ChangeLog[]> {
    const rows = await this.db.all<ChangeLogRow>(
      'SELECT * FROM change_log ORDER BY created_at DESC'
    );
    return rows.map(rowToChangeLog);
  }

  async logChange(entry: Omit<ChangeLog, 'id' | 'createdAt'>): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO change_log (id, source, affected_table, affected_ids, affected_count, old_values, new_values, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

    await this.logChange({
      source: 'manual',
      affectedTable: change.affectedTable,
      affectedIds: change.affectedIds,
      affectedCount: change.affectedCount,
      oldValues: change.newValues,
      newValues: change.oldValues,
      description: `Reverted: ${(change.description ?? change.id).replace(/^(Reverted:\s*)+/, '')}`,
    });
  }
}
