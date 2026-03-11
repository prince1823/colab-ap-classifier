import * as crypto from 'crypto';
import * as os from 'os';
import { app } from 'electron';
import type { IAppConfigService, ILicenseService, EventBus } from '../../shared/types/services';
import type {
  LicenseStatus,
  LicenseActivationResult,
  LicenseServerResponse,
  LicenseServerPayload,
} from '../../shared/types/license';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const GRACE_PERIOD_MS   = 48 * 60 * 60 * 1000; // 48 hours
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;  // 5 minutes

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 8) + '-****-****';
}

function getMachineId(): string {
  try {
    const raw = os.hostname() + os.userInfo().username;
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    return 'unknown';
  }
}

export class LicenseService implements ILicenseService {
  private status: LicenseStatus = { state: 'unlicensed' };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly appConfig: IAppConfigService;
  private readonly eventBus: EventBus;

  constructor(appConfig: IAppConfigService, eventBus: EventBus) {
    this.appConfig = appConfig;
    this.eventBus = eventBus;
    this.loadCachedStatus();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async activate(licenseKey: string): Promise<LicenseActivationResult> {
    if (this.isDevBypass()) {
      return { success: true, status: this.status };
    }

    const trimmed = licenseKey.trim();
    if (!trimmed) {
      return { success: false, status: this.status, error: 'License key is required' };
    }

    const result = await this.verifyWithServer(trimmed);
    if (result.state === 'valid') {
      await this.appConfig.setLicenseKey(trimmed);
      await this.persistStatus(result);
      return { success: true, status: result };
    }

    return {
      success: false,
      status: result,
      error: result.message || 'License key is not valid',
    };
  }

  getStatus(): LicenseStatus {
    if (this.isDevBypass()) {
      return { state: 'valid', tier: 'dev', message: 'Development mode' };
    }
    return { ...this.status };
  }

  async checkNow(): Promise<LicenseStatus> {
    if (this.isDevBypass()) {
      return { state: 'valid', tier: 'dev', message: 'Development mode' };
    }

    const key = this.appConfig.getLicenseKey();
    if (!key) {
      this.setStatus({ state: 'unlicensed' });
      return this.status;
    }

    const result = await this.verifyWithServer(key);
    await this.persistStatus(result);
    return result;
  }

  startPeriodicChecks(): void {
    if (this.isDevBypass() || this.timer) return;

    // Initial check on startup (delayed slightly to not block app launch)
    setTimeout(() => this.checkNow().catch(() => {}), 3000);

    this.timer = setInterval(() => {
      this.checkNow().catch(() => {});
    }, CHECK_INTERVAL_MS);
  }

  stopPeriodicChecks(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private isDevBypass(): boolean {
    return !app.isPackaged && process.env.SKIP_LICENSE_CHECK === '1';
  }

  private loadCachedStatus(): void {
    if (this.isDevBypass()) {
      this.status = { state: 'valid', tier: 'dev', message: 'Development mode' };
      return;
    }

    const key = this.appConfig.getLicenseKey();
    if (!key) {
      this.status = { state: 'unlicensed' };
      return;
    }

    const cached = this.appConfig.getLicenseData();
    if (cached?.lastResult) {
      this.status = cached.lastResult;
      // Check if grace period has expired for check_failed state
      if (this.status.state === 'check_failed' && this.status.graceDeadline) {
        if (Date.now() > this.status.graceDeadline) {
          this.status = {
            ...this.status,
            state: 'expired',
            message: 'License verification failed and grace period expired. Please check your internet connection.',
          };
        }
      }
    } else {
      // Key exists but no cached result — treat as needing check
      this.status = { state: 'valid', licenseKey: maskKey(key), message: 'Pending verification' };
    }
  }

  private async verifyWithServer(licenseKey: string): Promise<LicenseStatus> {
    const serverUrl = this.appConfig.getLicenseServerUrl();
    const publicKeyB64 = this.appConfig.getLicensePublicKey();

    if (!serverUrl || !publicKeyB64) {
      // No server configured — can't verify. Use grace logic.
      return this.handleNetworkFailure(licenseKey, 'License server not configured');
    }

    const nonce = crypto.randomUUID();

    try {
      const response = await fetch(`${serverUrl}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey,
          nonce,
          machineId: getMachineId(),
          appVersion: app.getVersion(),
        }),
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        // Non-2xx but reachable server — treat specific codes differently
        if (response.status === 401 || response.status === 403) {
          return {
            state: 'revoked',
            licenseKey: maskKey(licenseKey),
            lastChecked: Date.now(),
            message: 'License key is invalid or has been revoked.',
          };
        }
        return this.handleNetworkFailure(licenseKey, `Server returned ${response.status}`);
      }

      const body: LicenseServerResponse = await response.json();
      return this.verifySignedResponse(body, licenseKey, nonce, publicKeyB64);

    } catch (err) {
      // Network error, timeout, etc.
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return this.handleNetworkFailure(licenseKey, msg);
    }
  }

  private verifySignedResponse(
    body: LicenseServerResponse,
    licenseKey: string,
    expectedNonce: string,
    publicKeyB64: string,
  ): LicenseStatus {
    const { payload, signature } = body;

    // 1. Verify Ed25519 signature
    try {
      const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
      const sigBytes = Buffer.from(signature, 'base64');
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(publicKeyB64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      const valid = crypto.verify(null, payloadBytes, pubKey, sigBytes);
      if (!valid) {
        return {
          state: 'revoked',
          licenseKey: maskKey(licenseKey),
          lastChecked: Date.now(),
          message: 'Response signature verification failed.',
        };
      }
    } catch {
      return {
        state: 'revoked',
        licenseKey: maskKey(licenseKey),
        lastChecked: Date.now(),
        message: 'Response signature verification failed.',
      };
    }

    // 2. Verify nonce
    if (payload.nonce !== expectedNonce) {
      return {
        state: 'revoked',
        licenseKey: maskKey(licenseKey),
        lastChecked: Date.now(),
        message: 'Response nonce mismatch — possible replay attack.',
      };
    }

    // 3. Verify license key matches
    if (payload.licenseKey !== licenseKey) {
      return {
        state: 'revoked',
        licenseKey: maskKey(licenseKey),
        lastChecked: Date.now(),
        message: 'Response license key mismatch.',
      };
    }

    // 4. Verify timestamp
    if (Math.abs(Date.now() - payload.timestamp) > TIMESTAMP_TOLERANCE_MS) {
      return {
        state: 'revoked',
        licenseKey: maskKey(licenseKey),
        lastChecked: Date.now(),
        message: 'Response timestamp out of range.',
      };
    }

    // 5. Build status from verified payload
    if (!payload.valid) {
      return {
        state: 'revoked',
        licenseKey: maskKey(licenseKey),
        lastChecked: Date.now(),
        message: payload.message || 'License has been revoked.',
      };
    }

    return {
      state: 'valid',
      licenseKey: maskKey(licenseKey),
      expiresAt: payload.expiresAt,
      tier: payload.tier,
      lastChecked: Date.now(),
      message: payload.message || undefined,
    };
  }

  private handleNetworkFailure(licenseKey: string, reason: string): LicenseStatus {
    // If we had a previous valid check, enter grace period
    const cached = this.appConfig.getLicenseData();
    if (cached?.lastResult?.state === 'valid' && cached.lastChecked) {
      const graceDeadline = cached.lastChecked + GRACE_PERIOD_MS;
      if (Date.now() <= graceDeadline) {
        return {
          ...cached.lastResult,
          state: 'check_failed',
          graceDeadline,
          message: `Verification failed (${reason}). Grace period active.`,
        };
      }
      // Grace expired
      return {
        state: 'expired',
        licenseKey: maskKey(licenseKey),
        lastChecked: cached.lastChecked,
        message: `Verification failed and grace period expired. ${reason}`,
      };
    }

    // No previous valid check — can't grant grace
    return {
      state: 'check_failed',
      licenseKey: maskKey(licenseKey),
      lastChecked: Date.now(),
      graceDeadline: Date.now() + GRACE_PERIOD_MS,
      message: `Could not verify license: ${reason}`,
    };
  }

  private setStatus(newStatus: LicenseStatus): void {
    this.status = newStatus;
    this.eventBus.emit('license:statusChanged', newStatus);
  }

  private async persistStatus(status: LicenseStatus): Promise<void> {
    this.setStatus(status);
    await this.appConfig.setLicenseData({
      lastResult: status,
      lastChecked: status.lastChecked ?? Date.now(),
    });
  }
}
