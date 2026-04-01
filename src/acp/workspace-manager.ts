/**
 * Per-user workspace management.
 *
 * Workspace = project = cwd.
 * Each user has multiple workspaces, one active at a time.
 * Persisted to ~/.wechat-opencode/users/<userId>.json
 */

import fs from "node:fs";
import path from "node:path";

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
}

export interface UserState {
  userId: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface UserManagerOpts {
  storageDir: string;
  defaultCwd: string;
  log: (msg: string) => void;
}

function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 32);
}

function generateId(name: string, existing: string[]): string {
  const base = nameToId(name) || `ws-${Date.now()}`;
  let id = base;
  let counter = 1;
  while (existing.includes(id)) {
    id = `${base}-${counter}`;
    counter++;
  }
  return id;
}

export class UserManager {
  private opts: UserManagerOpts;
  private stateDir: string;
  private cache = new Map<string, UserState>();

  constructor(opts: UserManagerOpts) {
    this.opts = opts;
    this.stateDir = path.join(opts.storageDir, "users");
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  getState(userId: string): UserState {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const stateFile = this.stateFile(userId);
    let state: UserState | null = null;

    try {
      const raw = fs.readFileSync(stateFile, "utf-8");
      state = JSON.parse(raw) as UserState;
    } catch {
      // Not found or invalid
    }

    if (!state || !Array.isArray(state.workspaces)) {
      const defaultWs: Workspace = {
        id: "default",
        name: "Default",
        cwd: this.opts.defaultCwd,
        createdAt: Date.now(),
      };
      state = {
        userId,
        workspaces: [defaultWs],
        activeWorkspaceId: defaultWs.id,
      };
      this.saveState(state);
    }

    if (state.activeWorkspaceId && !state.workspaces.some((w) => w.id === state.activeWorkspaceId)) {
      state.activeWorkspaceId = state.workspaces[0]?.id ?? null;
    }

    this.cache.set(userId, state);
    return state;
  }

  getActiveWorkspace(userId: string): Workspace | null {
    const state = this.getState(userId);
    if (!state.activeWorkspaceId) return null;
    return state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;
  }

  addWorkspace(userId: string, name: string, cwd: string): { workspace: Workspace; created: boolean } {
    const state = this.getState(userId);

    const existingByCwd = state.workspaces.find((w) => w.cwd === cwd);
    if (existingByCwd) return { workspace: existingByCwd, created: false };

    const existingByName = state.workspaces.find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (existingByName) return { workspace: existingByName, created: false };

    const id = generateId(name, state.workspaces.map((w) => w.id));
    const workspace: Workspace = { id, name, cwd, createdAt: Date.now() };
    state.workspaces.push(workspace);
    state.activeWorkspaceId = workspace.id;
    this.saveState(state);

    return { workspace, created: true };
  }

  switchWorkspace(userId: string, nameOrId: string): Workspace | null {
    const state = this.getState(userId);
    const target = state.workspaces.find(
      (w) => w.id === nameOrId || w.name.toLowerCase() === nameOrId.toLowerCase(),
    );
    if (!target) return null;
    state.activeWorkspaceId = target.id;
    this.saveState(state);
    return target;
  }

  removeWorkspace(userId: string, nameOrId: string): { success: boolean; message: string } {
    const state = this.getState(userId);
    if (state.workspaces.length <= 1) {
      return { success: false, message: "Cannot remove the last workspace" };
    }

    const idx = state.workspaces.findIndex(
      (w) => w.id === nameOrId || w.name.toLowerCase() === nameOrId.toLowerCase(),
    );
    if (idx === -1) return { success: false, message: `Workspace "${nameOrId}" not found` };

    const removed = state.workspaces[idx];
    state.workspaces.splice(idx, 1);

    if (state.activeWorkspaceId === removed.id) {
      state.activeWorkspaceId = state.workspaces[0]?.id ?? null;
    }

    this.saveState(state);
    return { success: true, message: `Removed workspace "${removed.name}"` };
  }

  listWorkspaces(userId: string): { workspaces: Workspace[]; activeId: string | null } {
    const state = this.getState(userId);
    return { workspaces: [...state.workspaces], activeId: state.activeWorkspaceId };
  }

  clearCache(userId?: string): void {
    if (userId) {
      this.cache.delete(userId);
    } else {
      this.cache.clear();
    }
  }

  private stateFile(userId: string): string {
    return path.join(this.stateDir, `${userId}.json`);
  }

  private saveState(state: UserState): void {
    try {
      const file = this.stateFile(state.userId);
      fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      this.opts.log(`Failed to save state for ${state.userId}: ${String(err)}`);
    }
  }
}
