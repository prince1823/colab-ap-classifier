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
  BrowserWindow: vi.fn(),
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
      // Override cwd so the projects dir is created under our temp dir
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      const result = await createProject('TestProject');

      const expectedPath = path.join(testDir, 'projects', 'TestProject.c91');
      expect(result.filePath).toBe(expectedPath);
      expect(result.name).toBe('TestProject');
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(isProjectOpen()).toBe(true);

      // Verify schema was initialised (settings table exists with seeded data)
      const threshold = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'tail_spend_threshold'"
      );
      expect(threshold?.value).toBe('10000');

      // Verify project_name was stored
      const nameSetting = await databaseService.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'project_name'"
      );
      expect(nameSetting?.value).toBe('TestProject');

      cwdSpy.mockRestore();
    });

    it('should create the projects directory if it does not exist', async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      const projectsDir = path.join(testDir, 'projects');
      expect(fs.existsSync(projectsDir)).toBe(false);

      await createProject('NewProject');

      expect(fs.existsSync(projectsDir)).toBe(true);

      cwdSpy.mockRestore();
    });

    it('should throw if project name is empty', async () => {
      await expect(createProject('')).rejects.toThrow(
        'Project name must not be empty'
      );
    });

    it('should throw if project file already exists', async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      await createProject('Duplicate');
      await closeProject();

      await expect(createProject('Duplicate')).rejects.toThrow(
        'Project file already exists'
      );

      cwdSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // openProject
  // -----------------------------------------------------------------------
  describe('openProject', () => {
    it('should open an existing .c91 file and return name', async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      // Create a project first, then close and re-open
      const created = await createProject('OpenMe');
      await closeProject();

      const opened = await openProject(created.filePath);

      expect(opened.filePath).toBe(created.filePath);
      expect(opened.name).toBe('OpenMe');
      expect(isProjectOpen()).toBe(true);

      cwdSpy.mockRestore();
    });

    it('should read metadata after opening', async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      await createProject('MetaTest');
      await closeProject();

      const filePath = path.join(testDir, 'projects', 'MetaTest.c91');
      await openProject(filePath);

      const metadata = await getMetadata();
      expect(metadata.name).toBe('MetaTest');
      expect(metadata.filePath).toBe(filePath);
      expect(metadata.tailSpendThreshold).toBe(10000);

      cwdSpy.mockRestore();
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

    it('should derive name from filename when project_name setting is missing', async () => {
      // Create a raw DuckDB file with schema but no project_name setting
      const rawPath = path.join(testDir, 'RawProject.c91');
      await databaseService.openDatabase(rawPath);
      // databaseService.openDatabase already initialises schema & seeds
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
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      await createProject('CloseMe');
      expect(isProjectOpen()).toBe(true);

      await closeProject();
      expect(isProjectOpen()).toBe(false);

      cwdSpy.mockRestore();
    });

    it('should cause operations to throw after close', async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      await createProject('ThrowAfterClose');
      await closeProject();

      await expect(getMetadata()).rejects.toThrow(
        'No project is currently open'
      );

      await expect(
        updateMetadata({ tailSpendThreshold: 5000 })
      ).rejects.toThrow('No project is currently open');

      cwdSpy.mockRestore();
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
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

      await createProject('IsOpenTest');
      expect(isProjectOpen()).toBe(true);

      cwdSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // getMetadata / updateMetadata roundtrip
  // -----------------------------------------------------------------------
  describe('Metadata roundtrip', () => {
    beforeEach(async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);
      await createProject('MetaRoundtrip');
      cwdSpy.mockRestore();
    });

    it('should return default metadata for a new project', async () => {
      const metadata = await getMetadata();

      expect(metadata.name).toBe('MetaRoundtrip');
      expect(metadata.companyContext).toBeNull();
      expect(metadata.columnMappings).toBeNull();
      expect(metadata.invoiceGroupingColumns).toBeNull();
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
