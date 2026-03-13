import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { existsSync, unlinkSync } from 'fs';
import type { SupplierUniverse, IAppConfigService } from '../../shared/types/services';
import type { SupplierInfo } from '../../shared/types/suppliers';
import { convertPlaceholders } from './database';

export class SupplierUniverseNotConfiguredError extends Error {
  constructor() {
    super('Supplier universe database path is not configured');
    this.name = 'SupplierUniverseNotConfiguredError';
  }
}

export class SupplierUniverseFileMissingError extends Error {
  constructor(public readonly missingPath: string) {
    super(`Supplier universe database not found at: ${missingPath}`);
    this.name = 'SupplierUniverseFileMissingError';
  }
}

function parseJSON<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}

export class DuckDBSupplierUniverse implements SupplierUniverse {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private filePath: string | null = null;
  private defaultPath: string | null = null;

  constructor(private readonly appConfig: IAppConfigService) {}

  getConfiguredPath(): string | null {
    return this.defaultPath || this.appConfig.getSupplierUniversePath();
  }

  async configure(path: string): Promise<void> {
    if (!existsSync(path) && !path.endsWith('.db')) {
      throw new Error(`Invalid supplier universe path: ${path}`);
    }
    await this.appConfig.setSupplierUniversePath(path);
    this.defaultPath = path;
    await this.open(path);
  }

  async open(filePath?: string): Promise<{ created: boolean }> {
    if (this.instance) {
      await this.close();
    }

    const dbPath = filePath || this.defaultPath || this.appConfig.getSupplierUniversePath();
    if (!dbPath) {
      throw new SupplierUniverseNotConfiguredError();
    }

    if (!existsSync(dbPath)) {
      throw new SupplierUniverseFileMissingError(dbPath);
    }

    try {
      this.instance = await DuckDBInstance.create(dbPath);
      this.connection = await this.instance.connect();
    } catch (err) {
      const walPath = dbPath + '.wal';
      if (existsSync(walPath)) {
        console.warn(`[SupplierUniverse] Removing corrupted WAL file: ${walPath}`);
        try { unlinkSync(walPath); } catch { /* ignore */ }
        this.instance = await DuckDBInstance.create(dbPath);
        this.connection = await this.instance.connect();
      } else {
        throw err;
      }
    }

    this.filePath = dbPath;
    this.defaultPath = dbPath;

    const tables = await this.allRaw<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'suppliers'"
    );

    let created = false;
    if (tables.length === 0) {
      await this.initializeSchema();
      created = true;
    }

    return { created };
  }

  async close(): Promise<void> {
    if (this.connection) {
      try { await this.runRaw('CHECKPOINT'); } catch { /* ignore */ }
      this.connection.closeSync();
      this.connection = null;
    }
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
    this.filePath = null;
  }

  isOpen(): boolean {
    return this.connection !== null;
  }

  private getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error('Supplier universe database is not open');
    }
    return this.connection;
  }

  private async runRaw(sql: string, ...params: unknown[]): Promise<void> {
    const conn = this.getConnection();
    if (params.length > 0) {
      await conn.run(convertPlaceholders(sql), params as (string | number | boolean | null)[]);
    } else {
      await conn.run(sql);
    }
  }

  private async allRaw<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const conn = this.getConnection();
    let reader;
    if (params.length > 0) {
      reader = await conn.runAndReadAll(convertPlaceholders(sql), params as (string | number | boolean | null)[]);
    } else {
      reader = await conn.runAndReadAll(sql);
    }
    return reader.getRowObjectsJson() as T[];
  }

  async getSupplier(name: string): Promise<SupplierInfo | null> {
    const row = await this.allRaw<{ supplier_info: string }>(
      'SELECT supplier_info FROM suppliers WHERE supplier_name = ?', name
    );
    if (row.length === 0) return null;
    return parseJSON<SupplierInfo>(row[0].supplier_info);
  }

  async getSuppliersByNames(names: string[]): Promise<Map<string, SupplierInfo>> {
    if (names.length === 0) return new Map();
    const placeholders = names.map(() => '?').join(', ');
    const rows = await this.allRaw<{ supplier_name: string; supplier_info: string }>(
      `SELECT supplier_name, supplier_info FROM suppliers WHERE supplier_name IN (${placeholders})`,
      ...names
    );
    const result = new Map<string, SupplierInfo>();
    for (const row of rows) {
      const info = parseJSON<SupplierInfo>(row.supplier_info);
      if (info) result.set(row.supplier_name, info);
    }
    return result;
  }

  async upsertSupplier(name: string, data: Partial<SupplierInfo>): Promise<void> {
    const existing = await this.allRaw<{ id: string; supplier_info: string }>(
      'SELECT id, supplier_info FROM suppliers WHERE supplier_name = ?', name
    );

    if (existing.length > 0) {
      const currentInfo = parseJSON<SupplierInfo>(existing[0].supplier_info) || {};
      const merged = { ...currentInfo, ...data };
      await this.runRaw(
        'UPDATE suppliers SET supplier_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        JSON.stringify(merged), existing[0].id
      );
    } else {
      const id = crypto.randomUUID();
      await this.runRaw(
        'INSERT INTO suppliers (id, supplier_name, supplier_info) VALUES (?, ?, ?)',
        id, name, JSON.stringify(data)
      );
    }
  }

  async searchVariants(name: string): Promise<string[]> {
    const rows = await this.allRaw<{ aliases: string }>(
      'SELECT aliases FROM suppliers WHERE supplier_name = ?', name
    );
    if (rows.length === 0) return [];
    return parseJSON<string[]>(rows[0].aliases) || [];
  }

  private async initializeSchema(): Promise<void> {
    const conn = this.getConnection();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id VARCHAR PRIMARY KEY,
        supplier_name VARCHAR NOT NULL UNIQUE,
        aliases JSON,
        parent_supplier_id VARCHAR,
        parent_name VARCHAR,
        supplier_info JSON,
        mapped_taxonomy_paths JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(supplier_name);
    `);
  }
}
