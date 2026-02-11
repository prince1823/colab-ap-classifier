export type ChangeSource = 'manual' | 'pipeline';

export interface ChangeLog {
  id: string;
  source: ChangeSource;
  affectedTable: string;
  affectedIds: string[];
  affectedCount: number;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  description: string | null;
  createdAt: string;
}
