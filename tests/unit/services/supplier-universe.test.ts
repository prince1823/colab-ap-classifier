import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  DuckDBSupplierUniverse,
  SupplierUniverseFileMissingError,
  SupplierUniverseNotConfiguredError,
} from '../../../src/main/services/supplier-universe';
import type { IAppConfigService } from '../../../src/shared/types/services';

function tempDbPath(): string {
  return path.join(os.tmpdir(), `su-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeMockAppConfig(initialPath: string | null = null) {
  let storedPath = initialPath;
  const appConfig = {
    getSupplierUniversePath: () => storedPath,
    setSupplierUniversePath: async (p: string) => { storedPath = p; },
    clearSupplierUniversePath: async () => { storedPath = null; },
  } as unknown as IAppConfigService;
  return { appConfig, getStoredPath: () => storedPath };
}

describe('DuckDBSupplierUniverse', () => {
  let universe: DuckDBSupplierUniverse;
  let mockConfig: ReturnType<typeof makeMockAppConfig>;
  const createdPaths: string[] = [];

  function track(p: string): string {
    createdPaths.push(p);
    return p;
  }

  beforeEach(() => {
    mockConfig = makeMockAppConfig();
    universe = new DuckDBSupplierUniverse(mockConfig.appConfig);
  });

  afterEach(async () => {
    if (universe.isOpen()) {
      await universe.close();
    }
    for (const p of createdPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
      try { if (fs.existsSync(p + '.wal')) fs.unlinkSync(p + '.wal'); } catch { /* ignore */ }
    }
    createdPaths.length = 0;
  });

  // ── Flow 1: Creating a new database ──────────────────────────────────────

  describe('configure() — new database', () => {
    it('creates the .db file on disk', async () => {
      const p = track(tempDbPath());
      expect(fs.existsSync(p)).toBe(false);
      await universe.configure(p);
      expect(fs.existsSync(p)).toBe(true);
    });

    it('leaves the universe open and usable', async () => {
      const p = track(tempDbPath());
      await universe.configure(p);
      expect(universe.isOpen()).toBe(true);
      await expect(universe.getSupplier('ACME')).resolves.toBeNull();
    });

    it('persists the path to app-config', async () => {
      const p = track(tempDbPath());
      await universe.configure(p);
      expect(mockConfig.getStoredPath()).toBe(p);
    });

    it('throws on a path with no .db extension that does not exist', async () => {
      const invalid = path.join(os.tmpdir(), `no-extension-${Date.now()}`);
      await expect(universe.configure(invalid)).rejects.toThrow('Invalid supplier universe path');
    });
  });

  // ── Flow 2: Selecting an existing database ────────────────────────────────

  describe('configure() — existing database', () => {
    it('opens an existing DB and reports isOpen=true', async () => {
      const p = track(tempDbPath());
      const seed = new DuckDBSupplierUniverse(makeMockAppConfig().appConfig);
      await seed.configure(p);
      await seed.close();

      await universe.configure(p);
      expect(universe.isOpen()).toBe(true);
    });

    it('preserves existing supplier data when re-opening', async () => {
      const p = track(tempDbPath());
      await universe.configure(p);
      await universe.upsertSupplier('ACME Corp', { industry: 'Manufacturing', website: 'acme.com' });
      await universe.close();

      const universe2 = new DuckDBSupplierUniverse(makeMockAppConfig().appConfig);
      await universe2.configure(p);
      const info = await universe2.getSupplier('ACME Corp');
      await universe2.close();

      expect(info?.industry).toBe('Manufacturing');
    });

    it('updates getConfiguredPath() when opening a DB at a different location', async () => {
      const p1 = track(tempDbPath());
      const p2 = track(tempDbPath());

      await universe.configure(p1);
      expect(universe.getConfiguredPath()).toBe(p1);

      await universe.configure(p2);
      expect(universe.getConfiguredPath()).toBe(p2);
    });

    it('runs schema migration on an existing DB missing category_a_supplier', async () => {
      const p = track(tempDbPath());
      // Seed a DB with the old schema (missing category_a_supplier)
      const inst = await DuckDBInstance.create(p);
      const conn = await inst.connect();
      await conn.run(`
        CREATE TABLE suppliers (
          id VARCHAR PRIMARY KEY,
          supplier_name VARCHAR NOT NULL UNIQUE,
          aliases JSON,
          parent_supplier_id VARCHAR,
          parent_name VARCHAR,
          supplier_info JSON,
          mapped_taxonomy_paths JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      conn.closeSync();
      inst.closeSync();

      await expect(universe.configure(p)).resolves.not.toThrow();
      // column is usable after migration
      await expect(
        universe.upsertSupplierFull('MigratedCo', {
          supplierInfo: { industry: 'Tech' },
          categoryASupplier: true,
          aliases: [],
          mappedTaxonomyPaths: [],
        })
      ).resolves.not.toThrow();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('configure() — edge cases', () => {
    it('closes the currently open DB before opening the new one', async () => {
      const p1 = track(tempDbPath());
      const p2 = track(tempDbPath());

      await universe.configure(p1);
      expect(universe.getConfiguredPath()).toBe(p1);

      await universe.configure(p2);
      expect(universe.isOpen()).toBe(true);
      expect(universe.getConfiguredPath()).toBe(p2);
    });
  });

  // ── open() — startup path ─────────────────────────────────────────────────

  describe('open() — startup path', () => {
    it('reopens from defaultPath after close(), without a filePath arg', async () => {
      const p = track(tempDbPath());
      await universe.configure(p);
      await universe.close();
      expect(universe.isOpen()).toBe(false);

      await universe.open();
      expect(universe.isOpen()).toBe(true);
    });

    it('throws SupplierUniverseFileMissingError when configured path does not exist', async () => {
      const ghost = path.join(os.tmpdir(), 'ghost-universe.db');
      mockConfig = makeMockAppConfig(ghost);
      universe = new DuckDBSupplierUniverse(mockConfig.appConfig);

      await expect(universe.open()).rejects.toThrow(SupplierUniverseFileMissingError);
    });

    it('throws SupplierUniverseNotConfiguredError when no path is set', async () => {
      await expect(universe.open()).rejects.toThrow(SupplierUniverseNotConfiguredError);
    });
  });
});
