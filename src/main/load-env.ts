/**
 * Lightweight .env loader — no external dependencies.
 *
 * Reads the .env file from the project root and populates process.env.
 * Only sets variables that are NOT already in the environment (so real
 * env vars always win). Handles comments (#), blank lines, and simple
 * KEY=VALUE pairs.
 *
 * Call this as early as possible — before importing any service that
 * reads process.env at module-load time (e.g., settings.ts).
 */
import fs from 'fs';
import path from 'path';

let loaded = false;

export function loadEnv(rootDir?: string): void {
  if (loaded) return;

  // __dirname is dist/main/main/ after compilation, so go up 3 levels to project root
  const root = rootDir ?? path.resolve(__dirname, '..', '..', '..');
  const envPath = path.join(root, '.env');

  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    // Only set if not already defined — real env vars always take precedence
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  loaded = true;
}

/**
 * Reset the loaded flag (for testing only).
 */
export function resetEnvLoaded(): void {
  loaded = false;
}
