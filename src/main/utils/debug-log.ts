import { appendFileSync } from 'fs';

const LOG_FILE = process.env.LOG_FILE ?? null;

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function debugLog(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: unknown) {
  if (!LOG_FILE) return;
  const line = `[${ts()}] ${level.padEnd(5)} ${msg}${data !== undefined ? ' ' + JSON.stringify(data, null, 0) : ''}\n`;
  appendFileSync(LOG_FILE, line);
}
