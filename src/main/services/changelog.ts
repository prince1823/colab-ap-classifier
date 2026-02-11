import { v4 as uuidv4 } from 'uuid';
import { databaseService } from './database';
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

function rowToChangeLog(row: ChangeLogRow): ChangeLog {
  return {
    id: row.id,
    source: row.source as ChangeSource,
    affectedTable: row.affected_table,
    affectedIds: JSON.parse(row.affected_ids),
    affectedCount: row.affected_count,
    oldValues: row.old_values ? JSON.parse(row.old_values) : null,
    newValues: row.new_values ? JSON.parse(row.new_values) : null,
    description: row.description,
    createdAt: String(row.created_at),
  };
}

/**
 * List all changelog entries, sorted by created_at descending (most recent first).
 */
export async function listChanges(): Promise<ChangeLog[]> {
  const rows = await databaseService.all<ChangeLogRow>(
    'SELECT * FROM change_log ORDER BY created_at DESC'
  );
  return rows.map(rowToChangeLog);
}

/**
 * Log a new changelog entry. Returns the generated id.
 */
export async function logChange(
  entry: Omit<ChangeLog, 'id' | 'createdAt'>
): Promise<string> {
  const id = uuidv4();
  await databaseService.run(
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

/**
 * Revert a previously logged change.
 *
 * 1. Read the original change entry
 * 2. Apply old_values to the affected rows in the affected table
 * 3. Create a NEW changelog entry documenting the revert
 * 4. Never delete existing changelog entries
 */
export async function revertChange(changeId: string): Promise<void> {
  const row = await databaseService.get<ChangeLogRow>(
    'SELECT * FROM change_log WHERE id = ?',
    changeId
  );

  if (!row) {
    throw new Error(`Changelog entry not found: ${changeId}`);
  }

  const change = rowToChangeLog(row);

  if (!change.oldValues) {
    throw new Error(`Cannot revert change ${changeId}: no old_values recorded`);
  }

  // Apply old_values to the affected rows in the affected table
  const columns = Object.keys(change.oldValues);
  if (columns.length > 0 && change.affectedIds.length > 0) {
    const setClauses = columns.map((col) => `${col} = ?`).join(', ');
    const setValues = columns.map((col) => change.oldValues![col]);

    const placeholders = change.affectedIds.map(() => '?').join(', ');

    await databaseService.run(
      `UPDATE ${change.affectedTable} SET ${setClauses} WHERE id IN (${placeholders})`,
      ...setValues,
      ...change.affectedIds
    );
  }

  // Create a new changelog entry documenting the revert
  await logChange({
    source: 'manual',
    affectedTable: change.affectedTable,
    affectedIds: change.affectedIds,
    affectedCount: change.affectedCount,
    oldValues: change.newValues,
    newValues: change.oldValues,
    description: `Reverted: ${change.description ?? change.id}`,
  });
}
