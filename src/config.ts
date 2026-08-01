/**
 * Configuration types and defaults for wechat-opencode.
 */

import path from "node:path";
import os from "node:os";

export interface AgentCommandConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentPreset extends AgentCommandConfig {
  label: string;
  description?: string;
}

export interface ResolvedAgentConfig extends AgentCommandConfig {
  id?: string;
  label?: string;
  source: "preset" | "raw";
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  opencode: {
    label: "OpenCode",
    command: "npx",
    args: ["opencode-ai", "acp"],
    description: "OpenCode",
  },
};

export interface ServerConfig {
  /** URL of the opencode serve instance. */
  url: string;
  /** Command to spawn opencode serve as a sidecar (empty = external). */
  command?: string;
  args?: string[];
  /**
   * HTTP Basic auth credentials for the opencode server. Both must be set
   * to take effect; if only one is provided, the server is treated as
   * unauthenticated. Typically used when the server sits behind a reverse
   * proxy (nginx/caddy/traefik) with built-in auth.
   */
  username?: string;
  password?: string;
  /**
   * Bearer token for the opencode server. Sent as `Authorization: Bearer <token>`.
   * Takes precedence over `username`/`password` when both are set.
   * Typically used for API tokens or custom auth middleware.
   */
  token?: string;
}

export interface WeChatOpencodeConfig {
  wechat: {
    baseUrl: string;
    cdnBaseUrl: string;
    botType: string;
    /**
     * Auto-flush ("auto /next") delay in milliseconds.
     *
     * When the bridge hits WeChat's 10-consecutive-message send limit,
     * remaining outbound segments are cached in `pendingOutbound` and
     * normally only delivered on the next user message or an explicit
     * `/next`. With `autoFlushMs` > 0, the bridge additionally starts a
     * timer after the first cache hit and flushes the cached messages
     * automatically once the delay elapses — no user message required.
     * If the 10-msg limit still holds after a flush (more than 10
     * segments were cached), the timer is re-armed for another round.
     *
     * Set to 0 to disable and keep the manual `/next`-only behavior.
     */
    autoFlushMs: number;
  };
  /** OpenCode Server connection config. */
  server: ServerConfig;
  agent: {
    /** @deprecated No longer used — OpenCode Server replaces subprocess spawning. */
    preset?: string;
    /** @deprecated */
    command: string;
    /** @deprecated */
    args: string[];
    cwd: string;
    /** @deprecated */
    env?: Record<string, string>;
    /** @deprecated Use /thought-display instead (persisted in UserState). */
    showThoughts: boolean;
    /** @deprecated Use /tool-display instead (persisted in UserState). */
    showTools: boolean;
  };
  /** @deprecated Agent presets are no longer used. */
  agents: Record<string, AgentPreset>;
  daemon: {
    enabled: boolean;
    logFile: string;
    pidFile: string;
  };
  storage: {
    dir: string;
  };
}

export function defaultStorageDir(): string {
  return path.join(os.homedir(), ".wechat-bridge-opencode");
}

/**
 * Cross-session notification feature (`/notify`).
 *
 * When the OpenCode Server has multiple sessions in flight (e.g. the
 * user opened a long-running background session in TUI/Desktop while
 * chatting with us in WeChat), the bridge normally only sees events
 * for the *current* session — events for other sessions are silently
 * dropped by the sessionID filter in `SessionManager.handleEvent`.
 *
 * With `NotifySettings` enabled, the bridge additionally forwards
 * those dropped events to WeChat as notifications so the user can
 * decide whether to switch sessions. Mirrors the OpenCode Desktop
 * notification UX: the WeChat message names the session and includes
 * a `/session switch <n>` hint.
 *
 * The settings persist to `~/.wechat-bridge-opencode/.wechat-bridge-state.json`
 * alongside the existing `showThoughts` / `autoPermissionMode` fields.
 *
 * - `enabled` — master switch (default: true). When false, no other-session
 *   notifications are sent, even if individual `types.*` are true.
 * - `types` — per-event-type sub-toggles. Each defaults to `true` so the
 *   user gets the full Desktop-like experience out of the box; a user who
 *   only wants the most urgent alerts (e.g. errors) can disable `question`
 *   / `permission` individually without losing everything.
 *
 * Event type semantics:
 *   - `question`   — another session is waiting on an LLM `question` tool
 *                    call (the user can answer via `/session switch` then Q1=).
 *   - `permission` — another session needs a tool permission grant.
 *   - `error`      — another session hit `session.error` (provider auth,
 *                    rate limit, etc.) and won't auto-recover.
 *   - `completion` — another session transitioned from `busy` to `idle`
 *                    (a turn finished). The most common notification —
 *                    mirrors Desktop's "session X is done" toast.
 *
 * Idle→busy transitions are NOT notified (the user didn't ask to know
 * a session *started* — only that it *needs attention* or *finished*).
 */
export interface NotifySettings {
  enabled: boolean;
  types: {
    question: boolean;
    permission: boolean;
    error: boolean;
    completion: boolean;
  };
}

/** Default `NotifySettings` when no preference is persisted. */
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  enabled: true,
  types: {
    question: true,
    permission: true,
    error: true,
    completion: true,
  },
};

/** Type-name union for the per-event sub-toggles (used by parsers/notifier). */
export type NotifyEventType = keyof NotifySettings["types"];

export function defaultTempDir(storageDir: string): string {
  return path.join(storageDir, "tempfile");
}

export function defaultConfig(): WeChatOpencodeConfig {
  const storageDir = defaultStorageDir();
  return {
    wechat: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      botType: "3",
      autoFlushMs: 60_000,
    },
    server: {
      url: "http://localhost:4096",
      command: "npx",
      args: ["opencode-ai", "serve", "--port", "4096"],
    },
    agent: {
      preset: undefined,
      command: "",
      args: [],
      cwd: process.cwd(),
      showThoughts: true,
      showTools: true,
    },
    agents: { ...BUILT_IN_AGENTS },
    daemon: {
      enabled: false,
      logFile: path.join(storageDir, "wechat-opencode.log"),
      pidFile: path.join(storageDir, "daemon.pid"),
    },
    storage: {
      dir: storageDir,
    },
  };
}

/**
 * Parse agent string like "claude code" or "npx tsx ./agent.ts"
 * into { command, args }.
 */
export function parseAgentCommand(agentStr: string): { command: string; args: string[] } {
  const parts = agentStr.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    throw new Error("Agent command cannot be empty");
  }
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export function resolveAgentSelection(
  agentSelection: string,
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): ResolvedAgentConfig {
  const preset = registry[agentSelection];
  if (preset) {
    return {
      id: agentSelection,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: "preset",
    };
  }

  const parsed = parseAgentCommand(agentSelection);
  return {
    command: parsed.command,
    args: parsed.args,
    source: "raw",
  };
}

export function listBuiltInAgents(
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): Array<{ id: string; preset: AgentPreset }> {
  return Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, preset]) => ({ id, preset }));
}
