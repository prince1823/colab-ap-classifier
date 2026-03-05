import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock Electron's dialog module before importing the service
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [{}]),
  },
}));

import { dialog } from 'electron';
import { DuckDBDatabase } from '../../../src/main/services/database';
import { ProjectStore } from '../../../src/main/services/project';
import { createMockTransactionStore, createMockSupplierUniverse } from '../../helpers/mock-services';
import type { TransactionStore, SupplierUniverse } from '../../../src/shared/types/services';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'project-test-'));
}

describe('ProjectStore', () => {
  let testDir: string;
  let db: DuckDBDatabase;
  let transactions: TransactionStore;
  let supplierUniverse: SupplierUniverse;
  let store: ProjectStore;

  beforeEach(() => {
    testDir = tempDir();
    db = new DuckDBDatabase();
    transactions = createMockTransactionStore();
    supplierUniverse = createMockSupplierUniverse();
    store = new ProjectStore(db, transactions, supplierUniverse);
  });

  afterEach(async () => {
    if (store.isProjectOpen()) {
      await store.closeProject();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('createProject', () => {
    it('should create a .c91 file and initialise schema', async () => {
      const filePath = path.join(testDir, 'projects', 'TestProject.c91');
      const result = await store.createProject('TestProject', filePath);

      expect(result.filePath).toBe(filePath);
      expect(result.name).toBe('TestProject');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(store.isProjectOpen()).toBe(true);

      const name = await store.getSetting('project_name');
      expect(name).toBe('TestProject');
      const threshold = await store.getSetting('tail_spend_threshold');
      expect(threshold).toBe(10000);
    });

    it('should create the parent directory if it does not exist', async () => {
      const projectsDir = path.join(testDir, 'projects');
      expect(fs.existsSync(projectsDir)).toBe(false);

      const filePath = path.join(projectsDir, 'NewProject.c91');
      await store.createProject('NewProject', filePath);

      expect(fs.existsSync(projectsDir)).toBe(true);
    });

    it('should throw if project name is empty', async () => {
      const filePath = path.join(testDir, 'Empty.c91');
      await expect(store.createProject('', filePath)).rejects.toThrow(
        'Project name must not be empty'
      );
    });

    it('should throw if project file already exists', async () => {
      const filePath = path.join(testDir, 'projects', 'Duplicate.c91');
      await store.createProject('Duplicate', filePath);
      await store.closeProject();

      await expect(store.createProject('Duplicate', filePath)).rejects.toThrow(
        'Project file already exists'
      );
    });
  });

  describe('openProject', () => {
    it('should open an existing .c91 file and return name', async () => {
      const filePath = path.join(testDir, 'projects', 'OpenMe.c91');
      const created = await store.createProject('OpenMe', filePath);
      await store.closeProject();

      const opened = await store.openProject(created.filePath);

      expect(opened.filePath).toBe(created.filePath);
      expect(opened.name).toBe('OpenMe');
      expect(store.isProjectOpen()).toBe(true);
    });

    it('should throw if file does not exist', async () => {
      const fakePath = path.join(testDir, 'nonexistent.c91');
      await expect(store.openProject(fakePath)).rejects.toThrow(
        'Project file not found'
      );
    });

    it('should throw if file path is empty', async () => {
      await expect(store.openProject('')).rejects.toThrow(
        'File path must not be empty'
      );
    });
  });

  describe('closeProject', () => {
    it('should close the database and clear state', async () => {
      const filePath = path.join(testDir, 'projects', 'CloseMe.c91');
      await store.createProject('CloseMe', filePath);
      expect(store.isProjectOpen()).toBe(true);

      await store.closeProject();
      expect(store.isProjectOpen()).toBe(false);
    });

    it('should cause operations to throw after close', async () => {
      const filePath = path.join(testDir, 'projects', 'ThrowAfterClose.c91');
      await store.createProject('ThrowAfterClose', filePath);
      await store.closeProject();

      await expect(store.getSetting('project_name')).rejects.toThrow(
        'No project is currently open'
      );
    });
  });

  describe('Settings KV CRUD', () => {
    beforeEach(async () => {
      const filePath = path.join(testDir, 'projects', 'KVTest.c91');
      await store.createProject('KVTest', filePath);
    });

    it('should create a new key when setSetting is called', async () => {
      const before = await store.getSetting('custom_flag');
      expect(before).toBeUndefined();

      await store.setSetting('custom_flag', true);
      const after = await store.getSetting('custom_flag');
      expect(after).toBe(true);
    });

    it('should overwrite an existing key', async () => {
      await store.setSetting('threshold', 100);
      await store.setSetting('threshold', 999);

      const value = await store.getSetting('threshold');
      expect(value).toBe(999);
    });

    it('should delete a key', async () => {
      await store.setSetting('temp_key', 'hello');
      expect(await store.getSetting('temp_key')).toBe('hello');

      await store.deleteSetting('temp_key');
      expect(await store.getSetting('temp_key')).toBeUndefined();
    });

    it('should return all settings via getAllSettings', async () => {
      const all = await store.getAllSettings();
      expect(all.project_name).toBe('KVTest');
      expect(all.tail_spend_threshold).toBe(10000);
    });

    it('should handle JSON object values', async () => {
      const ctx = { industry: 'Tech', sector: 'SaaS' };
      await store.setSetting('company_context', ctx);

      const retrieved = await store.getSetting('company_context');
      expect(retrieved).toEqual(ctx);
    });
  });

  describe('selectSavePath', () => {
    it('should return the chosen file path', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: '/tmp/test-project.c91',
      });

      const result = await store.selectSavePath();
      expect(result).toBe('/tmp/test-project.c91');
    });

    it('should return null when the user cancels', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: true,
        filePath: undefined as unknown as string,
      });

      const result = await store.selectSavePath();
      expect(result).toBeNull();
    });
  });

  describe('selectOpenPath', () => {
    it('should return the chosen file path', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ['/tmp/existing-project.c91'],
      });

      const result = await store.selectOpenPath();
      expect(result).toBe('/tmp/existing-project.c91');
    });

    it('should return null when the user cancels', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await store.selectOpenPath();
      expect(result).toBeNull();
    });
  });
});
