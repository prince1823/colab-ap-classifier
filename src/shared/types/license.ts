// ─── License Types ──────────────────────────────────────────────────────────

export type LicenseState = 'unlicensed' | 'valid' | 'expired' | 'revoked' | 'check_failed';

export interface LicenseStatus {
  state: LicenseState;
  licenseKey?: string;        // masked, e.g., "C91-XXXX-****-****"
  expiresAt?: string;
  tier?: string;
  lastChecked?: number;       // unix ms
  message?: string;           // server-provided message
  graceDeadline?: number;     // unix ms — when grace period expires (only for check_failed)
}

export interface LicenseActivationResult {
  success: boolean;
  status: LicenseStatus;
  error?: string;
}

export interface LicenseServerPayload {
  valid: boolean;
  licenseKey: string;
  nonce: string;
  timestamp: number;
  expiresAt: string;
  tier: string;
  message: string;
}

export interface LicenseServerResponse {
  payload: LicenseServerPayload;
  signature: string;          // base64-encoded Ed25519 signature
}
