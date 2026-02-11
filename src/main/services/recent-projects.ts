import fs from 'fs';
import path from 'path';
import os from 'os';
import type { RecentProject } from '../../shared/types/project';

const MAX_RECENT_PROJECTS = 20;

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'Colab91 Classifier');
const DEFAULT_FILE_PATH = path.join(DEFAULT_CONFIG_DIR, 'recent-projects.json');

/** Mutable path references — overridable via _setStoragePath for testing. */
export const _paths = {
  configDir: DEFAULT_CONFIG_DIR,
  filePath: DEFAULT_FILE_PATH,
};

/**
 * Read the recent-projects.json file and return parsed entries.
 * Returns an empty array if the file is missing or contains invalid JSON.
 */
function readRecentProjects(): RecentProject[] {
  try {
    if (!fs.existsSync(_paths.filePath)) {
      return [];
    }
    const raw = fs.readFileSync(_paths.filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as RecentProject[];
  } catch {
    // Corrupt or unreadable file — return empty array gracefully
    return [];
  }
}

/**
 * Write the recent projects list to disk.
 * Ensures the config directory exists before writing.
 */
function writeRecentProjects(projects: RecentProject[]): void {
  if (!fs.existsSync(_paths.configDir)) {
    fs.mkdirSync(_paths.configDir, { recursive: true });
  }
  fs.writeFileSync(_paths.filePath, JSON.stringify(projects, null, 2), 'utf-8');
}

/**
 * Return all recent projects, sorted by lastOpened descending (most recent first).
 */
export async function listRecent(): Promise<RecentProject[]> {
  const projects = readRecentProjects();
  return projects.sort(
    (a, b) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime()
  );
}

/**
 * Add or update a recent project entry.
 *
 * If the project path already exists, its lastOpened timestamp and name are updated.
 * The list is capped at MAX_RECENT_PROJECTS entries.
 */
export async function addRecent(filePath: string, name: string): Promise<void> {
  const projects = readRecentProjects();

  // Remove existing entry for this path (if any) to avoid duplicates
  const filtered = projects.filter((p) => p.path !== filePath);

  // Add the new/updated entry at the front
  filtered.unshift({
    path: filePath,
    name,
    lastOpened: new Date().toISOString(),
  });

  // Enforce the max limit
  const trimmed = filtered.slice(0, MAX_RECENT_PROJECTS);

  writeRecentProjects(trimmed);
}

/**
 * Remove a single project from the recent list by its file path.
 */
export async function removeRecent(filePath: string): Promise<void> {
  const projects = readRecentProjects();
  const filtered = projects.filter((p) => p.path !== filePath);
  writeRecentProjects(filtered);
}

/**
 * Clear all recent project entries.
 */
export async function clearRecent(): Promise<void> {
  writeRecentProjects([]);
}

/**
 * Override the storage directory used for recent-projects.json.
 * Useful for testing. Returns a restore function that resets to the original paths.
 */
export function _setStoragePath(dir: string): () => void {
  const prevConfigDir = _paths.configDir;
  const prevFilePath = _paths.filePath;

  _paths.configDir = dir;
  _paths.filePath = path.join(dir, 'recent-projects.json');

  return () => {
    _paths.configDir = prevConfigDir;
    _paths.filePath = prevFilePath;
  };
}
