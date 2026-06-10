// src/database/migrations.js — Minimal versioned migration runner.
//
// Migrations are .sql files in src/database/migrations/, named NNN_name.sql
// (e.g. 001_initial.sql). They are applied in filename order, each inside a
// transaction, and recorded in schema_migrations so they are never reapplied.
//
// CLI: `npm run migrate` (node src/database/migrations.js)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase, withTransaction } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

/** Return migration files in apply order: [{ version, filePath }] */
function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), filePath: path.join(dir, f) }));
}

/**
 * Apply all pending migrations to the given db.
 * Idempotent: already-applied versions are skipped.
 * Returns { applied: string[], skipped: string[] }.
 */
export function runMigrations(db, dir = MIGRATIONS_DIR) {
  ensureMigrationsTable(db);
  const appliedSet = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const applied = [];
  const skipped = [];

  for (const { version, filePath } of listMigrationFiles(dir)) {
    if (appliedSet.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = fs.readFileSync(filePath, 'utf8');
    withTransaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    });
    applied.push(version);
  }
  return { applied, skipped };
}

// --- CLI entry point: `node src/database/migrations.js` ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDatabase();
  try {
    const { applied, skipped } = runMigrations(db);
    console.log(`Migrations applied: ${applied.length ? applied.join(', ') : '(none)'}`);
    console.log(`Already applied:    ${skipped.length ? skipped.join(', ') : '(none)'}`);
  } finally {
    closeDatabase(db);
  }
}
