import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock supplier-research ──────────────────────────────────────────────────

const mockResearchAll = vi.fn();
const mockCancelResearch = vi.fn();

vi.mock('../../../src/main/services/supplier-research', () => ({
  researchAllProjectSuppliers: (...args: unknown[]) => mockResearchAll(...args),
  cancel: () => mockCancelResearch(),
  setMainWindow: vi.fn(),
}));

// ── Mock classification ─────────────────────────────────────────────────────

const mockStartClassification = vi.fn();
const mockCancelClassification = vi.fn();

vi.mock('../../../src/main/services/classification', () => ({
  startClassification: (...args: unknown[]) => mockStartClassification(...args),
  cancel: () => mockCancelClassification(),
  setMainWindow: vi.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import {
  startPipeline,
  approve,
  cancel,
  setMainWindow,
  getIsRunning,
  getPhase,
} from '../../../src/main/services/pipeline';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockWindow() {
  return {
    webContents: {
      send: vi.fn(),
    },
  };
}

function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getProgressCalls(mockWindow: ReturnType<typeof createMockWindow>) {
  return mockWindow.webContents.send.mock.calls
    .filter((call: unknown[]) => call[0] === 'classification:progress')
    .map((call: unknown[]) => call[1] as Record<string, unknown>);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Pipeline mediator', () => {
  let mockWindow: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = createMockWindow();
    setMainWindow(mockWindow);
  });

  afterEach(async () => {
    setMainWindow(null);
  });

  it('should run research → awaiting_approval → approve → classification', async () => {
    mockResearchAll.mockResolvedValue(undefined);
    mockStartClassification.mockResolvedValue(undefined);

    const pipelinePromise = startPipeline();
    await settle(50);

    // Should have emitted awaiting_approval
    const progressCalls = getProgressCalls(mockWindow);
    const awaitingCall = progressCalls.find(p => p.status === 'awaiting_approval');
    expect(awaitingCall).toBeDefined();
    expect(awaitingCall?.currentStep).toContain('Review suppliers');

    // Approve to continue
    approve();
    await pipelinePromise;

    // Classification should have been called with the same runId
    expect(mockStartClassification).toHaveBeenCalledTimes(1);
    const classRunId = mockStartClassification.mock.calls[0][0];
    expect(typeof classRunId).toBe('string');

    // Verify runId is consistent across phases
    const researchProgress = progressCalls.find(p => p.phase === 'researching' && p.status === 'running');
    expect(researchProgress?.runId).toBe(classRunId);
  });

  it('should cancel during research phase', async () => {
    // Use a deferred so we can control when research resolves
    const researchDeferred = createDeferred();
    mockResearchAll.mockImplementation(() => researchDeferred.promise);

    const pipelinePromise = startPipeline();
    await settle(10);

    expect(getIsRunning()).toBe(true);
    expect(getPhase()).toBe('researching');

    await cancel();

    expect(mockCancelResearch).toHaveBeenCalled();

    const progressCalls = getProgressCalls(mockWindow);
    const cancelledCall = progressCalls.find(p => p.status === 'cancelled');
    expect(cancelledCall).toBeDefined();

    // Resolve the deferred so pipeline can exit its finally block
    researchDeferred.resolve();
    await settle(50);
  });

  it('should cancel while awaiting approval', async () => {
    mockResearchAll.mockResolvedValue(undefined);

    const pipelinePromise = startPipeline();
    await settle(50);

    expect(getPhase()).toBe('awaiting_approval');

    await cancel();

    // Wait for the rejection to propagate
    await settle(50);

    // Pipeline should have exited without calling classification
    expect(mockStartClassification).not.toHaveBeenCalled();

    const progressCalls = getProgressCalls(mockWindow);
    const cancelledCall = progressCalls.find(p => p.status === 'cancelled');
    expect(cancelledCall).toBeDefined();
  });

  it('should cancel during classification phase', async () => {
    mockResearchAll.mockResolvedValue(undefined);

    const classDeferred = createDeferred();
    mockStartClassification.mockImplementation(() => classDeferred.promise);

    const pipelinePromise = startPipeline();
    await settle(50);

    // Approve to start classification
    approve();
    await settle(50);

    expect(getPhase()).toBe('classifying');

    await cancel();
    await settle(50);

    expect(mockCancelClassification).toHaveBeenCalled();

    // Resolve so pipeline can exit
    classDeferred.resolve();
    await settle(50);
  });

  it('should use a single runId across all phases', async () => {
    mockResearchAll.mockResolvedValue(undefined);
    mockStartClassification.mockResolvedValue(undefined);

    const pipelinePromise = startPipeline();
    await settle(50);
    approve();
    await pipelinePromise;

    const progressCalls = getProgressCalls(mockWindow);
    const runIds = new Set(progressCalls.map(p => p.runId));
    expect(runIds.size).toBe(1);

    const classRunId = mockStartClassification.mock.calls[0][0];
    expect(runIds.has(classRunId)).toBe(true);
  });

  it('should reach awaiting_approval even if research fails', async () => {
    mockResearchAll.mockRejectedValue(new Error('Research exploded'));
    mockStartClassification.mockResolvedValue(undefined);

    const pipelinePromise = startPipeline();
    await settle(50);

    const progressCalls = getProgressCalls(mockWindow);
    const awaitingCall = progressCalls.find(p => p.status === 'awaiting_approval');
    expect(awaitingCall).toBeDefined();

    approve();
    await pipelinePromise;

    expect(mockStartClassification).toHaveBeenCalled();
  });

  it('should reject if pipeline is already running', async () => {
    const researchDeferred = createDeferred();
    mockResearchAll.mockImplementation(() => researchDeferred.promise);

    const first = startPipeline();
    await settle(10);

    await expect(startPipeline()).rejects.toThrow('Pipeline is already running');

    await cancel();
    researchDeferred.resolve();
    await settle(50);
  });

  it('should relay research progress via onProgress callback', async () => {
    let capturedCallback: ((...args: unknown[]) => void) | null = null;
    mockResearchAll.mockImplementation(async (cb: (...args: unknown[]) => void) => {
      capturedCallback = cb;
      cb(1, 5, 'Acme Corp', 'Researching: Acme Corp');
      cb(2, 5, 'Globex', 'Researching: Globex');
    });
    mockStartClassification.mockResolvedValue(undefined);

    const pipelinePromise = startPipeline();
    await settle(50);

    expect(capturedCallback).not.toBeNull();

    const progressCalls = getProgressCalls(mockWindow);
    const researchProgress = progressCalls.filter(
      p => p.phase === 'researching' && p.status === 'running'
    );
    expect(researchProgress.length).toBeGreaterThanOrEqual(2);

    approve();
    await pipelinePromise;
  });
});
