import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  listRecent,
  addRecent,
  removeRecent,
  clearRecent,
  _setStoragePath,
  _paths,
} from '../../../src/main/services/recent-projects';

let tmpDir: string;
let restorePaths: () => void;

beforeEach(() => {
  // Create a unique temp directory for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-projects-test-'));
  restorePaths = _setStoragePath(tmpDir);
});

afterEach(() => {
  // Restore original paths
  restorePaths();

  // Clean up temp directory
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('listRecent', () => {
  it('should return an empty array when no projects file exists', async () => {
    const result = await listRecent();
    expect(result).toEqual([]);
  });

  it('should return projects sorted by lastOpened descending', async () => {
    await addRecent('/path/to/older.c91', 'Older Project');
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await addRecent('/path/to/newer.c91', 'Newer Project');

    const result = await listRecent();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Newer Project');
    expect(result[1].name).toBe('Older Project');
  });
});

describe('addRecent', () => {
  it('should add a project and list returns it', async () => {
    await addRecent('/path/to/project.c91', 'My Project');

    const result = await listRecent();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: '/path/to/project.c91',
      name: 'My Project',
    });
    expect(result[0].lastOpened).toBeTruthy();
  });

  it('should update lastOpened when adding the same project twice (no duplicate)', async () => {
    await addRecent('/path/to/project.c91', 'My Project');
    const firstList = await listRecent();
    const firstTimestamp = firstList[0].lastOpened;

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    await addRecent('/path/to/project.c91', 'My Project');
    const secondList = await listRecent();

    // Should still be only one entry
    expect(secondList).toHaveLength(1);
    expect(secondList[0].path).toBe('/path/to/project.c91');

    // Timestamp should be updated
    expect(new Date(secondList[0].lastOpened).getTime()).toBeGreaterThan(
      new Date(firstTimestamp).getTime()
    );
  });

  it('should enforce a maximum of 20 entries', async () => {
    // Add 22 projects
    for (let i = 0; i < 22; i++) {
      await addRecent(`/path/to/project-${i}.c91`, `Project ${i}`);
    }

    const result = await listRecent();
    expect(result).toHaveLength(20);

    // The most recent should be project-21 (last added)
    expect(result[0].path).toBe('/path/to/project-21.c91');

    // The oldest kept should be project-2 (project-0 and project-1 were evicted)
    expect(result[19].path).toBe('/path/to/project-2.c91');
  });
});

describe('removeRecent', () => {
  it('should remove a project by path', async () => {
    await addRecent('/path/to/project-a.c91', 'Project A');
    await addRecent('/path/to/project-b.c91', 'Project B');

    await removeRecent('/path/to/project-a.c91');

    const result = await listRecent();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/path/to/project-b.c91');
  });

  it('should not throw when removing a non-existent path', async () => {
    await addRecent('/path/to/project.c91', 'Project');

    await expect(removeRecent('/non/existent.c91')).resolves.not.toThrow();

    const result = await listRecent();
    expect(result).toHaveLength(1);
  });
});

describe('clearRecent', () => {
  it('should remove all entries', async () => {
    await addRecent('/path/to/project-a.c91', 'Project A');
    await addRecent('/path/to/project-b.c91', 'Project B');
    await addRecent('/path/to/project-c.c91', 'Project C');

    await clearRecent();

    const result = await listRecent();
    expect(result).toEqual([]);
  });

  it('should not throw when clearing an already-empty list', async () => {
    await expect(clearRecent()).resolves.not.toThrow();

    const result = await listRecent();
    expect(result).toEqual([]);
  });
});

describe('corrupt JSON file', () => {
  it('should return an empty array when the JSON file is corrupt', async () => {
    // Write invalid JSON to the storage file
    fs.writeFileSync(_paths.filePath, '{{not valid json!!!', 'utf-8');

    const result = await listRecent();
    expect(result).toEqual([]);
  });

  it('should return an empty array when the JSON file contains a non-array', async () => {
    fs.writeFileSync(_paths.filePath, JSON.stringify({ foo: 'bar' }), 'utf-8');

    const result = await listRecent();
    expect(result).toEqual([]);
  });

  it('should recover from corrupt file by writing new data', async () => {
    // Write corrupt data
    fs.writeFileSync(_paths.filePath, 'corrupt data here', 'utf-8');

    // Adding a project should overwrite the corrupt file
    await addRecent('/path/to/project.c91', 'Recovery Project');

    const result = await listRecent();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Recovery Project');
  });
});
