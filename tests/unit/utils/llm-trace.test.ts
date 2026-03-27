import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('llm-trace', () => {
  const traceFile = join(tmpdir(), `c91-trace-test-${Date.now()}.jsonl`);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (existsSync(traceFile)) {
      unlinkSync(traceFile);
    }
  });

  it('is a noop when LLM_TRACE_FILE is unset', async () => {
    vi.stubEnv('LLM_TRACE_FILE', '');
    // Force re-import to pick up env
    const { traceLog, isTraceEnabled } = await import('../../../src/main/utils/llm-trace');
    // Empty string is falsy — but the module checks ?? null, let's test undefined
    vi.unstubAllEnvs();
    vi.resetModules();
    delete process.env.LLM_TRACE_FILE;
    const mod = await import('../../../src/main/utils/llm-trace');
    expect(mod.isTraceEnabled()).toBe(false);
    // Should not throw
    mod.traceLog({
      timestamp: new Date().toISOString(),
      agent: 'research',
      model: 'test',
      systemPrompt: 'sys',
      userPrompt: 'user',
      response: 'resp',
      elapsedMs: 100,
    });
    expect(existsSync(traceFile)).toBe(false);
  });

  it('writes JSONL entries when LLM_TRACE_FILE is set', async () => {
    vi.stubEnv('LLM_TRACE_FILE', traceFile);
    vi.resetModules();
    const { traceLog, isTraceEnabled } = await import('../../../src/main/utils/llm-trace');
    expect(isTraceEnabled()).toBe(true);

    const entry1 = {
      timestamp: '2026-03-25T10:00:00.000Z',
      agent: 'research' as const,
      supplier: 'Acme Corp',
      model: 'claude-3-5-haiku',
      systemPrompt: 'You are a research agent.',
      userPrompt: 'Research Acme Corp',
      response: '{"supplierType": "company"}',
      elapsedMs: 500,
    };

    const entry2 = {
      timestamp: '2026-03-25T10:00:01.000Z',
      agent: 'classification-l3' as const,
      supplier: 'Acme Corp',
      batchIndex: 0,
      model: 'claude-3-5-haiku',
      systemPrompt: 'You are a classifier.',
      userPrompt: 'Classify these transactions',
      response: '{"classifications": [], "assignments": {}}',
      elapsedMs: 1200,
      tokenEstimate: { input: 500, output: 200 },
    };

    traceLog(entry1);
    traceLog(entry2);

    expect(existsSync(traceFile)).toBe(true);
    const content = readFileSync(traceFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    expect(parsed1.agent).toBe('research');
    expect(parsed1.supplier).toBe('Acme Corp');
    expect(parsed1.elapsedMs).toBe(500);
    expect(parsed1.systemPrompt).toBe('You are a research agent.');

    const parsed2 = JSON.parse(lines[1]);
    expect(parsed2.agent).toBe('classification-l3');
    expect(parsed2.batchIndex).toBe(0);
    expect(parsed2.tokenEstimate).toEqual({ input: 500, output: 200 });
  });

  it('trace entries contain all required fields', async () => {
    vi.stubEnv('LLM_TRACE_FILE', traceFile);
    vi.resetModules();
    const { traceLog } = await import('../../../src/main/utils/llm-trace');

    traceLog({
      timestamp: '2026-03-25T10:00:00.000Z',
      agent: 'column-mapping',
      model: 'gpt-4o-mini',
      systemPrompt: 'sys',
      userPrompt: 'user',
      response: 'resp',
      elapsedMs: 300,
    });

    const content = readFileSync(traceFile, 'utf-8');
    const parsed = JSON.parse(content.trim());

    // All required fields present
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('agent');
    expect(parsed).toHaveProperty('model');
    expect(parsed).toHaveProperty('systemPrompt');
    expect(parsed).toHaveProperty('userPrompt');
    expect(parsed).toHaveProperty('response');
    expect(parsed).toHaveProperty('elapsedMs');

    // Optional fields should not be present when not set
    expect(parsed).not.toHaveProperty('supplier');
    expect(parsed).not.toHaveProperty('batchIndex');
    expect(parsed).not.toHaveProperty('tokenEstimate');
  });
});
