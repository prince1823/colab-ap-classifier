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

// Mock supplierUniverseService to avoid real DB side-effects
vi.mock('../../../src/main/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/services/database')>();
  return {
    ...actual,
    supplierUniverseService: {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      isOpen: vi.fn(() => false),
    },
  };
});

// Mock transactions module to avoid importing the full module.
// getColumns must return an array of strings for ensureIndexes.
vi.mock('../../../src/main/services/transactions', () => ({
  invalidateColumnCache: vi.fn(),
  getColumns: vi.fn().mockResolvedValue(['row_index', 'classification_status']),
}));

import { dialog } from 'electron';
import { databaseService } from '../../../src/main/services/database';
import {
  createProject,
  openProject,
  closeProject,
  isProjectOpen,
  getSetting,
  setSetting,
  deleteSetting,
  getAllSettings,
  selectSavePath,
  selectOpenPath,
} from '../../../src/main/services/project';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'project-test-'));
}

describe('ProjectService', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir();
  });

  afterEach(async () => {
    if (isProjectOpen()) {
      await closeProject();
    }
    // Clean up temp directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // createProject
  // -----------------------------------------------------------------------
  describe('createProject', () => {
    it('should create a .c91 file and initialise schema', async () => {
      const filePath = path.join(testDir, 'projects', 'TestProject.c91');

      const result = await createProject('TestProject', filePath);

      expect(result.filePath).toBe(filePath);
      expect(result.name).toBe('TestProject');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(isProjectOpen()).toBe(true);

      // Verify schema was initialised (project_settings KV table seeded)
      const name = await getSetting('project_name');
      expect(name).toBe('TestProject');
      const threshold = await getSetting('tail_spend_threshold');
      expect(threshold).toBe(10000);
    });

    it('should create the parent directory if it does not exist', async () => {
      const projectsDir = path.join(testDir, 'projects');
      expect(fs.existsSync(projectsDir)).toBe(false);

      const filePath = path.join(projectsDir, 'NewProject.c91');
      await createProject('NewProject', filePath);

      expect(fs.existsSync(projectsDir)).toBe(true);
    });

    it('should throw if project name is empty', async () => {
      const filePath = path.join(testDir, 'Empty.c91');
      await expect(createProject('', filePath)).rejects.toThrow(
        'Project name must not be empty'
      );
    });

    it('should throw if project file already exists', async () => {
      const filePath = path.join(testDir, 'projects', 'Duplicate.c91');

      await createProject('Duplicate', filePath);
      await closeProject();

      await expect(createProject('Duplicate', filePath)).rejects.toThrow(
        'Project file already exists'
      );
    });
  });

  // -----------------------------------------------------------------------
  // openProject
  // -----------------------------------------------------------------------
  describe('openProject', () => {
    it('should open an existing .c91 file and return name', async () => {
      const filePath = path.join(testDir, 'projects', 'OpenMe.c91');

      // Create a project first, then close and re-open
      const created = await createProject('OpenMe', filePath);
      await closeProject();

      const opened = await openProject(created.filePath);

      expect(opened.filePath).toBe(created.filePath);
      expect(opened.name).toBe('OpenMe');
      expect(isProjectOpen()).toBe(true);
    });

    it('should read settings after opening', async () => {
      const filePath = path.join(testDir, 'projects', 'MetaTest.c91');

      await createProject('MetaTest', filePath);
      await closeProject();

      await openProject(filePath);

      const name = await getSetting('project_name');
      expect(name).toBe('MetaTest');
      const threshold = await getSetting('tail_spend_threshold');
      expect(threshold).toBe(10000);
    });

    it('should throw if file does not exist', async () => {
      const fakePath = path.join(testDir, 'nonexistent.c91');
      await expect(openProject(fakePath)).rejects.toThrow(
        'Project file not found'
      );
    });

    it('should throw if file path is empty', async () => {
      await expect(openProject('')).rejects.toThrow(
        'File path must not be empty'
      );
    });

    it('should derive name from filename when project row is missing', async () => {
      // Create a raw DuckDB file with schema but no project row at all.
      // openDatabase initializes the schema tables but does not insert a project row.
      const rawPath = path.join(testDir, 'RawProject.c91');
      await databaseService.openDatabase(rawPath);
      await databaseService.closeDatabase();

      const opened = await openProject(rawPath);
      expect(opened.name).toBe('RawProject');
    });
  });

  // -----------------------------------------------------------------------
  // closeProject
  // -----------------------------------------------------------------------
  describe('closeProject', () => {
    it('should close the database and clear state', async () => {
      const filePath = path.join(testDir, 'projects', 'CloseMe.c91');

      await createProject('CloseMe', filePath);
      expect(isProjectOpen()).toBe(true);

      await closeProject();
      expect(isProjectOpen()).toBe(false);
    });

    it('should cause operations to throw after close', async () => {
      const filePath = path.join(testDir, 'projects', 'ThrowAfterClose.c91');

      await createProject('ThrowAfterClose', filePath);
      await closeProject();

      await expect(getSetting('project_name')).rejects.toThrow(
        'No project is currently open'
      );

      await expect(
        setSetting('tail_spend_threshold', 5000)
      ).rejects.toThrow('No project is currently open');
    });
  });

  // -----------------------------------------------------------------------
  // isProjectOpen
  // -----------------------------------------------------------------------
  describe('isProjectOpen', () => {
    it('should return false when no project has been opened', () => {
      expect(isProjectOpen()).toBe(false);
    });

    it('should return true when a project is open', async () => {
      const filePath = path.join(testDir, 'projects', 'IsOpenTest.c91');

      await createProject('IsOpenTest', filePath);
      expect(isProjectOpen()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Settings KV CRUD
  // -----------------------------------------------------------------------
  describe('Settings KV CRUD', () => {
    beforeEach(async () => {
      const filePath = path.join(testDir, 'projects', 'KVTest.c91');
      await createProject('KVTest', filePath);
    });

    it('should create a new key when setSetting is called with a non-existent key', async () => {
      // Key does not exist yet
      const before = await getSetting('custom_flag');
      expect(before).toBeUndefined();

      // setSetting should insert (not throw)
      await setSetting('custom_flag', true);

      const after = await getSetting('custom_flag');
      expect(after).toBe(true);
    });

    it('should overwrite an existing key on subsequent setSetting calls', async () => {
      await setSetting('threshold', 100);
      await setSetting('threshold', 999);

      const value = await getSetting('threshold');
      expect(value).toBe(999);
    });

    it('should return undefined for a key that was never set', async () => {
      const value = await getSetting('nonexistent_key');
      expect(value).toBeUndefined();
    });

    it('should delete a key and return undefined after deletion', async () => {
      await setSetting('temp_key', 'hello');
      expect(await getSetting('temp_key')).toBe('hello');

      await deleteSetting('temp_key');
      expect(await getSetting('temp_key')).toBeUndefined();
    });

    it('should not throw when deleting a non-existent key', async () => {
      await expect(deleteSetting('never_existed')).resolves.toBeUndefined();
    });

    it('should return all settings via getAllSettings', async () => {
      // project_name and tail_spend_threshold are seeded by createProject
      const all = await getAllSettings();
      expect(all.project_name).toBe('KVTest');
      expect(all.tail_spend_threshold).toBe(10000);
    });

    it('should handle JSON object values', async () => {
      const ctx = { industry: 'Tech', sector: 'SaaS' };
      await setSetting('company_context', ctx);

      const retrieved = await getSetting('company_context');
      expect(retrieved).toEqual(ctx);
    });
  });

  // -----------------------------------------------------------------------
  // File Dialog mocking
  // -----------------------------------------------------------------------
  describe('selectSavePath', () => {
    it('should return the chosen file path', async () => {
      const mockDialog = vi.mocked(dialog.showSaveDialog);
      mockDialog.mockResolvedValue({
        canceled: false,
        filePath: '/tmp/test-project.c91',
      });

      const result = await selectSavePath();
      expect(result).toBe('/tmp/test-project.c91');
      expect(mockDialog).toHaveBeenCalledOnce();
    });

    it('should return null when the user cancels', async () => {
      const mockDialog = vi.mocked(dialog.showSaveDialog);
      mockDialog.mockResolvedValue({
        canceled: true,
        filePath: undefined as unknown as string,
      });

      const result = await selectSavePath();
      expect(result).toBeNull();
    });
  });

  describe('selectOpenPath', () => {
    it('should return the chosen file path', async () => {
      const mockDialog = vi.mocked(dialog.showOpenDialog);
      mockDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/tmp/existing-project.c91'],
      });

      const result = await selectOpenPath();
      expect(result).toBe('/tmp/existing-project.c91');
      expect(mockDialog).toHaveBeenCalledOnce();
    });

    it('should return null when the user cancels', async () => {
      const mockDialog = vi.mocked(dialog.showOpenDialog);
      mockDialog.mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await selectOpenPath();
      expect(result).toBeNull();
    });
  });
});
