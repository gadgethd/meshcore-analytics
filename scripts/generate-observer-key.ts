#!/usr/bin/env tsx
/**
 * MeshCore Analytics — Generate Ed25519 Observer Keypair
 *
 * Usage:
 *   cd scripts && npm run generate-key
 *   # or directly:
 *   npx tsx generate-observer-key.ts [--name "My Repeater"]
 *
 * This generates an Ed25519 keypair for a repeater owner (observer).
 * The PUBLIC key is registered in the system and used to verify JWT signatures.
 * The PRIVATE key is kept secret by the repeater owner and used to sign JWTs.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ──────────────────────────────────────────────────────────────
const nameIdx = process.argv.indexOf('--name');
const observerName = nameIdx !== -1 ? (process.argv[nameIdx + 1] ?? 'Observer') : 'Observer';

// ── Generate keypair ─────────────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

function keyToHex(key: KeyObject, type: 'public' | 'private'): string {
  if (type === 'public') {
    // DER-encoded SubjectPublicKeyInfo, last 32 bytes are the raw key
    const der = key.export({ type: 'spki', format: 'der' });
    return der.slice(-32).toString('hex');
  } else {
    // DER-encoded PrivateKeyInfo, last 32 bytes are the raw seed
    const der = key.export({ type: 'pkcs8', format: 'der' });
    return der.slice(-32).toString('hex');
  }
}

const publicKeyHex  = keyToHex(publicKey,  'public');
const privateKeyHex = keyToHex(privateKey, 'private');

// Also export as PEM for potential JWT library use
const publicKeyPem  = publicKey.export({ type: 'spki',  format: 'pem' }) as string;
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

// ── Save to file ─────────────────────────────────────────────────────────────
const keysDir  = join(__dirname, 'keys');
const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const filename = join(keysDir, `observer-${ts}.json`);

mkdirSync(keysDir, { recursive: true });

const keyFile = {
  generated:     new Date().toISOString(),
  name:          observerName,
  publicKeyHex,
  privateKeyHex,
  publicKeyPem,
  privateKeyPem,
};

writeFileSync(filename, JSON.stringify(keyFile, null, 2), 'utf8');

// ── Print instructions ────────────────────────────────────────────────────────
const LINE = '─'.repeat(62);

console.log(`\n${LINE}`);
console.log('  MeshCore Analytics — Ed25519 Observer Keypair Generated');
console.log(`${LINE}\n`);

console.log(`  Observer name : ${observerName}`);
console.log(`  Keys saved to : ${filename}\n`);

console.log('  PUBLIC KEY (register this in the system):');
console.log(`  ${publicKeyHex}\n`);

console.log('  PRIVATE KEY (keep this SECRET — never share):');
console.log(`  ${privateKeyHex}\n`);

console.log(`${LINE}`);
console.log('  NEXT STEPS:');
console.log(`${LINE}`);
console.log('');
console.log('  1. Register your public key with the admin:');
console.log('     cd scripts && npx tsx register-observer.ts \\');
console.log(`       --pubkey ${publicKeyHex} \\`);
console.log(`       --name "${observerName}" \\`);
console.log('       --location "Your location"');
console.log('');
console.log('  2. For Mosquitto auth (if configured):');
console.log('     Add the public key to mosquitto/passwd or ACL file.');
console.log('     Topic access: meshcore/<your-node-id>/#');
console.log('');
console.log('  3. To authenticate API requests, sign a JWT with your');
console.log('     private key using the Ed25519 algorithm (alg: EdDSA).');
console.log('     Include the public key hex as the "sub" claim.');
console.log('');
console.log(`${LINE}\n`);
