import { Notice, Plugin } from 'obsidian';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { EmbeddingChunk, EmbeddingVector, IndexedFile } from './search';

const DB_FILE_NAME = 'index.sqlite';
const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    idx INTEGER NOT NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_path);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

interface ChunkRow {
  id: string;
  file_path: string;
  idx: number;
  heading_path: string;
  text: string;
  embedding: Uint8Array;
  mtime: number;
}

function embeddingToBlob(embedding: EmbeddingVector): Uint8Array {
  const f32 = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToEmbedding(blob: Uint8Array): Float32Array {
  // Copy out of sql.js-owned memory into a standalone buffer.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

/**
 * SQLite persistence for the semantic index, backed by sql.js (WASM).
 * The database lives in memory; mutations are exported to
 * `<plugin dir>/index.sqlite` on a short debounce and on quit.
 * If SQLite cannot be loaded, persistence degrades to no-ops and the
 * index simply stays in memory (as before this store existed).
 */
export class SqliteIndexStore {
  private db: Database | null = null;
  private dbPath: string;
  private dirty = false;
  private persistTimer: number | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 2000;

  constructor(private plugin: Plugin) {
    this.dbPath = `${plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`}/${DB_FILE_NAME}`;
  }

  async open(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    try {
      const wasmDir = this.plugin.manifest.dir ?? `.obsidian/plugins/${this.plugin.manifest.id}`;
      let wasmBinary: ArrayBuffer | undefined;
      try {
        wasmBinary = await adapter.readBinary(`${wasmDir}/sql-wasm.wasm`);
      } catch {
        console.error('[semantic-search] sql-wasm.wasm not found in plugin dir; falling back to default locateFile');
      }
      const SQL: SqlJsStatic = await initSqlJs(wasmBinary !== undefined ? { wasmBinary } : {});

      let buf: ArrayBuffer | null = null;
      if (await adapter.exists(this.dbPath)) {
        buf = await adapter.readBinary(this.dbPath);
      }

      let db: Database;
      try {
        db = buf !== null ? new SQL.Database(new Uint8Array(buf)) : new SQL.Database();
      } catch {
        if (buf !== null) {
          try {
            await adapter.writeBinary(`${this.dbPath}.bak`, buf);
          } catch (backupError) {
            console.error('[semantic-search] could not back up corrupt database', backupError);
          }
          new Notice('Semantic index database was corrupt — starting fresh (backup saved as index.sqlite.bak).');
        }
        db = new SQL.Database();
      }

      this.migrate(db);
      this.db = db;

      // Flush pending writes when Obsidian quits.
      this.plugin.registerEvent(
        this.plugin.app.workspace.on('quit', (tasks) => {
          if (this.dirty) tasks.add(() => this.flush());
        }),
      );
    } catch (e) {
      console.error('[semantic-search] SQLite unavailable — index will be memory-only for this session', e);
      new Notice('Semantic search: index persistence is unavailable; the index will be kept in memory.');
      this.db = null;
    }
  }

  private migrate(db: Database): void {
    const result = db.exec('PRAGMA user_version');
    const version = (result[0]?.values[0]?.[0] as number | undefined) ?? 0;
    if (version > SCHEMA_VERSION) {
      new Notice('Semantic index was created by a newer plugin version — it will be rebuilt.');
      db.run('DROP TABLE IF EXISTS chunks');
      db.run('DROP TABLE IF EXISTS files');
      db.run('DROP TABLE IF EXISTS meta');
    }
    db.run(SCHEMA_SQL);
    if (version !== SCHEMA_VERSION) {
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.markDirty();
    }
  }

  // --- Read helpers -------------------------------------------------------

  /** All indexed files as path → mtime. Empty map when persistence is unavailable. */
  getAllFiles(): Map<string, number> {
    const map = new Map<string, number>();
    if (!this.db) return map;
    const stmt = this.db.prepare('SELECT path, mtime FROM files');
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        map.set(row['path'] as string, row['mtime'] as number);
      }
    } finally {
      stmt.free();
    }
    return map;
  }

  /** Rebuild IndexedFile objects (with Float32Array embeddings) from the database. */
  loadAll(): IndexedFile[] {
    if (!this.db) return [];
    const byPath = new Map<string, IndexedFile>();
    const stmt = this.db.prepare(`
      SELECT c.id, c.file_path, c.idx, c.heading_path, c.text, c.embedding, f.mtime
      FROM chunks c JOIN files f ON f.path = c.file_path
      ORDER BY c.file_path, c.idx
    `);
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as ChunkRow;
        let file = byPath.get(row.file_path);
        if (!file) {
          file = { path: row.file_path, mtime: row.mtime, chunks: [] };
          byPath.set(row.file_path, file);
        }
        file.chunks.push({
          id: row.id,
          text: row.text,
          headingPath: row.heading_path,
          embedding: blobToEmbedding(row.embedding),
        });
      }
    } finally {
      stmt.free();
    }
    return Array.from(byPath.values());
  }

  getMeta(key: string): string | null {
    if (!this.db) return null;
    const stmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    try {
      if (stmt.step()) {
        const row = stmt.getAsObject();
        const value = row['value'];
        return typeof value === 'string' ? value : null;
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  // --- Write helpers ------------------------------------------------------

  setMeta(key: string, value: string): void {
    if (!this.db) return;
    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
    this.markDirty();
  }

  /** Replace the stored index entry for one file, inside a transaction. */
  upsertFile(path: string, mtime: number, chunks: EmbeddingChunk[]): void {
    if (!this.db) return;
    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run('DELETE FROM chunks WHERE file_path = ?', [path]);
      this.db.run('DELETE FROM files WHERE path = ?', [path]);
      this.db.run('INSERT INTO files (path, mtime) VALUES (?, ?)', [path, mtime]);
      const stmt = this.db.prepare(
        'INSERT INTO chunks (id, file_path, idx, heading_path, text, embedding) VALUES (?, ?, ?, ?, ?, ?)',
      );
      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          stmt.run([chunk.id, path, i, chunk.headingPath, chunk.text, embeddingToBlob(chunk.embedding)]);
        }
      } finally {
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.markDirty();
  }

  deleteFile(path: string): void {
    if (!this.db) return;
    this.db.run('DELETE FROM chunks WHERE file_path = ?', [path]);
    this.db.run('DELETE FROM files WHERE path = ?', [path]);
    this.markDirty();
  }

  /** Empty the index (files + chunks); meta is preserved. */
  clearAll(): void {
    if (!this.db) return;
    this.db.run('DELETE FROM chunks');
    this.db.run('DELETE FROM files');
    this.markDirty();
  }

  // --- Persistence --------------------------------------------------------

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer === null) {
      this.persistTimer = window.setTimeout(() => {
        this.persistTimer = null;
        void this.flush();
      }, SqliteIndexStore.PERSIST_DEBOUNCE_MS);
    }
  }

  /** Write the database to disk now if there are pending changes. */
  async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.db || !this.dirty) return;
    this.dirty = false;
    try {
      const bytes = this.db.export();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      await this.plugin.app.vault.adapter.writeBinary(this.dbPath, buffer);
    } catch (e) {
      console.error('[semantic-search] failed to persist index database', e);
      this.markDirty(); // retry after the debounce
    }
  }

  close(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.db?.close();
    this.db = null;
  }
}
