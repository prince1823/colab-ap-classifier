# License System

Lightweight license key system using Ed25519 signed responses. The Electron app validates license keys against a Cloudflare Worker. Revoked keys are blocked instantly on the next check.

## Architecture

```
Electron App                        Cloudflare Worker
┌──────────────┐    POST /api/verify    ┌──────────────────┐
│ LicenseService│ ──────────────────────> │ License Server    │
│   (main proc) │ <────────────────────── │ (CF Worker + KV)  │
│   Ed25519     │   { payload, signature }│   Ed25519 sign    │
│   verify      │                        │                    │
└──────────────┘                        └──────────────────┘
                                              │
                                         KV Namespace
                                         (license keys)
```

**Anti-spoofing**: Every server response is signed with Ed25519. The app verifies the signature using the embedded public key. A random nonce prevents replay attacks. Timestamp bounds prevent stale responses.

## Setup

### 1. Generate Ed25519 keypair

```bash
cd license-server
node scripts/generate-keys.mjs
```

This outputs:
- **Private key** (PKCS8 DER, base64) — for the CF Worker
- **Public key** (SPKI DER, base64) — for the Electron app

### 2. Deploy the Cloudflare Worker

```bash
cd license-server
npm install

# Create a KV namespace
wrangler kv namespace create LICENSES
# Copy the ID into wrangler.toml under [[kv_namespaces]]

# Set secrets
echo "<private-key-base64>" | wrangler secret put ED25519_PRIVATE_KEY
echo "<your-admin-token>" | wrangler secret put ADMIN_TOKEN

# Deploy
npm run deploy
```

### 3. Configure the Electron app

The license server URL and public key are hardcoded in `src/main/services/license-config.ts` as compile-time constants. They are intentionally NOT read from env vars or `app-config.json` so that a user cannot redirect the app at their own license server. To rotate, edit the constants and ship a new build.

### 4. Dev mode bypass

During development, skip license checks entirely:

```bash
SKIP_LICENSE_CHECK=1 npm run dev
```

This only works when `app.isPackaged === false`.

## Admin API

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>` header.

### Create a license key

```bash
curl -X POST https://<worker-url>/api/admin/keys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"licenseKey": "C91-ABCD-1234-EFGH", "tier": "pro", "expiresAt": "2027-01-01T00:00:00Z"}'
```

### Revoke a license key

```bash
curl -X DELETE https://<worker-url>/api/admin/keys/C91-ABCD-1234-EFGH \
  -H "Authorization: Bearer <admin-token>"
```

Revocation is instant — the app will detect it on its next check (within 30 minutes, or immediately if the user triggers a manual check).

### List all keys

```bash
curl https://<worker-url>/api/admin/keys \
  -H "Authorization: Bearer <admin-token>"
```

## Client Behavior

| Scenario | Behavior |
|----------|----------|
| No license key entered | Block screen with key input |
| Valid key, server confirms | App works normally |
| Key revoked by admin | Block screen on next check (up to 30 min) |
| Network down, had valid check | Grace period: 48 hours of continued access |
| First launch, network down | Block screen (no grace on cold start) |
| Network down, grace expired | Block screen |
| Dev mode (`SKIP_LICENSE_CHECK=1`) | All checks bypassed |

## Verification Protocol

**Request** (app to server):
```json
{ "licenseKey": "C91-...", "nonce": "<uuid>", "machineId": "<sha256>", "appVersion": "2.0.0" }
```

**Response** (server to app):
```json
{
  "payload": {
    "valid": true,
    "licenseKey": "C91-...",
    "nonce": "<echoed>",
    "timestamp": 1710000000000,
    "expiresAt": "2027-01-01T00:00:00Z",
    "tier": "pro",
    "message": ""
  },
  "signature": "<base64 Ed25519 signature>"
}
```

**Client verification**: signature valid + nonce matches + key matches + timestamp within 5 min.

## Files

### Electron app (client)
- `src/shared/types/license.ts` — type definitions
- `src/shared/types/services.ts` — `ILicenseService` interface
- `src/main/services/license-config.ts` — hardcoded license server URL and public key (root of trust)
- `src/main/services/license-service.ts` — core service (Ed25519 verify, grace period, periodic checks)
- `src/main/services/app-config.ts` — encrypted license key storage
- `src/main/ipc/license.ts` — IPC handlers
- `src/renderer/stores/licenseStore.ts` — Zustand store
- `src/renderer/components/LicenseGate.tsx` — top-level gate
- `src/renderer/components/LicenseModal.tsx` — key entry UI

### License server (Cloudflare Worker)
- `license-server/src/index.ts` — worker source
- `license-server/wrangler.toml` — worker config
- `license-server/scripts/generate-keys.mjs` — keypair generator
