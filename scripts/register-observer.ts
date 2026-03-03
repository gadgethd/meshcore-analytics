#!/usr/bin/env tsx
/**
 * MeshCore Analytics — Register an Observer (Repeater Owner)
 *
 * Usage:
 *   cd scripts && npm run register-observer -- \
 *     --pubkey <hex-public-key> \
 *     --name "Alice's Repeater" \
 *     --location "Middlesbrough, TS1"
 *
 * Requires DATABASE_URL env var or a .env file in the project root.
 *
 * This script inserts the observer's public key into the `observers` table,
 * authorising them to place planned nodes and authenticate via the API.
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env if DATABASE_URL not set ────────────────────────────────────────
if (!process.env['DATABASE_URL']) {
  const envPath = join(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) process.env[key] = val;
    }
  }
}

// ── Parse CLI args ────────────────────────────────────────────────────────────
function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const pubkey   = getArg('--pubkey');
const name     = getArg('--name');
const location = getArg('--location') ?? '';
const deactivate = process.argv.includes('--deactivate');
const list       = process.argv.includes('--list');

// ── DB connection ─────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function listObservers(): Promise<void> {
  const { rows } = await pool.query<{
    public_key: string; name: string; location: string;
    registered_at: Date; is_active: boolean;
  }>('SELECT public_key, name, location, registered_at, is_active FROM observers ORDER BY registered_at DESC');

  if (rows.length === 0) {
    console.log('\n  No observers registered yet.\n');
    return;
  }

  const LINE = '─'.repeat(72);
  console.log(`\n${LINE}`);
  console.log('  Registered Observers');
  console.log(`${LINE}`);
  for (const row of rows) {
    const status = row.is_active ? '✓ ACTIVE' : '✗ INACTIVE';
    console.log(`\n  Name    : ${row.name}`);
    console.log(`  Pubkey  : ${row.public_key}`);
    console.log(`  Location: ${row.location || '—'}`);
    console.log(`  Since   : ${row.registered_at.toISOString().slice(0, 10)}`);
    console.log(`  Status  : ${status}`);
  }
  console.log(`\n${LINE}\n`);
}

async function registerObserver(pubkey: string, name: string, location: string): Promise<void> {
  // Validate hex public key (Ed25519 = 32 bytes = 64 hex chars)
  if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    console.error('\n  Error: public key must be 64 hex characters (32 bytes / Ed25519).\n');
    process.exit(1);
  }

  await pool.query(
    `INSERT INTO observers (public_key, name, location, registered_at, is_active)
     VALUES ($1, $2, $3, NOW(), TRUE)
     ON CONFLICT (public_key) DO UPDATE SET
       name       = EXCLUDED.name,
       location   = EXCLUDED.location,
       is_active  = TRUE`,
    [pubkey.toLowerCase(), name, location]
  );

  const LINE = '─'.repeat(62);
  console.log(`\n${LINE}`);
  console.log('  Observer Registered Successfully');
  console.log(`${LINE}\n`);
  console.log(`  Name    : ${name}`);
  console.log(`  Location: ${location || '—'}`);
  console.log(`  Pubkey  : ${pubkey.toLowerCase()}`);
  console.log('');
  console.log('  This observer can now:');
  console.log('  • Authenticate to the API using their Ed25519 private key');
  console.log('  • Place planned nodes on the coverage map');
  console.log(`\n${LINE}\n`);
}

async function deactivateObserver(pubkey: string): Promise<void> {
  const { rowCount } = await pool.query(
    'UPDATE observers SET is_active = FALSE WHERE public_key = $1',
    [pubkey.toLowerCase()]
  );
  if (rowCount === 0) {
    console.error(`\n  Error: no observer found with pubkey ${pubkey}\n`);
    process.exit(1);
  }
  console.log(`\n  Observer ${pubkey.slice(0, 16)}… deactivated.\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    if (list) {
      await listObservers();
    } else if (deactivate) {
      if (!pubkey) { console.error('  Error: --pubkey required for --deactivate'); process.exit(1); }
      await deactivateObserver(pubkey);
    } else {
      if (!pubkey) { console.error('  Error: --pubkey is required'); process.exit(1); }
      if (!name)   { console.error('  Error: --name is required');   process.exit(1); }
      await registerObserver(pubkey, name, location);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
