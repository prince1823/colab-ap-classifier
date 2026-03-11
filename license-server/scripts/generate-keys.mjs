#!/usr/bin/env node
/**
 * Generate an Ed25519 keypair for the license system.
 *
 * Output:
 *   - Private key (base64 PKCS8 DER) → set as CF Worker secret ED25519_PRIVATE_KEY
 *   - Public key (base64 SPKI DER)   → set as LICENSE_PUBLIC_KEY in the Electron app's .env
 */

import { generateKeyPairSync } from 'crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
const pubDer = publicKey.export({ type: 'spki', format: 'der' });

console.log('=== Ed25519 Keypair for License System ===\n');
console.log('PRIVATE KEY (base64 PKCS8 DER) — set as CF Worker secret:');
console.log(`ED25519_PRIVATE_KEY=${privDer.toString('base64')}\n`);
console.log('PUBLIC KEY (base64 SPKI DER) — set in Electron app .env:');
console.log(`LICENSE_PUBLIC_KEY=${pubDer.toString('base64')}\n`);
console.log('To set the CF Worker secret:');
console.log('  cd license-server && echo "<private-key-base64>" | wrangler secret put ED25519_PRIVATE_KEY\n');
console.log('To set in the Electron app .env:');
console.log('  Add LICENSE_PUBLIC_KEY=<public-key-base64> to your .env file');
console.log('  Add LICENSE_SERVER_URL=https://your-worker.your-subdomain.workers.dev to your .env file');
