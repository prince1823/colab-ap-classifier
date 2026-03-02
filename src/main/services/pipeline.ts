import { randomUUID } from 'crypto';
import { researchAllProjectSuppliers, cancel as cancelResearch } from './supplier-research';
import { startClassification, cancel as cancelClassification } from './classification';
import type { ClassificationProgress } from '../../shared/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isRunning = false;
let isCancelled = false;
let currentRunId = '';
let currentPhase: 'researching' | 'awaiting_approval' | 'classifying' = 'researching';

let mainWindowRef: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null = null;

let approvalResolver: (() => void) | null = null;
let approvalRejecter: ((reason?: unknown) => void) | null = null;

export function setMainWindow(win: { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null): void {
  mainWindowRef = win;
}

// ---------------------------------------------------------------------------
// Progress emission
// ---------------------------------------------------------------------------

function emitProgress(progress: Partial<ClassificationProgress>): void {
  if (mainWindowRef) {
    const full: ClassificationProgress = {
      runId: currentRunId,
      phase: currentPhase === 'classifying' ? 'classifying' : 'researching',
      status: 'running',
      totalSuppliers: 0,
      processedSuppliers: 0,
      percentage: 0,
      currentSupplier: null,
      currentStep: '',
      ...progress,
    };
    mainWindowRef.webContents.send('pipeline:progress', full);
  }
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

function waitForApproval(): Promise<void> {
  return new Promise((resolve, reject) => {
    approvalResolver = resolve;
    approvalRejecter = reject;
  });
}

export function approve(): void {
  if (approvalResolver) {
    approvalResolver();
    approvalResolver = null;
    approvalRejecter = null;
  }
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export function getIsRunning(): boolean {
  return isRunning;
}

export function getPhase(): string {
  return currentPhase;
}

export async function cancel(): Promise<void> {
  isCancelled = true;

  if (currentPhase === 'researching') {
    cancelResearch();
  } else if (currentPhase === 'awaiting_approval') {
    if (approvalRejecter) {
      approvalRejecter(new Error('Pipeline cancelled'));
      approvalResolver = null;
      approvalRejecter = null;
    }
  } else if (currentPhase === 'classifying') {
    await cancelClassification();
  }

  emitProgress({
    status: 'cancelled',
    currentStep: 'Cancelled',
  });
}

// ---------------------------------------------------------------------------
// Main pipeline: research → approval → classify
// ---------------------------------------------------------------------------

export async function startPipeline(): Promise<void> {
  if (isRunning) {
    throw new Error('Pipeline is already running');
  }

  isRunning = true;
  isCancelled = false;
  currentRunId = randomUUID();
  currentPhase = 'researching';

  try {
    // Phase 1: Research
    emitProgress({
      phase: 'researching',
      status: 'running',
      currentStep: 'Starting supplier research',
    });

    try {
      await researchAllProjectSuppliers((done, total, currentSupplier, step) => {
        if (isCancelled) return;
        emitProgress({
          phase: 'researching',
          status: 'running',
          totalSuppliers: total,
          processedSuppliers: done,
          percentage: total > 0 ? Math.round((done / total) * 100) : 0,
          currentSupplier,
          currentStep: step,
        });
      });
    } catch (err) {
      // Research failed — still proceed to approval so user can review whatever data exists
      console.error('[Pipeline] Research failed:', err);
    }

    if (isCancelled) return;

    // Phase 2: Await approval
    currentPhase = 'awaiting_approval';
    emitProgress({
      phase: 'researching',
      status: 'awaiting_approval',
      percentage: 100,
      currentSupplier: null,
      currentStep: 'Research complete. Review suppliers and approve to continue.',
    });

    await waitForApproval();

    if (isCancelled) return;

    // Phase 3: Classification
    currentPhase = 'classifying';
    emitProgress({
      phase: 'classifying',
      status: 'running',
      percentage: 0,
      currentSupplier: null,
      currentStep: 'Starting classification',
    });

    await startClassification(currentRunId);
  } catch (err) {
    if (!isCancelled) {
      emitProgress({
        status: 'failed',
        currentStep: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    isRunning = false;
    isCancelled = false;
    approvalResolver = null;
    approvalRejecter = null;
  }
}
