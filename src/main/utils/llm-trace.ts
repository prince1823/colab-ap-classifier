import { appendFileSync } from 'fs';

export type TraceAgentType =
  | 'classification-category'
  | 'classification-l3'
  | 'classification-tailspend-category'
  | 'classification-tailspend-l3'
  | 'research'
  | 'column-mapping'
  | 'qc'
  | 'cat-a';

export interface TraceEntry {
  timestamp: string;
  agent: TraceAgentType;
  supplier?: string;
  batchIndex?: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  elapsedMs: number;
  tokenEstimate?: { input: number; output: number };
  error?: string;
}

const TRACE_FILE = process.env.LLM_TRACE_FILE ?? null;

/**
 * Append a trace entry to the JSONL trace file.
 * Noop when LLM_TRACE_FILE env var is unset — zero overhead in production.
 */
export function traceLog(entry: TraceEntry): void {
  if (!TRACE_FILE) return;
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(TRACE_FILE, line);
}

/**
 * Check if tracing is enabled.
 */
export function isTraceEnabled(): boolean {
  return TRACE_FILE !== null;
}
