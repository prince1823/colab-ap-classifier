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
  getMetadata,
  updateMetadata,
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

      // Verify schema was initialised (project table exists with seeded data)
      const row = await databaseService.get<{
        project_name: string;
        tail_spend_threshold: number;
      }>('SELECT project_name, tail_spend_threshold FROM project LIMIT 1');
      expect(row?.project_name).toBe('TestProject');
      expect(Number(row?.tail_spend_threshold)).toBe(10000);
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

    it('should read metadata after opening', async () => {
      const filePath = path.join(testDir, 'projects', 'MetaTest.c91');

      await createProject('MetaTest', filePath);
      await closeProject();

      await openProject(filePath);

      const metadata = await getMetadata();
      expect(metadata.projectName).toBe('MetaTest');
      expect(metadata.tailSpendThreshold).toBe(10000);
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

      await expect(getMetadata()).rejects.toThrow(
        'No project is currently open'
      );

      await expect(
        updateMetadata({ tailSpendThreshold: 5000 })
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
  // getMetadata / updateMetadata roundtrip
  // -----------------------------------------------------------------------
  describe('Metadata roundtrip', () => {
    let projectFilePath: string;

    beforeEach(async () => {
      projectFilePath = path.join(testDir, 'projects', 'MetaRoundtrip.c91');
      await createProject('MetaRoundtrip', projectFilePath);
    });

    it('should return default metadata for a new project', async () => {
      const metadata = await getMetadata();

      expect(metadata.projectName).toBe('MetaRoundtrip');
      expect(metadata.companyContext).toBeNull();
      expect(metadata.columnMapping).toBeNull();
      expect(metadata.tailSpendThreshold).toBe(10000);
      expect(metadata.taxonomyName).toBeNull();
      expect(metadata.createdAt).toBeTruthy();
    });

    it('should update and retrieve company context', async () => {
      const companyContext = {
        industry: 'Healthcare',
        sector: 'Medical Devices',
        description: 'A healthcare company',
        businessFocus: 'Medical equipment manufacturing',
        procurementNuances: 'Strict vendor qualifications required',
      };

      await updateMetadata({ companyContext });
      const metadata = await getMetadata();

      expect(metadata.companyContext).toEqual(companyContext);
    });

    it('should update and retrieve company context with companyName', async () => {
      const companyContext = {
        companyName: 'Acme Corp',
        industry: 'Manufacturing',
        sector: 'Industrial Equipment',
      };

      await updateMetadata({ companyContext });
      const metadata = await getMetadata();

      expect(metadata.companyContext).toEqual(companyContext);
      expect(metadata.companyContext!.companyName).toBe('Acme Corp');
    });

    it('should return undefined companyName when not set', async () => {
      const companyContext = {
        industry: 'Tech',
      };

      await updateMetadata({ companyContext });
      const metadata = await getMetadata();

      expect(metadata.companyContext!.industry).toBe('Tech');
      expect(metadata.companyContext!.companyName).toBeUndefined();
    });

    it('should update and retrieve tail spend threshold', async () => {
      await updateMetadata({ tailSpendThreshold: 25000 });
      const metadata = await getMetadata();

      expect(metadata.tailSpendThreshold).toBe(25000);
    });

    it('should update both company context and threshold together', async () => {
      const companyContext = {
        industry: 'Finance',
        sector: 'Banking',
      };

      await updateMetadata({ companyContext, tailSpendThreshold: 50000 });
      const metadata = await getMetadata();

      expect(metadata.companyContext!.industry).toBe('Finance');
      expect(metadata.companyContext!.sector).toBe('Banking');
      expect(metadata.tailSpendThreshold).toBe(50000);
    });

    it('should persist metadata across close/reopen cycle', async () => {
      const companyContext = {
        industry: 'Retail',
        description: 'A retail company',
      };
      await updateMetadata({ companyContext, tailSpendThreshold: 7500 });

      const filePath = databaseService.getFilePath()!;
      await closeProject();
      await openProject(filePath);

      const metadata = await getMetadata();
      expect(metadata.companyContext!.industry).toBe('Retail');
      expect(metadata.companyContext!.description).toBe('A retail company');
      expect(metadata.tailSpendThreshold).toBe(7500);
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
