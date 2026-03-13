/**
 * Colab91 License Server — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/verify                    — validate a license key (client-facing)
 *   POST /api/admin/keys                — create a new license key
 *   DELETE /api/admin/keys/:key         — revoke a license key
 *   PUT /api/admin/keys/:key/activate   — re-activate a revoked key
 *   GET /api/admin/keys                 — list all license keys
 *   GET /admin                          — admin dashboard UI (token-gated)
 *
 * Secrets (set via `wrangler secret put`):
 *   ED25519_PRIVATE_KEY  — base64-encoded PKCS8 DER private key
 *   ADMIN_TOKEN          — bearer token for admin endpoints
 *
 * KV Namespace:
 *   LICENSES — stores license key → LicenseRecord JSON
 */

interface Env {
  LICENSES: KVNamespace;
  ED25519_PRIVATE_KEY: string;
  ADMIN_TOKEN: string;
}

interface LicenseRecord {
  valid: boolean;
  tier: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  message?: string;
}

interface VerifyRequest {
  licenseKey: string;
  nonce: string;
  machineId?: string;
  appVersion?: string;
}

interface LicensePayload {
  valid: boolean;
  licenseKey: string;
  nonce: string;
  timestamp: number;
  expiresAt: string;
  tier: string;
  message: string;
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

async function importPrivateKey(base64Der: string): Promise<CryptoKey> {
  console.log('[importPrivateKey] start, key length:', base64Der?.length ?? 'undefined');
  const der = base64ToArrayBuffer(base64Der);
  console.log('[importPrivateKey] decoded DER byte length:', der.byteLength);
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    console.log('[importPrivateKey] success, key type:', key.type);
    return key;
  } catch (err) {
    console.error('[importPrivateKey] FAILED:', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function signPayload(payload: string, privateKey: CryptoKey): Promise<string> {
  console.log('[signPayload] signing payload of length:', payload.length);
  try {
    const data = new TextEncoder().encode(payload);
    const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
    console.log('[signPayload] success, signature byte length:', signature.byteLength);
    return arrayBufferToBase64(signature);
  } catch (err) {
    console.error('[signPayload] FAILED:', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Route handlers ─────────────────────────────────────────────────────────

async function handleVerify(request: Request, env: Env): Promise<Response> {
  console.log('[handleVerify] start');
  let body: VerifyRequest;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[handleVerify] failed to parse request body:', err instanceof Error ? err.message : String(err));
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { licenseKey, nonce } = body;
  console.log('[handleVerify] licenseKey:', licenseKey, 'nonce present:', !!nonce);

  if (!licenseKey || !nonce) {
    return jsonResponse({ error: 'licenseKey and nonce are required' }, 400);
  }

  console.log('[handleVerify] fetching KV record');
  const record = await env.LICENSES.get<LicenseRecord>(licenseKey, 'json');
  console.log('[handleVerify] KV record found:', !!record);

  console.log('[handleVerify] importing private key, secret present:', !!env.ED25519_PRIVATE_KEY);
  const privateKey = await importPrivateKey(env.ED25519_PRIVATE_KEY);

  // Build payload — always signed, even for invalid keys
  const payload: LicensePayload = {
    valid: false,
    licenseKey,
    nonce,
    timestamp: Date.now(),
    expiresAt: '',
    tier: '',
    message: '',
  };

  if (!record) {
    payload.message = 'License key not found.';
  } else if (!record.valid || record.revokedAt) {
    payload.message = record.message || 'License has been revoked.';
  } else if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    payload.message = 'License has expired.';
  } else {
    payload.valid = true;
    payload.expiresAt = record.expiresAt;
    payload.tier = record.tier;
    payload.message = record.message || '';
  }

  const payloadJson = JSON.stringify(payload);
  const signature = await signPayload(payloadJson, privateKey);

  const status = payload.valid ? 200 : (!record ? 401 : 403);
  console.log('[handleVerify] responding with status:', status, 'valid:', payload.valid);
  return jsonResponse({ payload, signature }, status);
}

async function handleAdminCreateKey(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    licenseKey: string;
    tier?: string;
    expiresAt?: string;
    message?: string;
  };

  if (!body.licenseKey) {
    return jsonResponse({ error: 'licenseKey is required' }, 400);
  }

  const existing = await env.LICENSES.get(body.licenseKey);
  if (existing) {
    return jsonResponse({ error: 'Key already exists' }, 409);
  }

  const record: LicenseRecord = {
    valid: true,
    tier: body.tier || 'pro',
    expiresAt: body.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    message: body.message,
  };

  await env.LICENSES.put(body.licenseKey, JSON.stringify(record));
  return jsonResponse({ success: true, licenseKey: body.licenseKey, record });
}

async function handleAdminRevokeKey(licenseKey: string, env: Env): Promise<Response> {
  const raw = await env.LICENSES.get<LicenseRecord>(licenseKey, 'json');
  if (!raw) {
    return jsonResponse({ error: 'Key not found' }, 404);
  }

  raw.valid = false;
  raw.revokedAt = new Date().toISOString();
  raw.message = 'License has been revoked by admin.';

  await env.LICENSES.put(licenseKey, JSON.stringify(raw));
  return jsonResponse({ success: true, licenseKey, record: raw });
}

async function handleAdminActivateKey(licenseKey: string, env: Env): Promise<Response> {
  const raw = await env.LICENSES.get<LicenseRecord>(licenseKey, 'json');
  if (!raw) {
    return jsonResponse({ error: 'Key not found' }, 404);
  }

  raw.valid = true;
  delete raw.revokedAt;
  raw.message = '';

  await env.LICENSES.put(licenseKey, JSON.stringify(raw));
  return jsonResponse({ success: true, licenseKey, record: raw });
}

async function handleAdminDeleteKey(licenseKey: string, env: Env): Promise<Response> {
  const raw = await env.LICENSES.get(licenseKey);
  if (!raw) {
    return jsonResponse({ error: 'Key not found' }, 404);
  }

  await env.LICENSES.delete(licenseKey);
  return jsonResponse({ success: true, licenseKey });
}

async function handleAdminListKeys(env: Env): Promise<Response> {
  const list = await env.LICENSES.list();
  const keys: Array<{ key: string; record: LicenseRecord | null }> = [];

  for (const k of list.keys) {
    const record = await env.LICENSES.get<LicenseRecord>(k.name, 'json');
    keys.push({ key: k.name, record });
  }

  return jsonResponse({ keys });
}

// ─── Middleware ──────────────────────────────────────────────────────────────

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// ─── Admin UI HTML ──────────────────────────────────────────────────────────

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Colab91 License Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #1f2937; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 24px; }

  /* Login */
  #login { max-width: 400px; margin: 120px auto; background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  #login h1 { text-align: center; margin-bottom: 16px; }
  #login input { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
  #login button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; font-size: 14px; }
  #login button:hover { background: #1d4ed8; }
  #login .error { color: #dc2626; font-size: 13px; margin-bottom: 8px; display: none; }

  /* Dashboard */
  #dashboard { display: none; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .topbar-right { display: flex; gap: 8px; }

  /* Table */
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  th { text-align: left; padding: 12px 16px; background: #f9fafb; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; border-bottom: 1px solid #e5e7eb; }
  td { padding: 12px 16px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 13px; }

  /* Badges */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-gray { background: #f3f4f6; color: #4b5563; }

  /* Buttons */
  .btn { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; cursor: pointer; background: #fff; transition: all .15s; }
  .btn:hover { background: #f9fafb; }
  .btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-danger { color: #dc2626; border-color: #fca5a5; }
  .btn-danger:hover { background: #fef2f2; }
  .btn-success { color: #059669; border-color: #6ee7b7; }
  .btn-success:hover { background: #ecfdf5; }
  .btn-sm { padding: 4px 8px; font-size: 12px; }
  .actions { display: flex; gap: 6px; }

  /* Modal */
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 50; justify-content: center; align-items: center; }
  .modal-bg.active { display: flex; }
  .modal { background: #fff; padding: 24px; border-radius: 12px; width: 100%; max-width: 440px; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
  .modal h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
  .modal label { display: block; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 4px; }
  .modal input, .modal select { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; margin-bottom: 12px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

  .empty { text-align: center; padding: 48px; color: #9ca3af; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #1f2937; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 14px; z-index: 100; display: none; }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login">
  <h1>License Admin</h1>
  <p class="error" id="loginError">Invalid admin token</p>
  <input type="password" id="tokenInput" placeholder="Admin token" autofocus />
  <button onclick="doLogin()">Sign In</button>
</div>

<!-- Dashboard -->
<div id="dashboard" class="container">
  <div class="topbar">
    <div>
      <h1>License Keys</h1>
      <p class="subtitle">Manage license keys for Colab91 AP Classifier</p>
    </div>
    <div class="topbar-right">
      <button class="btn btn-primary" onclick="showAddModal()">+ Add Key</button>
      <button class="btn" onclick="loadKeys()">Refresh</button>
      <button class="btn" onclick="logout()">Logout</button>
    </div>
  </div>
  <div id="tableWrap"></div>
</div>

<!-- Add Key Modal -->
<div class="modal-bg" id="addModal">
  <div class="modal">
    <h2>Create License Key</h2>
    <label>License Key</label>
    <input type="text" id="newKey" placeholder="C91-XXXX-XXXX-XXXX" />
    <label>Tier</label>
    <select id="newTier">
      <option value="pro">Pro</option>
      <option value="enterprise">Enterprise</option>
      <option value="trial">Trial</option>
    </select>
    <label>Expires In</label>
    <select id="newExpiry">
      <option value="365">1 Year</option>
      <option value="180">6 Months</option>
      <option value="90">3 Months</option>
      <option value="30">30 Days</option>
      <option value="3650">10 Years</option>
    </select>
    <div class="modal-actions">
      <button class="btn" onclick="hideAddModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createKey()">Create</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
let TOKEN = '';
const BASE = '';  // same origin

function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(BASE + path, opts).then(r => r.json());
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}

async function doLogin() {
  TOKEN = document.getElementById('tokenInput').value.trim();
  if (!TOKEN) return;
  try {
    const res = await api('GET', '/api/admin/keys');
    if (res.error) throw new Error(res.error);
    document.getElementById('login').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    renderKeys(res.keys);
  } catch (e) {
    document.getElementById('loginError').style.display = 'block';
    TOKEN = '';
  }
}

function logout() {
  TOKEN = '';
  document.getElementById('login').style.display = 'block';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('tokenInput').value = '';
  document.getElementById('loginError').style.display = 'none';
}

document.getElementById('tokenInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function loadKeys() {
  const res = await api('GET', '/api/admin/keys');
  renderKeys(res.keys || []);
}

function renderKeys(keys) {
  if (!keys.length) {
    document.getElementById('tableWrap').innerHTML = '<div class="empty">No license keys yet. Click "+ Add Key" to create one.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Key</th><th>Status</th><th>Tier</th><th>Created</th><th>Expires</th><th>Actions</th></tr></thead><tbody>';
  for (const k of keys) {
    const r = k.record;
    const valid = r && r.valid && !r.revokedAt;
    const statusBadge = valid
      ? '<span class="badge badge-green">Active</span>'
      : '<span class="badge badge-red">Revoked</span>';
    const created = r ? new Date(r.createdAt).toLocaleDateString() : '-';
    const expires = r && r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '-';
    const keyEsc = k.key.replace(/'/g, "\\\\'");

    let actions = '';
    if (valid) {
      actions = '<button class="btn btn-danger btn-sm" onclick="revokeKey(\\'' + keyEsc + '\\')">Revoke</button>';
    } else {
      actions = '<button class="btn btn-success btn-sm" onclick="activateKey(\\'' + keyEsc + '\\')">Activate</button>';
    }
    actions += ' <button class="btn btn-danger btn-sm" onclick="deleteKey(\\'' + keyEsc + '\\')">Delete</button>';

    html += '<tr><td class="mono">' + k.key + '</td><td>' + statusBadge + '</td><td>' + (r?.tier || '-') + '</td><td>' + created + '</td><td>' + expires + '</td><td class="actions">' + actions + '</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('tableWrap').innerHTML = html;
}

async function revokeKey(key) {
  if (!confirm('Revoke key: ' + key + '?')) return;
  await api('DELETE', '/api/admin/keys/' + encodeURIComponent(key));
  toast('Key revoked');
  loadKeys();
}

async function activateKey(key) {
  if (!confirm('Re-activate key: ' + key + '?')) return;
  await api('PUT', '/api/admin/keys/' + encodeURIComponent(key) + '/activate');
  toast('Key activated');
  loadKeys();
}

async function deleteKey(key) {
  if (!confirm('Permanently delete key: ' + key + '? This cannot be undone.')) return;
  await api('PUT', '/api/admin/keys/' + encodeURIComponent(key) + '/delete');
  toast('Key deleted');
  loadKeys();
}

function showAddModal() {
  document.getElementById('addModal').classList.add('active');
  document.getElementById('newKey').value = generateKey();
  document.getElementById('newKey').focus();
}

function hideAddModal() {
  document.getElementById('addModal').classList.remove('active');
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return 'C91-' + seg() + '-' + seg() + '-' + seg();
}

async function createKey() {
  const licenseKey = document.getElementById('newKey').value.trim();
  const tier = document.getElementById('newTier').value;
  const days = parseInt(document.getElementById('newExpiry').value);
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

  if (!licenseKey) return;

  const res = await api('POST', '/api/admin/keys', { licenseKey, tier, expiresAt });
  if (res.error) {
    alert(res.error);
    return;
  }
  hideAddModal();
  toast('Key created: ' + licenseKey);
  loadKeys();
}
</script>
</body>
</html>`;

// ─── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    console.log('[fetch]', request.method, pathname);

    try {
      // CORS preflight
      if (request.method === 'OPTIONS') {
        return jsonResponse(null, 204);
      }

      // Public endpoint
      if (request.method === 'POST' && pathname === '/api/verify') {
        return handleVerify(request, env);
      }

      // Admin UI
      if (request.method === 'GET' && pathname === '/admin') {
        return new Response(ADMIN_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // Admin endpoints
      if (pathname.startsWith('/api/admin/')) {
        const authErr = requireAdmin(request, env);
        if (authErr) return authErr;

        if (request.method === 'POST' && pathname === '/api/admin/keys') {
          return handleAdminCreateKey(request, env);
        }
        if (request.method === 'DELETE' && pathname.startsWith('/api/admin/keys/')) {
          const key = decodeURIComponent(pathname.slice('/api/admin/keys/'.length));
          return handleAdminRevokeKey(key, env);
        }
        if (request.method === 'PUT' && pathname.endsWith('/activate')) {
          const key = decodeURIComponent(pathname.slice('/api/admin/keys/'.length, -'/activate'.length));
          return handleAdminActivateKey(key, env);
        }
        if (request.method === 'PUT' && pathname.endsWith('/delete')) {
          const key = decodeURIComponent(pathname.slice('/api/admin/keys/'.length, -'/delete'.length));
          return handleAdminDeleteKey(key, env);
        }
        if (request.method === 'GET' && pathname === '/api/admin/keys') {
          return handleAdminListKeys(env);
        }
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('[fetch] unhandled error:', message, stack);
      return jsonResponse({ error: 'Internal server error', detail: message }, 500);
    }
  },
};
