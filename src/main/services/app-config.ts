import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { IAppConfigService } from '../../shared/types/services';
import type { LicenseStatus } from '../../shared/types/license';

const DEFAULT_LICENSE_SERVER_URL = 'https://colab91-license-server.tanuj-44c.workers.dev';
const DEFAULT_LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAExmIdot5+EJbAilti/UwIuBnNOKhognNVVedcxqfIj4=';

interface LicenseDataShape {
  lastResult?: Record<string, unknown>;
  lastChecked?: number;
}

interface ConfigFileShape {
  provider?: string;
  model?: string;
  // base64-encoded encrypted (or plaintext if encryption unavailable) key per provider
  keys?: Record<string, string>;
  supplierUniversePath?: string;
  // License — key encrypted same as API keys; data is plaintext (no secrets)
  licenseKey?: string;
  licenseData?: LicenseDataShape;
  licenseServerUrl?: string;
  licensePublicKey?: string;
}

function isConfigFileShape(v: unknown): v is ConfigFileShape {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (obj.provider !== undefined && typeof obj.provider !== 'string') return false;
  if (obj.model !== undefined && typeof obj.model !== 'string') return false;
  if (obj.keys !== undefined) {
    if (typeof obj.keys !== 'object' || Array.isArray(obj.keys)) return false;
    for (const val of Object.values(obj.keys as object)) {
      if (typeof val !== 'string') return false;
    }
  }
  if (obj.supplierUniversePath !== undefined && typeof obj.supplierUniversePath !== 'string') return false;
  if (obj.licenseKey !== undefined && typeof obj.licenseKey !== 'string') return false;
  if (obj.licenseServerUrl !== undefined && typeof obj.licenseServerUrl !== 'string') return false;
  if (obj.licensePublicKey !== undefined && typeof obj.licensePublicKey !== 'string') return false;
  return true;
}

export class AppConfigService implements IAppConfigService {
  private readonly configPath: string;
  private config: ConfigFileShape = {};

  constructor() {
    const userDataDir = app.getPath('userData');
    this.configPath = path.join(userDataDir, 'app-config.json');

    // Migrate from old llm-config.json if app-config.json doesn't exist yet
    const oldPath = path.join(userDataDir, 'llm-config.json');
    if (!fs.existsSync(this.configPath) && fs.existsSync(oldPath)) {
      try {
        fs.renameSync(oldPath, this.configPath);
      } catch {
        // Fall through — load will handle missing file
      }
    }

    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      this.config = isConfigFileShape(parsed) ? parsed : {};
    } catch {
      this.config = {};
    }
  }

  private save(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  // ─── LLM Settings ──────────────────────────────────────────────────────────

  getApiKey(provider: string): string | null {
    const stored = this.config.keys?.[provider];
    if (stored) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(stored, 'base64'));
        }
        return stored;
      } catch {
        // decryption failed — fall through to env var
      }
    }
    // Fallback to env var
    switch (provider) {
      case 'anthropic': return process.env.ANTHROPIC_API_KEY || null;
      case 'openai':    return process.env.OPENAI_API_KEY || null;
      case 'openrouter':
        return process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || null;
      default:          return null;
    }
  }

  async setApiKey(provider: string, key: string): Promise<void> {
    if (!this.config.keys) this.config.keys = {};
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      this.config.keys[provider] = encrypted.toString('base64');
    } else {
      this.config.keys[provider] = key;
    }
    this.save();
  }

  getProvider(): string {
    return this.config.provider || process.env.CLASSIFIER_LLM_PROVIDER || 'openrouter';
  }

  async setProvider(provider: string): Promise<void> {
    this.config.provider = provider;
    this.save();
  }

  getModel(): string {
    return this.config.model || process.env.CLASSIFIER_MODEL || 'claude-3-5-haiku-latest';
  }

  async setModel(model: string): Promise<void> {
    this.config.model = model;
    this.save();
  }

  // ─── Exa Settings ───────────────────────────────────────────────────────────

  getExaApiKey(): string | null {
    const stored = this.config.keys?.['exa'];
    if (stored) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(stored, 'base64'));
        }
        return stored;
      } catch {
        // decryption failed — fall through to env var
      }
    }
    return process.env.EXA_API_KEY || null;
  }

  async setExaApiKey(key: string): Promise<void> {
    if (!this.config.keys) this.config.keys = {};
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      this.config.keys['exa'] = encrypted.toString('base64');
    } else {
      this.config.keys['exa'] = key;
    }
    this.save();
  }

  // ─── Supplier Universe Path ─────────────────────────────────────────────────

  getSupplierUniversePath(): string | null {
    return this.config.supplierUniversePath || null;
  }

  async setSupplierUniversePath(p: string): Promise<void> {
    this.config.supplierUniversePath = p;
    this.save();
  }

  async clearSupplierUniversePath(): Promise<void> {
    delete this.config.supplierUniversePath;
    this.save();
  }

  // ─── License ──────────────────────────────────────────────────────────────

  getLicenseKey(): string | null {
    const stored = this.config.licenseKey;
    if (stored) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(stored, 'base64'));
        }
        return stored;
      } catch {
        // decryption failed
      }
    }
    return process.env.LICENSE_KEY || null;
  }

  async setLicenseKey(key: string): Promise<void> {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      this.config.licenseKey = encrypted.toString('base64');
    } else {
      this.config.licenseKey = key;
    }
    this.save();
  }

  async clearLicenseKey(): Promise<void> {
    delete this.config.licenseKey;
    delete this.config.licenseData;
    this.save();
  }

  getLicenseData(): { lastResult?: LicenseStatus; lastChecked?: number } | null {
    const d = this.config.licenseData;
    if (!d) return null;
    return { lastResult: d.lastResult as LicenseStatus | undefined, lastChecked: d.lastChecked };
  }

  async setLicenseData(data: { lastResult?: LicenseStatus; lastChecked?: number }): Promise<void> {
    this.config.licenseData = data as LicenseDataShape;
    this.save();
  }

  getLicenseServerUrl(): string | null {
    return this.config.licenseServerUrl || process.env.LICENSE_SERVER_URL || DEFAULT_LICENSE_SERVER_URL;
  }

  async setLicenseServerUrl(url: string): Promise<void> {
    this.config.licenseServerUrl = url;
    this.save();
  }

  getLicensePublicKey(): string | null {
    return this.config.licensePublicKey || process.env.LICENSE_PUBLIC_KEY || DEFAULT_LICENSE_PUBLIC_KEY;
  }

  async setLicensePublicKey(key: string): Promise<void> {
    this.config.licensePublicKey = key;
    this.save();
  }
}
