// src/database/db.js — SQLite open/close utilities.
//
// Uses Node's built-in node:sqlite (DatabaseSync, Node >= 22.5). Zero native
// dependencies. This module is the ONLY place that touches the SQLite driver;
// if we later switch to better-sqlite3, only this file changes.
//
// Every connection gets WAL mode (file-backed DBs) and foreign key enforcement.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';

/**
 * Open a SQLite database at the given path (or the configured default).
 * Ensures the parent directory exists. Returns a DatabaseSync instance.
 */
export function openDatabase(dbPath = loadConfig().databasePath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // WAL needs file locking/mmap; unavailable on some filesystems
    // (e.g. network mounts). Fall back to the default journal mode.
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Open an in-memory database (for tests). Same FK enforcement. */
export function openMemoryDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Close a database connection safely. No-op if already closed or null. */
export function closeDatabase(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // already closed - ignore
  }
}

/** List user table names (excludes sqlite internal tables). */
export function listTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

/** Run a function inside a transaction. Rolls back on any throw. */
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
