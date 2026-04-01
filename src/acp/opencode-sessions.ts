/**
 * @deprecated No longer used — SessionManager.listAgentSessions() via ACP session/list
 * is the primary source. This module is kept as a fallback only.
 *
 * Read OpenCode sessions from its SQLite database.
 *
 * Database path:
 *   - Linux/macOS: ~/.local/share/opencode/opencode.db
 *   - Windows:     %USERPROFILE%\.local\share\opencode\opencode.db
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface OpencodeSession {
  id: string;
  slug: string;
  projectId: string;
  directory: string;
  title: string;
  timeUpdated: number;
}

function openDb(): import("better-sqlite3").Database | null {
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const candidates = [
    path.join(xdgData, "opencode", "opencode.db"),
    path.join(os.homedir(), "Library", "Application Support", "opencode", "opencode.db"),
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode", "opencode.db"),
  ];
  let dbPath: string | null = null;
  for (const p of candidates) {
    try { fs.accessSync(p); dbPath = p; break; } catch { /* not found */ }
  }
  if (!dbPath) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

export function listSessions(): OpencodeSession[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.prepare(
      "SELECT id, project_id, slug, directory, title, time_updated FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_updated DESC",
    ).all() as Array<{ id: string; project_id: string; slug: string; directory: string; title: string; time_updated: number }>;
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      projectId: r.project_id,
      directory: r.directory,
      title: r.title,
      timeUpdated: r.time_updated,
    }));
  } finally {
    db.close();
  }
}
