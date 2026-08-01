/**
 * WeChatOpencodeBridge — the main orchestrator.
 *
 * Single-user architecture: no Map<string, ...> patterns.
 * Communicates with OpenCode Server via HTTP (not ACP subprocess).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType, UploadMediaType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./server/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import { formatQuestionForWeChat, parseQuestionReply } from "./adapter/question-format.js";
import { formatPermissionCard, parsePermissionReply, formatPermissionSummary } from "./adapter/permission-format.js";
import { formatNotifyStatus } from "./adapter/notify-format.js";
import { SessionNotifier } from "./notifier.js";
import type { MediaContent } from "./types.js";
import type { VcsInfo } from "./types.js";
import type { QuestionPrompt } from "./types/question.js";
import type { AutoPermissionMode } from "./types/permission.js";
import { DEFAULT_AUTO_PERMISSION_MODE } from "./types/permission.js";
import {
  parseWorkspaceCommand,
  parseSessionCommand,
  parseAgentCommand,
  parseModelCommand,
  parseReasoningCommand,
  parseStatusCommand,
  parseThoughtDisplayCommand,
  parseToolDisplayCommand,
  parseStopCommand,
  parseCompactCommand,
  parseRestartCommand,
  parseRejectQuestionCommand,
  parseRejectPermissionCommand,
  parseAutoPermissionCommand,
  parseNotifyCommand,
  parseSilentCommand,
  parseVersionCommand,
  parseHelpCommand,
  parseHistoryCommand,
  formatHelpWithNativeCommands,
  formatStatus,
  formatWorkspaceList,
  fetchAndFormatHistory,
} from "./adapter/workspace-cmd.js";
import type { WeChatOpencodeConfig } from "./config.js";
import type { NotifySettings } from "./config.js";
import { DEFAULT_NOTIFY_SETTINGS } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;
const TOOL_API_PORT = 18792;
const TOOL_API_HOST = "127.0.0.1";
/**
 * Threshold for the "still working, please wait" reminder sent by
 * `runWithSlowWarn`. Commands that finish faster than this send only the
 * final reply; commands that take longer (e.g. `/status` while MCP status
 * or `/help` while fetching native commands from a slow server) emit a
 * short hint to the user so they don't think the bridge is hung.
 *
 * Two seconds was chosen because typing indicator alone doesn't read as
 * "actively working" in WeChat private messages — the user often waits
 * longer for typing indicators during real conversations and doesn't know
 * when the bot has stalled.
 */
const SLOW_WARN_THRESHOLD_MS = 2000;
/**
 * Max number of workspaces to render in `/workspace list`. Mirrors the
 * `/session list` cap so the WeChat reply stays a manageable size even
 * when the user has many projects. Anything past the cap is reachable via
 * `/workspace switch <path>`.
 */
const WORKSPACE_LIST_MAX = 20;

/**
 * Read the bridge's own version from the nearest package.json. The compiled
 * output lives at `dist/src/bridge.js` (package.json is two levels up), but
 * when running TypeScript sources directly (e.g. via tsx) it lives at
 * `src/bridge.ts` (package.json is one level up). We try both candidates.
 */
const BRIDGE_VERSION: string = (() => {
  const require_ = createRequire(import.meta.url);
  const candidates = ["../../package.json", "../package.json"];
  for (const c of candidates) {
    try {
      const pkg = require_(c) as { name?: string; version?: string };
      if (pkg?.name === "wechat-bridge-opencode" && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "unknown";
})();

/**
 * Resolve the npm package name used to install OpenCode, derived from the
 * server-spawn configuration. Used by `/version` to query the npm registry
 * for the latest available version.
 *
 * Defaults to `opencode-ai` for the typical npx or direct-binary install.
 * For npx invocations, returns the first non-flag arg with any `@version`
 * pin stripped. Handles both `opencode-ai@1.0.0` and scoped `@scope/pkg@1.0.0`.
 */
function resolveOpencodePackageName(
  serverCommand: string,
  serverArgs: string[],
): string {
  if (serverCommand === "npx" && serverArgs.length > 0) {
    const pkgIdx = serverArgs.findIndex((a) => !a.startsWith("-"));
    if (pkgIdx !== -1) {
      const arg = serverArgs[pkgIdx]!;
      // For scoped packages ("@scope/pkg"), the first "@" is at index 0 and
      // is part of the name; the version separator is the SECOND "@".
      // For unscoped packages, the first "@" is the version separator.
      const atIdx = arg.startsWith("@") ? arg.indexOf("@", 1) : arg.indexOf("@");
      if (atIdx > 0) return arg.slice(0, atIdx);
      return arg;
    }
  }
  return "opencode-ai";
}

/**
 * Compare two semver-ish strings and return true if `latest` is strictly
 * newer than `current`. Both arguments may have a `v` prefix; pre-release
 * tags (e.g. `-rc.1`) are ignored — we only compare `major.minor.patch`.
 * Returns false on parse failure.
 */
function isNewerSemver(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = v.replace(/^v/, "").split(/[-+]/)[0]?.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}

/** A message cached when WeChat 10-msg limit is reached, flushed on /next. */
type PendingMessage =
  | { kind: "text"; text: string; contextToken: string }
  | { kind: "media"; block: MediaContent; contextToken: string }
  | { kind: "tool_text"; text: string; contextToken: string }
  | { kind: "tool_file"; filePath: string; fileName: string; mimeType?: string; contextToken: string };

interface UserState {
  userId: string;
  sessionId: string;
  cwd: string;
  showThoughts?: boolean;
  showTools?: boolean;
  /**
   * Silent / immersive mode. When true, the bridge suppresses the
   * agent's incremental working output (reasoning, tool summaries,
   * incremental text parts) and only sends the LAST text part at turn
   * completion. Questions and permission requests are unaffected.
   * Persisted across bridge restarts.
   */
  immersiveMode?: boolean;
  /**
   * Auto-accept mode for OpenCode permission requests. Persisted across
   * bridge restarts. See `AutoPermissionMode` in
   * `src/types/permission.ts` for semantics.
   */
  autoPermissionMode?: AutoPermissionMode;
  /**
   * Cross-session notification settings (master switch + per-type
   * toggles). Persisted across bridge restarts; see `NotifySettings`
   * in `src/config.ts` and the `/notify` command for the user-facing
   * surface. When absent, `SessionNotifier` falls back to
   * `DEFAULT_NOTIFY_SETTINGS` (all notifications on).
   */
  notify?: NotifySettings;
}

export class WeChatOpencodeBridge {
  private config: WeChatOpencodeConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  private userState: UserState | null = null;
  /**
   * Cwd filter from the most recent `/session list`. `undefined` means the
   * last list was unfiltered (or no list has run); a string means the
   * next `/session switch <n>` should look up against that filtered list,
   * so the number the user sees in the list matches the number they type.
   * Reset on every `/session list` call.
   */
  private lastSessionListFilter: string | undefined = undefined;
  private currentContextToken: string | null = null;
  private typingTicket: { ticket: string; expiresAt: number } | null = null;
  private toolApiServer: http.Server | null = null;
  /**
   * Cross-session notifier. Created after `sessionManager` (it needs
   * the SessionManager's OpenCode client to look up session titles),
   * and wired into SessionManager via the `onOtherSessionEvent`
   * callback. Lives for the lifetime of the bridge; settings are
   * persisted to `.wechat-bridge-state.json` and reloaded at startup
   * via `loadUserState()` + `notifier.applySettings()`.
   *
   * Stays `null` until the SessionManager is constructed (mirrors
   * the `sessionManager` field above). The dispatch chain in
   * `handleMessage` only routes `/notify` when this is non-null.
   */
  private notifier: SessionNotifier | null = null;

  // Single-user state (no Map<string, ...>)
  private wechatMsgCount = 0;
  private pendingOutbound: PendingMessage[] = [];
  // Per-contextToken outbound FIFO queue. SessionManager fires multiple
  // `onReply` calls back-to-back (tool summary + thought line / text part)
  // without awaiting each other; without serialization the shorter payload
  // can race ahead of the longer one and reverse the chronological order
  // on WeChat. This chain ensures the WeChat server receives messages in
  // the same order the bridge dispatches them.
  private outboundQueue = new Map<string, Promise<unknown>>();
  private static readonly MSG_LIMIT_WARN = 7;
  private static readonly MSG_LIMIT_MAX = 10;
  /**
   * Auto-flush ("auto /next") timer. Armed on the first cache hit while
   * `pendingOutbound` is non-empty; fires once and re-arms if the 10-msg
   * limit left messages cached. `null` when disabled (`autoFlushMs <= 0`)
   * or while a timer is pending.
   */
  private autoFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private log: (msg: string) => void;
  private restartServer?: () => Promise<void>;

  constructor(
    config: WeChatOpencodeConfig,
    log?: (msg: string) => void,
    /**
     * Optional callback invoked by the `/restart` command. When provided, the
     * bridge will tear down its SSE event pipeline + cancel in-flight work,
     * then call this to restart the opencode serve subprocess, then re-attach
     * to the previous session (or create a new one if it's gone) and resume
     * the SSE pipeline.
     *
     * The callback is responsible for killing the old server and starting a
     * new one, and it MUST NOT return until the new server is reachable
     * (e.g. `/global/health` returns 200). The bridge will fail subsequent
     * session re-attach if the server is not actually up.
     *
     * When not provided (e.g. with `--server-url` to use an external
     * server), `/restart` falls back to re-attaching to the previous
     * session on the existing server.
     */
    restartServer?: () => Promise<void>,
  ) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-opencode] ${msg}`));
    this.restartServer = restartServer;
  }

  // ─── Lifecycle ───

  async start(opts?: { forceLogin?: boolean; renderQrUrl?: (url: string) => void }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    const authDir = path.join(this.config.storage.dir, "auth");
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    this.log(`Auth directory: ${authDir}`);
    this.log(`Temp directory: ${tempDir}`);

    // 1. Login
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
    }
    if (!this.tokenData) {
      this.tokenData = await login({
        baseUrl: this.config.wechat.baseUrl,
        botType: this.config.wechat.botType,
        storageDir: this.config.storage.dir,
        log: this.log,
        renderQrUrl,
      });
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log("Use --login to force re-login");
    }

    // 2. Load saved user state
    this.loadUserState();

    // Reset stale user state when the saved cwd no longer matches the
    // directory the bridge was started from. Without this, /status reports
    // the old cwd while the SessionManager and the actual opencode server
    // session use config.agent.cwd — so the agent runs in a different
    // directory than what the user sees. The user's last sessionId is
    // dropped too: it's tied to the old cwd and may not exist on the
    // server (or may belong to a different workspace's worktree).
    if (this.userState && this.userState.cwd !== this.config.agent.cwd) {
      this.log(
        `Discarding stale user state: saved cwd=${this.userState.cwd} ` +
          `does not match start cwd=${this.config.agent.cwd}`,
      );
      this.userState = null;
      // Persist the cleared state so subsequent reads stay consistent.
      try {
        const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
        fs.writeFileSync(stateFile, JSON.stringify({}, null, 2), "utf-8");
      } catch {
        // Best effort
      }
    }

    // 3. Create SessionManager (HTTP-based, no subprocess)
    this.sessionManager = new SessionManager({
      serverUrl: this.config.server.url,
      cwd: this.config.agent.cwd,
      log: this.log,
      onReply: (contextToken, text) => this.sendReply(contextToken, text),
      // Best-effort failure-notice path: when an `onReply` (or any
      // sub-type like text part / reasoning summary / tool summary /
      // fallback / error notice) exhausts its retries, the
      // SessionManager invokes `onSendWarning` so we can tell the user
      // "⚠️ 上一条<label>发送失败…" instead of silently losing the
      // message. The bridge wires this to `sendWarningReply`, which
      // is a single-shot, NO-retry, catch-all best-effort send — if
      // even the warning fails, we just log and move on (there is no
      // further escalation available when the WeChat gateway itself
      // is unreachable).
      onSendWarning: (contextToken, text) => this.sendWarningReply(contextToken, text),
      // System-level notices (stuck-turn detection, SSE pipeline
      // outage/recovery). Delivered through the normal outbound queue so
      // they can't reorder with an agent reply; best-effort on failure.
      // An empty contextToken (e.g. WeChat-channel notices that don't
      // carry one) falls back to the most recent user message's token.
      onNotify: (contextToken, text) => {
        const ctx = contextToken || this.currentContextToken;
        if (!ctx) return Promise.resolve();
        return this.sendReply(ctx, text);
      },
      onMediaReply: (contextToken, blocks) => this.sendMediaReply(contextToken, blocks),
      sendTyping: (contextToken) => this.sendTypingIndicator(contextToken),
      cancelTyping: (contextToken) => this.cancelTypingIndicator(contextToken),
      onSessionReady: (sessionId) => {
        if (!this.userState) {
          this.setUserState(sessionId, this.config.agent.cwd);
        } else if (this.userState.sessionId !== sessionId) {
          this.setUserState(sessionId, this.userState.cwd);
        }
        // Sync the cross-session notifier's "current" pointer.
        // The notifier uses this to drop events for the active
        // session (the SessionManager already dispatches those via
        // its normal `handleEvent` switch — no need to duplicate).
        this.notifier?.setCurrentSessionId(sessionId);
      },
      // Forward server auth verbatim. The values are sensitive — neither
      // the bridge nor the SessionManager logs them. The client only
      // computes the final `Authorization` header value at construction.
      auth: {
        username: this.config.server.username,
        password: this.config.server.password,
        token: this.config.server.token,
      },
      // Question lifecycle hooks. The sessionManager invokes these when
      // a `question.asked` SSE event lands (or when the 30-min soft
      // timeout fires). We render the question to WeChat and notify the
      // user on timeout, then let the sessionManager manage the actual
      // HTTP reply/reject.
      onQuestionAsked: async (contextToken, questions, requestID) => {
        const formatted = formatQuestionForWeChat(questions);
        await this.sendReply(contextToken, formatted);
        this.log(`[question] formatted for WeChat: id=${requestID.slice(0, 12)}…, ${questions.length} question(s)`);
      },
      onQuestionTimedOut: async (contextToken) => {
        await this.sendReply(
          contextToken,
          "⏱ Question timed out after 30 minutes. Proceeding without answer. (Use /next to reset counter.)",
        );
      },
      // Permission lifecycle hooks. Same shape as question: render the
      // card on `asked`, notify on timeout, let the sessionManager
      // handle the HTTP reply/reject. Only called when auto-mode is
      // `off` (the default) — `once`/`always` auto-replies bypass
      // these callbacks entirely.
      onPermissionAsked: async (contextToken, request, requestID) => {
        // Compute index/total so the card can show the right syntax:
        // single-pending cards say "Reply with 1 | 2 | 3"; multi-
        // pending cards say "Send 1 to apply to ALL or P1=once P2=…".
        // The new permission was just added to the pending map by
        // SessionManager.setPendingPermission before this callback
        // runs, so listPendingPermissions() includes it.
        const allPending = this.sessionManager!.listPendingPermissions();
        const total = allPending.length;
        const index = allPending.findIndex((p) => p.requestID === requestID);
        const card = formatPermissionCard(
          request,
          index >= 0 ? index + 1 : undefined,
          total > 1 ? total : undefined,
        );
        await this.sendReply(contextToken, card);
        this.log(`[permission] card sent: id=${requestID.slice(0, 12)}… permission=${request.permission} patterns=${request.patterns.length} (${total} pending)`);
      },
      onPermissionTimedOut: async (contextToken, requestID) => {
        await this.sendReply(
          contextToken,
          `⏱ Permission timed out after 30 minutes. The tool call was rejected. (Use /next to reset counter.)`,
        );
      },
      // Cross-session notification hook. The SessionManager invokes
      // this for every SSE event whose `sessionID` does NOT match the
      // current session — events that the `handleEvent` filter would
      // otherwise silently drop. We forward to `this.notifier` (created
      // immediately below). The closure resolves `this.notifier`
      // lazily because at the time this callback is registered the
      // notifier hasn't been constructed yet (it needs the
      // SessionManager's OpenCode client, which only exists after this
      // `new SessionManager(...)` call returns).
      onOtherSessionEvent: (event) => {
        const n = this.notifier;
        if (n) {
          // Fire-and-forget. `SessionNotifier.handleEvent` is async
          // (it awaits the label cache fetch) but catches all errors
          // internally, so a slow label fetch cannot back-pressure
          // the SSE pipeline. We don't return its promise because
          // `SessionManagerOpts.onOtherSessionEvent` accepts
          // `void | Promise<void>` and the synchronous void path is
          // cheaper on the SSE hot loop.
          void n.handleEvent(event);
        }
      },
    });

    // Create the cross-session notifier now that the SessionManager
    // (and therefore its OpenCode client) exists. The notifier reads
    // session titles via the same client the SessionManager uses, so
    // there's no second connection to manage. Settings are loaded
    // from persisted state just below.
    this.notifier = new SessionNotifier({
      client: this.sessionManager.getOpenCodeClient(),
      // Push notifications through the same outbound path the bridge
      // uses for everything else — respects WeChat's 10-msg / 4000-char
      // limits and the outbound serialization queue.
      send: (text) => {
        const ctx = this.currentContextToken;
        if (ctx) {
          return this.sendReply(ctx, text);
        }
        // No current context (e.g. notification fires during the brief
        // window between bridge startup and the first user message).
        // Buffer it for the next user message; the auto-flush on
        // incoming messages will deliver it. We use the existing
        // `"text"` kind (rather than introducing a new `outbound`
        // kind) so `flushPending` handles it without a code change —
        // notify text is semantically the same as cached agent text
        // for delivery purposes.
        this.pendingOutbound.push({ kind: "text", text, contextToken: "" });
        this.scheduleAutoFlush("");
        return Promise.resolve();
      },
      log: (msg) => this.log(msg),
    });

    // Apply persisted notify settings. The default (`DEFAULT_NOTIFY_SETTINGS`)
    // is what the notifier was constructed with; only override if we have
    // a real persisted state.
    if (this.userState?.notify) {
      this.notifier.applySettings(this.userState.notify);
    } else {
      this.notifier.applySettings(DEFAULT_NOTIFY_SETTINGS);
    }

    // Sync the notifier with the current session. The SessionManager's
    // `sessionId` is set by `ensureSession` lazily — for now we just
    // prime it with whatever the saved state says (the SessionManager
    // will refresh on its first `ensureSession` call via
    // `setCurrentSessionId` from the `onSessionReady` callback chain
    // below; we also push updates explicitly on session/workspace
    // switches — see those handlers).
    this.notifier.setCurrentSessionId(this.sessionManager.getSessionId() ?? this.userState?.sessionId ?? null);

    // Restore persisted display flags (only if defined to avoid clobbering
    // server-side defaults). setShowFlags is partial-update safe: passing
    // `undefined` for a field leaves it untouched.
    if (this.userState && (this.userState.showThoughts !== undefined || this.userState.showTools !== undefined)) {
      this.sessionManager.setShowFlags({
        showThoughts: this.userState.showThoughts,
        showTools: this.userState.showTools,
      });
    }

    // Restore persisted silent / immersive mode (only if defined to
    // avoid clobbering the server-side default of `false`). When true,
    // the SessionManager suppresses incremental working output and only
    // emits the final text reply at turn completion.
    if (this.userState?.immersiveMode !== undefined) {
      this.sessionManager.setImmersiveMode(this.userState.immersiveMode);
    }

    // Restore persisted auto-permission mode (same partial-update
    // principle: default to `off` when absent). The sessionManager
    // consults this on every `permission.asked` event — `off` shows
    // the WeChat card, `once`/`always` auto-reply without one.
    if (this.userState?.autoPermissionMode !== undefined) {
      this.sessionManager.setAutoPermissionMode(this.userState.autoPermissionMode);
    } else {
      this.sessionManager.setAutoPermissionMode(DEFAULT_AUTO_PERMISSION_MODE);
    }
    this.log(`[permission] auto-mode: ${this.sessionManager.getAutoPermissionMode()}`);

    // 4. Tool API server
    this.startToolApiServer();

    // 4.5 Clean up any leaked questions from a previous bridge instance.
    // If the bridge crashed or restarted while a question was pending,
    // the server's `/question` endpoint will still list it; we reject
    // them proactively so the server's pending Map doesn't grow. This
    // is a best-effort cleanup — failures are logged but non-fatal.
    try {
      const leaked = await this.sessionManager.listLeakedQuestions(this.config.agent.cwd);
      for (const req of leaked) {
        this.log(`[question-startup] rejecting leaked question id=${req.id.slice(0, 12)}…`);
      }
      if (leaked.length > 0) {
        this.log(`[question-startup] rejected ${leaked.length} leaked question(s)`);
      }
    } catch (err) {
      this.log(`[question-startup] leaked-question check failed (non-fatal): ${String(err)}`);
    }

    // 4.6 Same cleanup for leaked permissions. Any permission that was
    // pending when a previous bridge instance died gets rejected
    // proactively so the next session isn't blocked. The user already
    // moved on; re-surfacing those cards would be confusing.
    try {
      const leaked = await this.sessionManager.listLeakedPermissions(this.config.agent.cwd);
      for (const req of leaked) {
        await this.sessionManager.rejectOrphanPermission(req.id, this.config.agent.cwd);
        this.log(`[permission-startup] rejected leaked permission id=${req.id.slice(0, 12)}…`);
      }
      if (leaked.length > 0) {
        this.log(`[permission-startup] rejected ${leaked.length} leaked permission(s)`);
      }
    } catch (err) {
      this.log(`[permission-startup] leaked-permission check failed (non-fatal): ${String(err)}`);
    }

    // 5. Start the SSE event pipeline so we don't miss any agent events
    //    (session.status, message.part.delta, sub-agent completions, etc.).
    //    The pipeline is always-on and filters by sessionId internally.
    await this.sessionManager.startEventPipeline(this.config.agent.cwd);

    // 6. Monitor loop
    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg) => this.handleMessage(msg),
      // WeChat-channel condition notices (session expiry, poll failures,
      // recovery). No contextToken of their own — the bridge falls back
      // to the most recent user message's token for delivery.
      onNotify: (text) => this.sendReply(this.currentContextToken ?? "", text),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    if (this.autoFlushTimer) {
      clearTimeout(this.autoFlushTimer);
      this.autoFlushTimer = null;
    }
    this.abortController.abort();
    // Stop the SSE event pipeline before tearing down the session manager.
    if (this.sessionManager) {
      await this.sessionManager.stopEventPipeline();
    }
    // If a question was still pending when the user quit, reject it so the
    // server's `Deferred.await()` doesn't block forever. Best-effort:
    // network/parse errors are swallowed because the bridge is shutting
    // down anyway. The server's instance dispose finalizer would
    // eventually clean up stragglers, but we don't want to wait.
    if (this.sessionManager?.hasPendingQuestion()) {
      try {
        await this.sessionManager.rejectPendingQuestion();
      } catch {
        // best effort during shutdown
      }
    }
    // Same cleanup for permissions: reject any pending cards so the
    // server's `Deferred.await()` doesn't block forever. Iterate all
    // pending requestIDs (Map-keyed, unlike the question tool's single
    // slot). Server's reject cascade handles siblings automatically.
    if (this.sessionManager?.hasPendingPermission()) {
      const pending = this.sessionManager.listPendingPermissions();
      this.log(`[permission-shutdown] rejecting ${pending.length} pending permission(s)`);
      for (const p of pending) {
        try {
          await this.sessionManager.rejectPendingPermission(p.requestID);
        } catch {
          // best effort during shutdown
        }
      }
    }
    this.sessionManager = null;
    if (this.toolApiServer) {
      await new Promise<void>((resolve) => this.toolApiServer!.close(() => resolve()));
      this.toolApiServer = null;
    }
    this.log("Bridge stopped");
  }

  // ─── User state (single-user) ───

  private loadUserState(): void {
    try {
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      const raw = fs.readFileSync(stateFile, "utf-8");
      const state = JSON.parse(raw) as
        | {
            sessionId?: string;
            cwd: string;
            showThoughts?: boolean;
            showTools?: boolean;
            immersiveMode?: boolean;
            autoPermissionMode?: "off" | "once" | "always";
            notify?: NotifySettings;
          }
        | {
            users?: Array<{ userId: string; sessionId?: string; cwd: string }>;
            showThoughts?: boolean;
            showTools?: boolean;
            immersiveMode?: boolean;
            autoPermissionMode?: "off" | "once" | "always";
            notify?: NotifySettings;
          };
      if ("users" in state && state.users && state.users.length > 0) {
        const u = state.users[0];
        this.userState = {
          userId: u.userId ?? "",
          sessionId: u.sessionId ?? "",
          cwd: u.cwd,
          showThoughts: state.showThoughts,
          showTools: state.showTools,
          immersiveMode: state.immersiveMode,
          autoPermissionMode: state.autoPermissionMode,
          notify: state.notify,
        };
      } else if ("sessionId" in state || "cwd" in state) {
        this.userState = {
          userId: "",
          sessionId: (state as { sessionId?: string }).sessionId ?? "",
          cwd: (state as { cwd: string }).cwd,
          showThoughts: state.showThoughts,
          showTools: state.showTools,
          immersiveMode: (state as { immersiveMode?: boolean }).immersiveMode,
          autoPermissionMode: (state as { autoPermissionMode?: "off" | "once" | "always" }).autoPermissionMode,
          notify: (state as { notify?: NotifySettings }).notify,
        };
      }
    } catch {
      // No saved state
    }
  }

  private saveUserState(): void {
    if (!this.userState) return;
    try {
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      const payload: Record<string, unknown> = {
        users: [
          {
            userId: this.userState.userId,
            sessionId: this.userState.sessionId,
            cwd: this.userState.cwd,
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      if (this.userState.showThoughts !== undefined) payload.showThoughts = this.userState.showThoughts;
      if (this.userState.showTools !== undefined) payload.showTools = this.userState.showTools;
      if (this.userState.immersiveMode !== undefined) payload.immersiveMode = this.userState.immersiveMode;
      if (this.userState.autoPermissionMode !== undefined) payload.autoPermissionMode = this.userState.autoPermissionMode;
      if (this.userState.notify !== undefined) payload.notify = this.userState.notify;
      fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
    } catch {
      // Best effort
    }
  }

  private setUserState(sessionId: string, cwd: string): void {
    const userId = this.userState?.userId ?? "";
    // Preserve display flags (`showThoughts` / `showTools`) and notify
    // settings across workspace and session switches — without this
    // spread, /workspace switch or /session switch would silently
    // reset the user's display settings and cross-session notify
    // configuration.
    this.userState = this.userState
      ? { ...this.userState, sessionId, cwd }
      : { userId, sessionId, cwd };
    this.saveUserState();
  }

  // ─── Tool API (send-wechat endpoint) ───

  private startToolApiServer(): void {
    this.toolApiServer = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/send-wechat") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;

      try {
        const { filePath, mimeType, text } = JSON.parse(body) as {
          sessionId?: string; userId?: string; filePath?: string; mimeType?: string; text?: string;
        };

        if (!text && !filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Either text or filePath is required" }));
          return;
        }

        const targetUserId = this.userState?.userId ?? "";
        const contextToken = this.currentContextToken ?? "";
        const results: string[] = [];

        // Send text
        if (text) {
          const segments = splitText(text, TEXT_CHUNK_LIMIT);
          for (const segment of segments) {
            if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
              this.log(`[tool-api] WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching remaining text segments`);
              const remaining = segments.slice(segments.indexOf(segment));
              const cached: PendingMessage[] = remaining.map((s) => ({ kind: "tool_text", text: s, contextToken }));
              this.pendingOutbound = [...this.pendingOutbound, ...cached];
              this.scheduleAutoFlush(contextToken);
              break;
            }
            this.wechatMsgCount++;
            let payload = segment;
            if (this.wechatMsgCount > WeChatOpencodeBridge.MSG_LIMIT_WARN) {
              payload += `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${this.wechatMsgCount} 条）${this.msgLimitNotice()}`;
            }
            await sendTextMessage(targetUserId, payload, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
            });
          }
          results.push("text");
          this.log(`[tool-api] Sent text (${text.length} chars, sent=${this.wechatMsgCount})`);
        }

        // Send file
        if (filePath) {
          if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
            this.log(`[tool-api] WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching file`);
            const fName = path.basename(filePath);
            this.pendingOutbound.push({ kind: "tool_file", filePath, fileName: fName, mimeType, contextToken });
            this.scheduleAutoFlush(contextToken);
          } else {
            this.wechatMsgCount++;
            const fileBuffer = await fs.promises.readFile(filePath);
            const fileName = path.basename(filePath);
            const detectedMimeType = mimeType ?? this.guessMimeType(fileName);
            await sendMediaMessage(targetUserId, this.mimeToMediaType(detectedMimeType), fileBuffer, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
              cdnBaseUrl: this.config.wechat.cdnBaseUrl,
              mimeType: detectedMimeType,
              fileName,
            });
            results.push("file");
            this.log(`[tool-api] Sent file ${fileName} (sent=${this.wechatMsgCount})`);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, sent: results }));
      } catch (err) {
        this.log(`[tool-api] Error: ${String(err)}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });

    this.toolApiServer.listen(TOOL_API_PORT, TOOL_API_HOST, () => {
      this.log(`Tool API server listening on ${TOOL_API_HOST}:${TOOL_API_PORT}`);
    });
    this.toolApiServer.on("error", (err) => {
      this.log(`Tool API server error: ${String(err)}`);
    });
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      bmp: "image/bmp", ico: "image/x-icon",
      mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
      mkv: "video/x-matroska", webm: "video/webm", flv: "video/x-flv",
      wmv: "video/x-ms-wmv", m4v: "video/mp4", "3gp": "video/3gpp",
      mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac",
      ogg: "audio/ogg", flac: "audio/flac", wma: "audio/x-ms-wma",
      m4a: "audio/mp4", amr: "audio/amr", opus: "audio/opus",
      pdf: "application/pdf", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      txt: "text/plain", md: "text/markdown", json: "application/json",
      js: "text/javascript", ts: "text/typescript", py: "text/x-python",
      java: "text/x-java", go: "text/x-go", rs: "text/x-rust",
      c: "text/x-c", cpp: "text/x-c++", h: "text/x-c",
      cs: "text/x-csharp", php: "text/x-php", rb: "text/x-ruby",
      swift: "text/x-swift", kt: "text/x-kotlin", scala: "text/x-scala",
      html: "text/html", css: "text/css", xml: "text/xml",
      yaml: "text/yaml", yml: "text/yaml", toml: "text/toml",
      ini: "text/plain", cfg: "text/plain", conf: "text/plain",
      log: "text/plain", csv: "text/csv",
      zip: "application/zip", rar: "application/vnd.rar",
      "7z": "application/x-7z-compressed", tar: "application/x-tar",
      gz: "application/gzip", bz2: "application/x-bzip2",
    };
    return map[ext] ?? "application/octet-stream";
  }

  private mimeToMediaType(mime: string): 1 | 2 | 3 | 4 {
    if (mime.startsWith("image/")) return UploadMediaType.IMAGE;
    if (mime.startsWith("video/")) return UploadMediaType.VIDEO;
    return UploadMediaType.FILE;
  }

  // ─── Message handling ───

  private handleMessage(msg: WeixinMessage): void {
    if (msg.message_type !== MessageType.USER) return;
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    // Any incoming user message resets the WeChat 10-msg gateway counter.
    // This MUST run before the permission/question early returns below —
    // otherwise, replies to a pending permission card (e.g. typing `1`
    // or `/ap once` while a card is showing) wouldn't reset, and the
    // counter would carry over to the agent's next reply. See the bug
    // report: "我用了，没发现持久化存储到json里面呢" session.
    this.wechatMsgCount = 0;

    // If a permission is pending, the next user message is (almost
    // always) the decision. Route to handlePermissionReply which
    // checks for priority commands (/rp, /ap, /help, /status) before
    // parsing the text as a once/always/reject choice. Permission
    // check runs BEFORE question (see `.omo/plans/permission-tool-
    // design.md` §7.6 — permission cards have higher urgency since
    // the agent is blocked on a tool call).
    if (this.sessionManager?.hasPendingPermission()) {
      const text = this.extractTextFromMessage(msg);
      if (text === null) {
        // Non-text message (image/file/voice) while waiting for a
        // permission decision. Tell the user we need text and bail.
        this.sendReply(
          contextToken,
          "⚠️ 当前正在等待 permission 回复，请用文本回复（1 / 2 / 3 或 `P1=once`）。",
        ).catch(() => {});
        return;
      }
      this.handlePermissionReply(contextToken, text).catch((err: unknown) => {
        this.log(`handlePermissionReply error: ${String(err)}`);
      });
      return;
    }

    // If a question is pending, the next user message is (almost always)
    // the answer. Route to handleQuestionReply which checks for priority
    // commands (/stop, /next, /restart, /reject-question) before
    // parsing the text as an answer. This early-return is essential —
    // we must NOT let the answer text accidentally trigger slash-command
    // parsing and lose the answer.
    if (this.sessionManager?.hasPendingQuestion()) {
      const text = this.extractTextFromMessage(msg);
      if (text === null) {
        // Non-text message (image/file/voice) while waiting for an
        // answer. Tell the user we need text and bail.
        this.sendReply(
          contextToken,
          "⚠️ 当前正在等待 question 答案，请用文本回复（数字或自定义文字，例如 `Q1=1` 或 `Q1-我的想法`）。",
        ).catch(() => {});
        return;
      }
      this.handleQuestionReply(contextToken, text).catch((err: unknown) => {
        this.log(`handleQuestionReply error: ${String(err)}`);
      });
      return;
    }

    // Track context token for send-wechat tool replies
    this.currentContextToken = contextToken;

    // Ensure user state — always set userId, loadUserState may have set it to ""
    if (!this.userState) {
      this.userState = { userId, sessionId: "", cwd: this.config.agent.cwd };
    } else {
      this.userState.userId = userId;
    }
    this.saveUserState();

    // Auto-flush pending cache on any user message
    if (this.pendingOutbound.length > 0 && !/^\/next\b/.test(this.extractTextFromMessage(msg)?.trim() ?? "")) {
      this.flushPending(contextToken).catch((err) => {
        this.log(`auto-flush error: ${String(err)}`);
      });
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    const textContent = this.extractTextFromMessage(msg);
    if (textContent) {
      if (parseHelpCommand(textContent)) {
        this.sendHelpReply(contextToken).catch(() => {});
        return;
      }

      const wsCmd = parseWorkspaceCommand(textContent);
      if (wsCmd) {
        this.handleDirectoryCommand(contextToken, wsCmd).catch((err) => {
          this.log(`Directory command error: ${String(err)}`);
        });
        return;
      }

      const sCmd = parseSessionCommand(textContent);
      if (sCmd) {
        this.handleSessionCommand(contextToken, sCmd).catch((err) => {
          this.log(`Session command error: ${String(err)}`);
        });
        return;
      }

      const aCmd = parseAgentCommand(textContent);
      if (aCmd) {
        this.handleAgentCommand(contextToken, aCmd).catch((err) => {
          this.log(`Agent command error: ${String(err)}`);
        });
        return;
      }

      const mCmd = parseModelCommand(textContent);
      if (mCmd) {
        this.handleModelCommand(contextToken, mCmd).catch((err) => {
          this.log(`Model command error: ${String(err)}`);
        });
        return;
      }

      const rCmd = parseReasoningCommand(textContent);
      if (rCmd) {
        this.handleReasoningCommand(contextToken, rCmd).catch((err) => {
          this.log(`Reasoning command error: ${String(err)}`);
        });
        return;
      }

      const stCmd = parseStatusCommand(textContent);
      if (stCmd) {
        this.handleStatusCommand(contextToken, stCmd).catch((err) => {
          this.log(`Status command error: ${String(err)}`);
        });
        return;
      }

      const tdCmd = parseThoughtDisplayCommand(textContent);
      if (tdCmd) {
        this.handleThoughtDisplayCommand(contextToken, tdCmd).catch((err) => {
          this.log(`Thought-display command error: ${String(err)}`);
        });
        return;
      }

      const tldCmd = parseToolDisplayCommand(textContent);
      if (tldCmd) {
        this.handleToolDisplayCommand(contextToken, tldCmd).catch((err) => {
          this.log(`Tool-display command error: ${String(err)}`);
        });
        return;
      }

      const silentCmd = parseSilentCommand(textContent);
      if (silentCmd) {
        this.handleSilentCommand(contextToken, silentCmd).catch((err) => {
          this.log(`Silent command error: ${String(err)}`);
        });
        return;
      }

      const stopCmd = parseStopCommand(textContent);
      if (stopCmd) {
        this.handleStopCommand(contextToken, stopCmd).catch((err) => {
          this.log(`Stop command error: ${String(err)}`);
        });
        return;
      }

      const compactCmd = parseCompactCommand(textContent);
      if (compactCmd) {
        this.handleCompactCommand(contextToken, compactCmd).catch((err) => {
          this.log(`Compact command error: ${String(err)}`);
        });
        return;
      }

      // /next — flush cached messages, do NOT forward to agent
      if (/^\/next\b/.test(textContent.trim())) {
        this.flushPending(contextToken).catch((err) => {
          this.log(`/next error: ${String(err)}`);
        });
        return;
      }

      const restartCmd = parseRestartCommand(textContent);
      if (restartCmd) {
        this.handleRestartCommand(contextToken, restartCmd).catch((err) => {
          this.log(`Restart command error: ${String(err)}`);
        });
        return;
      }

      const historyCmd = parseHistoryCommand(textContent);
      if (historyCmd) {
        this.handleHistoryCommand(contextToken, historyCmd).catch((err) => {
          this.log(`History command error: ${String(err)}`);
        });
        return;
      }

      const notifyCmd = parseNotifyCommand(textContent);
      if (notifyCmd) {
        this.handleNotifyCommand(contextToken, notifyCmd).catch((err) => {
          this.log(`Notify command error: ${String(err)}`);
        });
        return;
      }

      const vCmd = parseVersionCommand(textContent);
      if (vCmd) {
        this.handleVersionCommand(contextToken, vCmd).catch((err) => {
          this.log(`Version command error: ${String(err)}`);
        });
        return;
      }

      // Unrecognized slash commands — send hint, then forward to agent
      const slashHint = this.detectUnknownSlashCommand(textContent);
      if (slashHint) {
        this.sendReply(contextToken, slashHint).catch(() => {});
        this.enqueueMessage(msg, contextToken).catch((err) => {
          this.log(`Failed to enqueue message: ${String(err)}`);
        });
        return;
      }
    }

    this.enqueueMessage(msg, contextToken).catch((err) => {
      this.log(`Failed to enqueue message: ${String(err)}`);
    });
  }

  /**
   * Handle the user's reply while a question is pending. Called from
   * `handleMessage` as an early-return when `sessionManager.hasPendingQuestion()`.
   *
   * Priority commands first (reject the question, then run the command):
   *   /reject-question (alias /rq) — explicit dismiss
   *   /stop                          — reject + abort the agent
   *   /next                          — reject + flush pending WeChat cache
   *   /restart                       — reject + restart the server
   *
   * Informational commands (run without rejecting; the question stays
   * pending so the user can still answer it after reading /status or
   * /help):
   *   /help, /status
   *
    * Anything else is parsed as a question answer using the Qn= / Qn-
   * grammar from `parseQuestionReply`. Slash commands we don't recognize
   * (e.g. /workspace, /agent) will fail to parse as an answer and we'll
   * tell the user to either answer normally or use /reject-question.
   */

  /**
   * Handle the user's reply while a permission is pending. Called from
   * `handleMessage` as an early-return when `sessionManager.hasPendingPermission()`.
   *
   * Priority commands first (reject all pending, then dispatch):
   *   /reject-permission (alias /rp) — dismiss all pending cards
   *
   * Informational commands (run without rejecting; permissions stay
   * pending so the user can still decide):
   *   /help, /status, /auto-permission …
   *
   * Anything else is parsed as a permission decision (1/2/3, bare
   * keywords, `P{n}=…`, `P{n}-text`) via `parsePermissionReply`.
   */
  private async handlePermissionReply(contextToken: string, text: string): Promise<void> {
    const pending = this.sessionManager?.listPendingPermissions() ?? [];
    if (pending.length === 0) return; // defensive — race could have cleared it

    const trimmed = text.trim();

    // ── Priority commands: reject all pending first ──
    if (parseRejectPermissionCommand(trimmed)) {
      this.log(`[permission] rejecting all ${pending.length} pending via /rp`);
      for (const p of pending) {
        await this.sessionManager!.rejectPendingPermission(p.requestID);
      }
      await this.sendReply(contextToken, "❌ Permission rejected.");
      return;
    }
    // /stop and /restart remain NOT priority here — both want to terminate
    // agent/server work. The agent is blocked on a tool call; sending /stop
    // without first rejecting the permission would leave the slot dangling
    // on the server side, so the user must /rp first. /next, on the other
    // hand, is purely a client-side cache flush and does NOT need to reject
    // anything; we handle it below in the informational block.

    // ── Informational commands: run without rejecting ──
    // /next, /help, /status, /ap, /compact during a pending permission are
    // all purely client-side / view-only: none of them touch the
    // server-side pending slot. The user can review cached agent output,
    // check status, or change settings and still reply 1/2/3 (or /rp to
    // dismiss) afterward.
    if (parseHelpCommand(trimmed)) {
      this.sendHelpReply(contextToken).catch(() => {});
      return;
    }
    const stCmd = parseStatusCommand(trimmed);
    if (stCmd) {
      this.handleStatusCommand(contextToken, stCmd).catch(() => {});
      return;
    }
const apCmd = parseAutoPermissionCommand(trimmed);
      if (apCmd) {
        this.handleAutoPermissionCommand(contextToken, apCmd).catch(() => {});
        return;
      }

      // /compact is informational while permissions are pending — it
      // doesn't touch the pending slots and helps the user free context
      // before answering. We allow it during the busy-with-question and
      // busy-with-permission states alike.
      const compactCmd = parseCompactCommand(trimmed);
      if (compactCmd) {
        this.handleCompactCommand(contextToken, compactCmd).catch(() => {});
        return;
      }

      // /next during a pending permission flushes the client-side cache
      // only — it does NOT reject the pending slot. The user wants to see
      // cached agent output (which may include the permission card that
      // got cached because the bridge had hit its 10-msg outbound limit),
      // and the pending slot stays intact so they can still reply 1/2/3
      // afterward.
      if (/^\/next\b/.test(trimmed)) {
        this.flushPending(contextToken).catch((err: unknown) => {
          this.log(`/next (during pending permission) error: ${String(err)}`);
        });
        return;
      }

    // ── Default: parse as permission decision ──
    const parsed = parsePermissionReply(trimmed, pending);
    for (const w of parsed.warnings) this.log(`[permission] parse warning: ${w}`);

    if (parsed.decisions.length === 0) {
      // Surface the parser's specific warning(s) so the user knows
      // exactly what's wrong. Default to the generic hint when no
      // warning was produced (rare — means the input was neither a
      // P{n}= segment nor a recognizable bare keyword).
      const hint = parsed.warnings.length > 0
        ? parsed.warnings.join(" / ")
        : pending.length === 1
          ? "Send 1 (once), 2 (always), 3 (reject), or /rp."
          : `Send 1/2/3 (applies to all ${pending.length}), P{n}=value (per-permission), or /rp.`;
      await this.sendReply(
        contextToken,
        `⚠️ Unrecognized reply. ${hint}`,
      );
      return;
    }

    for (const decision of parsed.decisions) {
      try {
        await this.sessionManager!.answerPendingPermission(
          decision.requestID,
          decision.reply,
          decision.message,
        );
      } catch (err) {
        // Server returned 4xx — most likely the permission was already
        // resolved (race with server cascade, another client, or
        // timeout firing while user was typing).
        this.log(`[permission] reply HTTP failed: ${String(err)}`);
        await this.sendReply(
          contextToken,
          "⏱ Permission 已过期（可能已被自动处理）。请重发消息。",
        );
      }
    }
    await this.sendReply(
      contextToken,
      `✅ Permission handled: ${parsed.decisions.map((d) => d.reply).join(", ")}.`,
    );
  }

  /**
   * Handle `/auto-permission` (alias `/ap`) — toggle the auto-accept
   * mode. Persists the change to `.wechat-bridge-state.json` via the
   * existing `saveUserState` (which writes the full state, including
   * autoPermissionMode).
   *
   * Subcommands: `off` / `once` / `always` / `status`.
   */
  private async handleAutoPermissionCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseAutoPermissionCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    if (cmd!.mode === "status") {
      const current = this.sessionManager.getAutoPermissionMode();
      await this.sendReply(contextToken, `🔒 Auto-permission mode: **${current}**`);
      return;
    }

    const newMode = cmd!.mode as "off" | "once" | "always";
    this.sessionManager.setAutoPermissionMode(newMode);
    if (this.userState) {
      this.userState.autoPermissionMode = newMode;
      this.saveUserState();
    }
    const desc = newMode === "off"
      ? "shown as WeChat cards (current behavior)"
      : newMode === "once"
      ? "auto-allowed (one-shot) — no card"
      : "auto-allowed permanently (server-side rules; lost on opencode restart)";
    await this.sendReply(
      contextToken,
      `🔒 Auto-permission set to **${newMode}**. Future requests: ${desc}.`,
    );
    this.log(`[permission] auto-mode set to ${newMode}`);
  }

  private async handleQuestionReply(contextToken: string, text: string): Promise<void> {
    const pending = this.sessionManager?.getPendingQuestion();
    if (!pending) return; // defensive — race could have cleared it

    const trimmed = text.trim();

    // ── Priority commands: reject first, then dispatch ──
    if (parseRejectQuestionCommand(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      await this.sendReply(contextToken, "❌ Question dismissed.");
      return;
    }
    if (parseStopCommand(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      this.handleStopCommand(contextToken, parseStopCommand(trimmed)!).catch((err: unknown) => {
        this.log(`Stop command (during pending question) error: ${String(err)}`);
      });
      return;
    }
    if (parseRestartCommand(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      this.handleRestartCommand(contextToken, parseRestartCommand(trimmed)!).catch((err: unknown) => {
        this.log(`Restart command (during pending question) error: ${String(err)}`);
      });
      return;
    }

    // ── Informational commands: run without rejecting ──
    // /next, /help, /status, /compact during a pending question are all
    // purely client-side / view-only: none of them touch the server-side
    // pending slot. The user can review cached agent output or session
    // state and still answer the question afterward. Only /stop and
    // /restart (above) want to terminate work and therefore must reject
    // the pending slot first.
    if (parseHelpCommand(trimmed)) {
      this.sendHelpReply(contextToken).catch((err: unknown) => {
        this.log(`Help command (during pending question) error: ${String(err)}`);
      });
      return;
    }
    const stCmd = parseStatusCommand(trimmed);
    if (stCmd) {
      this.handleStatusCommand(contextToken, stCmd).catch((err: unknown) => {
        this.log(`Status command (during pending question) error: ${String(err)}`);
      });
      return;
    }
    // /compact during a pending question is informational: the agent is
    // paused waiting on the user, but compact just summarizes server-side
    // history — the question slot stays intact and the user can answer
    // after compaction completes.
    const compactCmdDuringQ = parseCompactCommand(trimmed);
    if (compactCmdDuringQ) {
      this.handleCompactCommand(contextToken, compactCmdDuringQ).catch((err: unknown) => {
        this.log(`Compact command (during pending question) error: ${String(err)}`);
      });
      return;
    }
    // /next during a pending question flushes the client-side cache only —
    // it does NOT reject the pending slot. The user wants to see cached
    // agent output (which may include the question card that got cached
    // because the bridge had hit its 10-msg outbound limit), and the
    // pending slot stays intact so they can still answer afterward.
    if (/^\/next\b/.test(trimmed)) {
      this.flushPending(contextToken).catch((err: unknown) => {
        this.log(`/next (during pending question) error: ${String(err)}`);
      });
      return;
    }

    // ── Default: parse as question answer ──
    const parseResult = parseQuestionReply(trimmed, pending.questions);
    // Log warnings (out-of-range numbers, unrecognized segments, etc.)
    for (const w of parseResult.warnings) {
      this.log(`[question] parse warning: ${w}`);
    }
    // Some valid question has no answer (e.g. all numbers out of range)
    const anyEmpty = parseResult.answers.some((a) => a.length === 0);
    if (anyEmpty) {
      await this.sendReply(
        contextToken,
        "⚠️ No valid answer detected. Please reply with option numbers (e.g. \"1\") or type your own answer. Use /reject-question to dismiss.",
      );
      return;
    }
    // Show typing indicator while the agent resumes
    this.sendTypingIndicator(contextToken).catch((err: unknown) => {
      this.log(`sendTyping (during question reply) error: ${String(err)}`);
    });
    try {
      await this.sessionManager!.answerPendingQuestion(parseResult.answers);
    } catch (err) {
      // Server returned 4xx — most likely the question was already
      // answered (race) or rejected (timeout fired while user was typing)
      this.log(`[question] answer HTTP failed: ${String(err)}`);
      await this.sendReply(
        contextToken,
        "⏱ Question 已过期（可能已被其他端回答或超时）。请重发消息。",
      );
    }
  }

  // ─── Directory commands (/workspace or /ws) ───

  /**
   * Build the sorted workspace list used by `/workspace list` and the
   * index-based `/workspace switch <n>`. Always includes the current
   * workspace. Order matches the displayed numbering.
   */
  private async getSortedWorkspaces(
    currentCwd: string,
  ): Promise<Array<{ cwd: string }>> {
    if (!this.sessionManager) return [{ cwd: currentCwd }];
    // Fetch projects (they have time.updated for recency sorting)
    const projects = await this.sessionManager.listServerProjects();
    // Deduplicate by worktree, keep the most recent updatedAt
    const wsMap = new Map<string, number>();
    for (const p of projects) {
      const existing = wsMap.get(p.worktree) ?? 0;
      if (p.updatedAt > existing) wsMap.set(p.worktree, p.updatedAt);
    }
    // Always include current workspace
    if (!wsMap.has(currentCwd)) {
      wsMap.set(currentCwd, 0);
    }
    // Sort by recency descending, then by path for ties
    return [...wsMap.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cwd]) => ({ cwd }));
  }

  private async handleDirectoryCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseWorkspaceCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const currentCwd = this.userState?.cwd ?? this.config.agent.cwd;
        const workspaces = await this.getSortedWorkspaces(currentCwd);
        // Cap at WORKSPACE_LIST_MAX so the WeChat reply stays a manageable
        // size and renders in a single bubble. `formatWorkspaceList` adds a
        // truncation hint + /workspace switch reminder when the input
        // exceeds the cap, so the user can still reach anything beyond it.
        await this.sendReply(
          contextToken,
          formatWorkspaceList(workspaces, currentCwd, WORKSPACE_LIST_MAX),
        );
        break;
      }

      case "status": {
        const cwd = this.userState?.cwd ?? this.config.agent.cwd;
        await this.sendReply(contextToken, `📂 ${cwd}`);
        break;
      }

      case "switch": {
        if (!cmd!.name) {
          await this.sendReply(contextToken, "Usage: /workspace switch <path>");
          return;
        }
        const currentCwd = this.userState?.cwd ?? this.config.agent.cwd;
        const target = cmd!.name;

        // Resolve numeric index against the same sorted list that /workspace
        // list shows, so `/workspace switch 5` matches the 5th entry.
        const idx = parseInt(target, 10);
        let targetDir: string;
        if (/^\d+$/.test(target) && !isNaN(idx)) {
          const workspaces = await this.getSortedWorkspaces(currentCwd);
          if (idx < 1 || idx > workspaces.length) {
            await this.sendReply(
              contextToken,
              `❌ Index out of range: ${idx} (1..${workspaces.length})`,
            );
            return;
          }
          targetDir = workspaces[idx - 1]!.cwd;
        } else {
          targetDir = target;
        }

        const state = this.userState;
        if (state && state.cwd === targetDir) {
          await this.sendReply(contextToken, `Already on ${targetDir}`);
          return;
        }
        if (!fs.existsSync(targetDir)) {
          await this.sendReply(contextToken, `❌ Directory does not exist: ${targetDir}`);
          return;
        }
        await this.sendReply(contextToken, `🔄 Switching to\n  ${targetDir}`);
        try {
          await this.sessionManager.switchWorkspace(targetDir, undefined);
          this.setUserState(this.sessionManager.getSessionId() ?? "", targetDir);
          // Sync notifier's "current" pointer to the freshly-resumed
          // session. Without this, the notifier would still consider
          // the OLD session current and could double-notify events
          // for the new one.
          this.notifier?.setCurrentSessionId(this.sessionManager.getSessionId());
          await this.sendReply(contextToken, `✅ Ready on\n  ${targetDir}`);
        } catch (err) {
          await this.sendReply(contextToken, `❌ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "add": {
        const targetPath = cmd!.path!;
        const state = this.userState;
        if (state && state.cwd === targetPath) {
          await this.sendReply(contextToken, `Already on ${targetPath}`);
          return;
        }
        try {
          fs.mkdirSync(targetPath, { recursive: true });
        } catch (err) {
          await this.sendReply(contextToken, `Failed to create directory: ${String(err)}`);
          return;
        }
        await this.sendReply(contextToken, `🔄 Switching to\n  ${targetPath}`);
        try {
          await this.sessionManager.switchWorkspace(targetPath, undefined);
          this.setUserState(this.sessionManager.getSessionId() ?? "", targetPath);
          await this.sendReply(contextToken, `✅ Ready on\n  ${targetPath}`);
        } catch (err) {
          await this.sendReply(contextToken, `❌ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "remove": {
        await this.sendReply(contextToken, "Use /workspace switch to change directories.");
        break;
      }
    }
  }

  // ─── Session commands (/session or /s) ───

  private async handleSessionCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseSessionCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        try {
          const allSessions = await this.sessionManager.listServerSessions();
          // Apply cwd filter if specified
          let sessions = allSessions;
          if (cmd!.cwdFilter) {
            const filterCwd = cmd!.cwdFilter === "__current__"
              ? (this.userState?.cwd ?? this.config.agent.cwd)
              : cmd!.cwdFilter;
            sessions = allSessions.filter((s) => s.cwd === filterCwd);
          }
          // Stash the resolved filter so the next /session switch <n> uses
          // the same index space the user just saw. Set to the *resolved*
          // cwd (or undefined for unfiltered) so the switch handler doesn't
          // need to re-resolve "__current__".
          this.lastSessionListFilter = cmd!.cwdFilter
            ? cmd!.cwdFilter === "__current__"
              ? (this.userState?.cwd ?? this.config.agent.cwd)
              : cmd!.cwdFilter
            : undefined;
          const lines: string[] = [cmd!.cwdFilter ? `💬 Sessions in current workspace:` : "💬 Recent Sessions:"];
          const count = Math.min(sessions.length, 20);
          for (let i = 0; i < count; i++) {
            const s = sessions[i];
            const cwdSuffix = s.cwd ? `  📂 ${s.cwd}` : "";
            lines.push(`  ${i + 1}. ${s.title ?? "(untitled)"}${cwdSuffix}`);
          }
          if (count === 0) {
            lines.push("  (no sessions)");
          }
          lines.push("");
          lines.push("💡 使用 /session switch <编号> 切换会话");
          await this.sendReply(contextToken, lines.join("\n"));
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Failed to list sessions: ${String(err)}`);
        }
        break;
      }

      case "switch": {
        const idx = parseInt(cmd!.name!, 10);
        try {
          const allSessions = await this.sessionManager.listServerSessions();
          // Apply the same filter as the most recent /session list so the
          // number the user sees matches the number they type. Without this,
          // /session list current followed by /session switch 1 silently
          // hits session 1 of the *unfiltered* list (which can live in a
          // different workspace) instead of session 1 of the filtered list
          // the user just looked at.
          const sessions = this.lastSessionListFilter
            ? allSessions.filter((s) => s.cwd === this.lastSessionListFilter)
            : allSessions;
          if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
            const target = sessions[idx - 1];
            const newCwd = target.cwd ?? this.userState?.cwd ?? this.config.agent.cwd;
            await this.sendReply(contextToken, `🔄 Switching to "${target.title ?? "(untitled)"}"`);
            await this.sessionManager.switchSession(target.sessionId, newCwd);
            this.setUserState(target.sessionId, newCwd);
            // Sync notifier's "current" pointer — see the
            // /workspace switch handler above for the same
            // rationale. Crucial when the user had the
            // cross-session notify feature enabled.
            this.notifier?.setCurrentSessionId(target.sessionId);
            await this.sendReply(contextToken, `✅ Ready on ${newCwd}`);
            // If the target session had a pending question / permission
            // (seen earlier by the notifier), re-render the card so the
            // user can answer it now that they're on the right session.
            // The consume semantics in the notifier ensure we don't loop
            // on a stale card on subsequent switches back.
            await this.maybeReSurfacePending(target.sessionId, contextToken);
          } else {
            const hint = this.lastSessionListFilter
              ? ` (filter: ${this.lastSessionListFilter})`
              : "";
            await this.sendReply(
              contextToken,
              `Session "${cmd!.name}" not found in ${sessions.length} sessions${hint}. Use /session list to refresh.`,
            );
          }
        } catch (err) {
          await this.sendReply(contextToken, `❌ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const sid = this.sessionManager.getSessionId();
        if (sid) {
          await this.sendReply(contextToken, `💬 Session: ${sid}`);
        } else {
          const cwd = this.userState?.cwd ?? this.config.agent.cwd;
          await this.sendReply(contextToken, `📂 ${cwd}`);
        }
        break;
      }

      case "new": {
        const cwd = this.userState?.cwd ?? this.config.agent.cwd;
        try {
          await this.sessionManager.createNewSession(cwd);
          // Show what carried over so the user can confirm inheritance at a
          // glance. /status will reflect the same values; this message just
          // makes the transition explicit.
          const agent = this.sessionManager.getActiveMode() ?? "(default)";
          const model = this.sessionManager.getCurrentModel() ?? "(default)";
          const reasoning = this.sessionManager.getCurrentReasoningDisplay();
          await this.sendReply(
            contextToken,
            [
              "✅ Session restarted. Context cleared.",
              `🤖 Agent: ${agent}`,
              `📱 Model: ${model}`,
              `🧠 Reasoning: ${reasoning}`,
            ].join("\n"),
          );
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Failed: ${String(err)}`);
        }
        break;
      }

      case "remove": {
        await this.sendReply(contextToken, "Sessions are managed by OpenCode.");
        break;
      }
    }
  }

  /**
   * After a successful `/session switch <n>`, check whether the
   * target session had a pending question / permission (seen by the
   * notifier earlier) and re-render the card so the user can answer
   * it on the new session. The notifier's `consumePendingForSession`
   * returns the entry AND removes it from its map, so we never
   * re-surface the same card on a subsequent switch back.
   *
   * The synthetic slot adopted on the SessionManager lets the
   * existing answer / reject / 30-min-timeout flow take over
   * unchanged — no special-casing in the reply grammar.
   */
  private async maybeReSurfacePending(sessionId: string, contextToken: string): Promise<void> {
    if (!this.sessionManager || !this.notifier) return;
    const pending = this.notifier.consumePendingForSession(sessionId);
    if (!pending) return;
    // Point the SessionManager at the current WeChat chat so the
    // adopted card and its reply route to the right place. (Without
    // this, `lastEnqueuedContextToken` would still point at the OLD
    // session's chat, and the reply would either get lost or go to
    // the wrong user.)
    this.sessionManager.setLastEnqueuedContextToken(contextToken);
    try {
      if (pending.kind === "question" && pending.question) {
        this.sessionManager.adoptPendingQuestion(
          pending.requestID,
          [pending.question],
          contextToken,
        );
        const card = formatQuestionForWeChat([pending.question]);
        await this.sendReply(contextToken, `🔔 切到这个会话时有 question 在等着：\n\n${card}`);
      } else if (pending.kind === "permission" && pending.permission) {
        this.sessionManager.adoptPendingPermission(
          pending.requestID,
          pending.permission,
          contextToken,
        );
        const card = formatPermissionCard(pending.permission);
        await this.sendReply(contextToken, `🔔 切到这个会话时有 permission 在等着：\n\n${card}`);
      }
    } catch (err) {
      this.log(`[session] re-surface pending failed: ${String(err)}`);
    }
  }

  // ─── Agent commands (/agent or /a) ───

  private async handleAgentCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseAgentCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        // Ensure agents are fetched (they load on session creation, but may still be in-flight)
        if (this.sessionManager.getAvailableModes().length === 0) {
          // Try refreshing once
          try {
            await this.sessionManager.refreshAgents();
          } catch { /* ignore */ }
        }
        const currentMode = this.sessionManager.getActiveMode();
        const availableModes = this.sessionManager.getAvailableModes();
        const lines = ["🤖 Agent (mode):"];
        if (availableModes.length > 0) {
          for (let i = 0; i < availableModes.length; i++) {
            const m = availableModes[i];
            const marker = m.id === currentMode ? " ✅" : "";
            // Show each agent's per-agent model/variant so users can see at
            // a glance which model and reasoning level switching to it
            // will adopt. Empty fields render as "(default)".
            const modelPart = m.model ? `${m.model.providerID}/${m.model.modelID}` : "(default)";
            const variantPart = m.variant ?? "(default)";
            lines.push(`  ${i + 1}. ${m.name}${marker} — ${modelPart} / ${variantPart}`);
          }
        } else {
          lines.push("  (no available modes)");
        }
        lines.push("");
        lines.push("💡 Use /agent switch <name|n> to switch");
        await this.sendReply(contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        const input = cmd!.name!.trim();
        const availableModes = this.sessionManager.getAvailableModes();
        const index = parseInt(input, 10);
        let targetMode: string;

        if (!isNaN(index) && index >= 1 && index <= availableModes.length) {
          targetMode = availableModes[index - 1].id;
        } else {
          const match = availableModes.find(
            (m) => m.name.toLowerCase() === input.toLowerCase() || m.id.toLowerCase() === input.toLowerCase(),
          );
          if (!match) {
            await this.sendReply(contextToken, `⚠️ "${input}" not found`);
            return;
          }
          targetMode = match.id;
        }

        try {
          const result = await this.sessionManager.switchAgent(targetMode);
          // switchAgent may also adopt the agent's per-agent model/variant.
          // Surface that so the user knows what just happened to /status.
          const lines = [`✅ Agent switched to ${result.modeId}`];
          if (result.note) lines.push(`ℹ️ ${result.note}`);
          await this.sendReply(contextToken, lines.join("\n"));
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const mode = this.sessionManager.getActiveMode();
        await this.sendReply(contextToken, `🤖 Current Agent: ${mode ?? "(not set)"}`);
        break;
      }
    }
  }

  // ─── Model commands (/model) ───

  private async handleModelCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseModelCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        // Ensure models are fetched
        if (this.sessionManager.getAvailableModels().length === 0) {
          try {
            await this.sessionManager.refreshProviders();
          } catch { /* ignore */ }
        }
        const currentModelId = this.sessionManager.getCurrentModel();
        const allModels = this.sessionManager.getAvailableModels();

        // If a provider filter is given, show models under that provider
        if (cmd!.provider) {
          const filter = cmd!.provider.toLowerCase();
          const filtered = allModels.filter((m) => m.modelId.toLowerCase().startsWith(`${filter}/`));
          const lines = [`📱 Models — ${cmd!.provider}:`];
          if (filtered.length === 0) {
            lines.push("  (no models found)");
          } else {
            for (const m of filtered) {
              const modelName = m.modelId.split("/").slice(1).join("/") || m.name;
              const marker = m.modelId === currentModelId ? " ◀" : "";
              lines.push(`  ${modelName}${marker}`);
            }
          }
          lines.push("");
          lines.push("💡 使用 /model switch <provider/model> 切换模型");
          await this.sendReply(contextToken, lines.join("\n"));
          break;
        }

        const lines = ["📱 Models:"];

        // Group by provider
        const byProvider = new Map<string, Array<{ modelId: string; name: string }>>();
        for (const m of allModels) {
          const provider = m.modelId.split("/")[0];
          if (!byProvider.has(provider)) byProvider.set(provider, []);
          byProvider.get(provider)!.push(m);
        }

        if (byProvider.size === 0) {
          lines.push(`  Current: ${currentModelId ?? "(not set)"}`);
        } else {
          for (const [provider, models] of byProvider) {
            const marker = currentModelId?.startsWith(`${provider}/`) ? " ✅" : "";
            lines.push(`  ${provider} (${models.length})${marker}`);
          }
          lines.push("");
          lines.push("💡 使用 /model list <provider> 查看模型列表");
          lines.push("   使用 /model switch <provider/model> 切换模型");
        }
        await this.sendReply(contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        const input = cmd!.name!.trim();
        if (!input.includes("/")) {
          await this.sendReply(contextToken, `⚠️ Use full model name (provider/model), e.g. anthropic/claude-sonnet-4-5`);
          return;
        }
        try {
          const result = await this.sessionManager.setModel(input);
          // setModel may have cleared or reset the reasoning variant because
          // the previous one isn't valid on the new model. Surface that to
          // the user so they know what just happened to /status.
          const lines = [`✅ Model switched to ${result.modelId}`];
          if (result.note) lines.push(`ℹ️ ${result.note}`);
          await this.sendReply(contextToken, lines.join("\n"));
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const model = this.sessionManager.getCurrentModel();
        await this.sendReply(contextToken, `📱 Current Model: ${model ?? "(not set)"}`);
        break;
      }
    }
  }

  // ─── Reasoning commands (/reasoning) ───

  private async handleReasoningCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseReasoningCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const levels = this.sessionManager.getReasoningLevels();
        const lines = ["🧠 Reasoning levels:"];
        if (levels.length > 0) {
          for (const lv of levels) {
            const marker = lv.current ? " ✅" : "";
            lines.push(`  ${lv.value}${marker} — ${lv.name}`);
          }
        } else {
          lines.push("  (not available)");
        }
        lines.push("");
        lines.push("💡 Use /reasoning switch <level>");
        await this.sendReply(contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        try {
          await this.sessionManager.setReasoning(cmd!.name!.toLowerCase());
          const raw = this.sessionManager.getCurrentReasoning();
          if (!raw) {
            // Either the user picked "default" or setReasoning cleared the
            // value because the requested level isn't valid. Either way,
            // the next prompt will go out without a `variant` field.
            const requested = cmd!.name!.toLowerCase();
            if (requested === "default") {
              await this.sendReply(contextToken, `✅ Reasoning reset to server default (no variant will be sent)`);
            } else {
              await this.sendReply(contextToken, `✅ Reasoning cleared (will use server default)`);
            }
          } else {
            const display = this.sessionManager.getCurrentReasoningDisplay();
            const confirm = raw.toLowerCase() !== display.toLowerCase()
              ? `✅ Reasoning set to ${display} (${raw})`
              : `✅ Reasoning set to ${display}`;
            await this.sendReply(contextToken, confirm);
          }
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const display = this.sessionManager.getCurrentReasoningDisplay();
        const raw = this.sessionManager.getCurrentReasoning();
        // When the displayed name differs from the raw key (e.g. numeric key
        // "1" → "Low"), append the raw value so the user knows the variant id.
        const line = raw && raw.toLowerCase() !== display.toLowerCase()
          ? `🧠 Reasoning: ${display} (${raw})`
          : `🧠 Reasoning: ${display}`;
        await this.sendReply(contextToken, line);
        break;
      }
    }
  }

  // ─── Status command (/status) ───

  private async handleStatusCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseStatusCommand>,
  ): Promise<void> {
    // Capture to a local so the narrowing from the early-return survives
    // into the async closure passed to runWithSlowWarn. Without this TS
    // can't prove `this.sessionManager` is non-null inside the callback
    // (class-field narrowing doesn't propagate through async boundaries).
    const sessionManager = this.sessionManager;
    if (!sessionManager) return;

    await this.runWithSlowWarn(contextToken, "状态", async () => {
      const cwd = this.userState?.cwd ?? this.config.agent.cwd;

      // Lazy-refresh agents/models if caches are empty
      if (sessionManager.getAvailableModes().length === 0) {
        try { await sessionManager.refreshAgents(); } catch { /* ignore */ }
      }
      if (sessionManager.getAvailableModels().length === 0) {
        try { await sessionManager.refreshProviders(); } catch { /* ignore */ }
      }

      const currentMode = sessionManager.getActiveMode();
      const currentModel = sessionManager.getCurrentModel() ?? "(not set)";
      // `getCurrentReasoningDisplay` already returns "Default" (matching
      // the synthetic entry in /reasoning list and OpenCode TUI's
      // dialog-variant.tsx) when `currentReasoning === undefined`, so
      // no client-side fallback is needed here — the previous
      // "first level's name" fallback that this block used to carry
      // would have produced a DIFFERENT string than the synthetic
      // "Default" entry and silently disagreed with `/reasoning list`.
      const currentReasoning = sessionManager.getCurrentReasoningDisplay();
      const contextUsage = sessionManager.getContextUsage();
      const sid = sessionManager.getSessionId();

      const sessionTitle = sid ? await sessionManager.getSessionTitle(sid).catch(() => undefined) : undefined;
      const sessionInfo = sid ? { id: sid, cwd, title: sessionTitle } : null;

      // Fetch MCP status. Failures are swallowed (the network call goes to
      // the local opencode server) and the section is omitted in that case.
      let mcpStatus: Record<string, import("./types.js").McpServerStatus> | null = null;
      try {
        mcpStatus = await sessionManager.getMcpStatus();
      } catch {
        // Server doesn't expose /mcp, or call failed — just skip the section.
      }

      // Current session's agent status (REST-driven, async). Pulls a fresh
      // snapshot from `GET /session/status` so `/status` shows the server's
      // truth — not the SSE event cache, which is stale when switching
      // into a session that was already running before the bridge
      // observed it. Falls back to the SSE cache on network error; see
      // `SessionManager.getAgentStatus()` for details.
      const agentStatus = await sessionManager.getAgentStatus();

      // Count of OTHER busy root sessions on the OpenCode Server. Failure
      // here must NOT break /status — wrap in its own try/catch so a
      // network blip just renders `(unknown)` on the new line.
      let otherBusySessions: number | null = null;
      try {
        otherBusySessions = await sessionManager.getOtherRunningSessionCount();
      } catch {
        otherBusySessions = null;
      }

      // VCS (git branch) info for the current workspace, fetched from the
      // OpenCode Server via `GET /vcs?directory=<cwd>`. Failure (network
      // or non-2xx) is swallowed and the Branch line is omitted from the
      // output. `null` vcs (server returned 200 with null fields for a
      // non-git directory) renders as `(not a git repo)` — see
      // `formatStatus` for the contract. Scoped to `cwd` (the latest
      // workspace, post-`/workspace switch`) so a workspace change is
      // reflected immediately, matching the rest of /status.
      let vcs: VcsInfo | null | undefined;
      try {
        vcs = await sessionManager.getOpenCodeClient().getVcsInfo(cwd);
      } catch (err) {
        this.log(`[status] /vcs fetch failed (ignored): ${String(err)}`);
        vcs = undefined;
      }

      let statusText = formatStatus({
        session: sessionInfo,
        workspace: cwd,
        agent: currentMode ?? "(not set)",
        model: currentModel,
        reasoning: currentReasoning,
        contextUsage: contextUsage ? { used: contextUsage.totalTokens, size: contextUsage.contextSize } : null,
        mcpStatus,
        agentStatus,
        otherBusySessions,
        notifySettings: this.notifier?.getSettings() ?? null,
        immersiveMode: this.sessionManager?.getImmersiveMode() ?? null,
        vcs,
      });

      // Append a "⏳ Question pending" line if a question is waiting. We
      // mutate the returned string here (rather than inside formatStatus)
      // to keep the formatter a pure function. Showing elapsed seconds
      // helps the user decide whether to /reject-question and let the
      // agent proceed.
      if (sessionManager.hasPendingQuestion()) {
        const pending = sessionManager.getPendingQuestion();
        if (pending) {
          const elapsedSec = Math.max(0, Math.floor((Date.now() - pending.askedAt) / 1000));
          const qLabel = `Q${pending.questions.length} question${pending.questions.length > 1 ? "s" : ""}`;
          const idShort = pending.requestID.slice(0, 12);
          statusText += `\n⏳ Question pending (${qLabel}, ${elapsedSec}s elapsed, id=${idShort}…)`;
        }
      }

      // Append a "⏳ Permission pending" line if any permission cards are
      // waiting. Same rationale as the question line above.
      const permPending = sessionManager.listPendingPermissions();
      if (permPending.length > 0) {
        const permSummary = formatPermissionSummary(permPending);
        if (permSummary) statusText += `\n${permSummary}`;
      }

      // Append the auto-permission mode line. Always show it so users
      // can confirm their current preference at a glance. The command
      // hint points to /auto-permission for changing it.
      const autoMode = sessionManager.getAutoPermissionMode();
      statusText += `\n🔒 Auto-permission: ${autoMode}   (use /auto-permission [off|once|always|status] to change)`;

      await this.sendReply(contextToken, statusText);
    });
  }

  // ─── Thought display command (/thought-display) ───

  private async handleThoughtDisplayCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseThoughtDisplayCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "status": {
        const flags = this.sessionManager.getShowFlags();
        await this.sendReply(
          contextToken,
          flags.showThoughts ? "🧠 Thought display: ✅ On" : "🧠 Thought display: ❌ Off",
        );
        break;
      }

      case "on": {
        // Only mutate showThoughts; pass undefined for showTools so it isn't clobbered.
        this.sessionManager.setShowFlags({ showThoughts: true, showTools: undefined });
        if (this.userState) this.userState.showThoughts = true;
        this.saveUserState();
        await this.sendReply(contextToken, "✅ Thought display on");
        break;
      }

      case "off": {
        this.sessionManager.setShowFlags({ showThoughts: false, showTools: undefined });
        if (this.userState) this.userState.showThoughts = false;
        this.saveUserState();
        await this.sendReply(contextToken, "❌ Thought display off");
        break;
      }
    }
  }

  // ─── Tool display command (/tool-display) ───

  private async handleToolDisplayCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseToolDisplayCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "status": {
        const flags = this.sessionManager.getShowFlags();
        await this.sendReply(
          contextToken,
          flags.showTools ? "🔧 Tool display: ✅ On" : "🔧 Tool display: ❌ Off",
        );
        break;
      }

      case "on": {
        // Only mutate showTools; pass undefined for showThoughts so it isn't clobbered.
        this.sessionManager.setShowFlags({ showThoughts: undefined, showTools: true });
        if (this.userState) this.userState.showTools = true;
        this.saveUserState();
        await this.sendReply(contextToken, "✅ Tool display on");
        break;
      }

      case "off": {
        this.sessionManager.setShowFlags({ showThoughts: undefined, showTools: false });
        if (this.userState) this.userState.showTools = false;
        this.saveUserState();
        await this.sendReply(contextToken, "❌ Tool display off");
        break;
      }
    }
  }

  // ─── Silent mode command (/silent) ───

  private async handleSilentCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseSilentCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "status": {
        const on = this.sessionManager.getImmersiveMode();
        await this.sendReply(
          contextToken,
          `🤫 静默模式: ${on ? "✅ On" : "❌ Off"}\n   /silent on|off|status   开关（默认 Off）\n   /sl on|off|status       简写`,
        );
        break;
      }

      case "on": {
        this.sessionManager.setImmersiveMode(true);
        if (this.userState) this.userState.immersiveMode = true;
        this.saveUserState();
        await this.sendReply(contextToken, "🤫 静默模式已开启 — 下一轮起将仅在完成时显示最后一条回复");
        break;
      }

      case "off": {
        this.sessionManager.setImmersiveMode(false);
        if (this.userState) this.userState.immersiveMode = false;
        this.saveUserState();
        await this.sendReply(contextToken, "🤫 静默模式已关闭 — 恢复实时显示思考/工具/增量文本");
        break;
      }
    }
  }

  // ─── Stop command (/stop) ───

  private async handleStopCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseStopCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    try {
      await this.sessionManager.cancelPrompt();
      await this.sendReply(contextToken, "🛑 Stop signal sent");
    } catch (err) {
      this.log(`Cancel error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ Stop failed: ${String(err)}`);
    }
  }

  // ─── Compact command (/compact, /summarize) ───

  /**
   * Force-trigger OpenCode Server's context compaction via
   * `POST /session/:id/summarize`. Uses the session's current model so
   * the compaction LLM call matches the user's chosen provider/model.
   * Rejects while the agent is mid-turn to avoid racing the SSE-driven
   * token bookkeeping, and allows compaction during a paused state
   * (e.g. while a question is pending) since the summary doesn't
   * disturb those slots.
   */
  private async handleCompactCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseCompactCommand>,
  ): Promise<void> {
    if (!this.sessionManager) {
      await this.sendReply(contextToken, "⚠️ Session manager not ready");
      return;
    }

    // Refuse while the agent is mid-turn — compacting during an active
    // response would race with `message.updated` events that update
    // `totalTokens`. The user can /stop first then /compact.
    if (this.sessionManager.isAgentBusy()) {
      await this.sendReply(
        contextToken,
        "⚠️ Agent 正在运行，请先 /stop 再 /compact",
      );
      return;
    }

    const sessionId = this.sessionManager.getSessionId();
    if (!sessionId) {
      await this.sendReply(contextToken, "⚠️ 当前没有活动会话，无法 compact");
      return;
    }

    const currentModel = this.sessionManager.getCurrentModel();
    if (!currentModel) {
      await this.sendReply(
        contextToken,
        "⚠️ 无法确定当前 model，请先 /model switch 设置后重试",
      );
      return;
    }

    const slash = currentModel.indexOf("/");
    if (slash <= 0) {
      await this.sendReply(
        contextToken,
        `⚠️ 当前 model 格式异常: "${currentModel}"`,
      );
      return;
    }
    const providerID = currentModel.slice(0, slash);
    const modelID = currentModel.slice(slash + 1);

    const beforeUsage = this.sessionManager.getContextUsage();
    const beforeTokens = beforeUsage?.totalTokens ?? 0;
    const beforeSize = beforeUsage?.contextSize ?? 0;

    await this.sendReply(contextToken, "🗜️ 开始压缩会话上下文...");
    try {
      const ok = await this.sessionManager.compactSession(providerID, modelID);
      if (!ok) {
        await this.sendReply(
          contextToken,
          "⚠️ Server 返回 false — compact 未生效（可能当前 context 已足够小，或 server 拒绝执行）",
        );
        return;
      }
      const beforeLine = beforeSize > 0
        ? `  before: ${beforeTokens} / ${beforeSize}`
        : `  before: ${beforeTokens} tokens`;
      await this.sendReply(
        contextToken,
        `✅ Compact 完成\n${beforeLine}\n  发送 /status 查看压缩后的用量`,
      );
    } catch (err) {
      this.log(`Compact error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ Compact failed: ${String(err)}`);
    }
  }

  // ─── History command (/history, /hist) ───

  /**
   * Handle the `/history` (alias `/hist`) command — show the most recent
   * N messages from the CURRENT session in chronological order. The
   * bridge never persisted a chat log, so this is a live read of the
   * OpenCode Server's session history via `GET /session/:id/message?limit=N`.
   *
   * Unlike `/compact` this command does NOT block on `isAgentBusy()` —
   * it's a pure read of past messages, safe to run mid-turn. The
   * server returns messages newest-first; we reverse to chronological
   * order for display.
   *
   * Only text parts are surfaced; tool/reasoning/file/step-* parts are
   * intentionally skipped (the user wants a chat log, not a transcript).
   */
  private async handleHistoryCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseHistoryCommand>,
  ): Promise<void> {
    if (!this.sessionManager) {
      await this.sendReply(contextToken, "⚠️ Session manager not ready");
      return;
    }
    if (!cmd) {
      // Defensive — dispatcher guards this, but the type allows null.
      await this.sendReply(contextToken, "⚠️ /history 参数无效");
      return;
    }

    // Send a quick typing hint so the user knows the bot received the
    // command. The HTTP fetch is usually <100ms but the iLink typing
    // indicator renders within a second, masking the round trip.
    await this.sendTypingIndicator(contextToken);

    const sessionId = this.sessionManager.getSessionId();
    const client = this.sessionManager.getOpenCodeClient();
    try {
      const text = await fetchAndFormatHistory({
        sessionId,
        count: cmd.count,
        cwd: this.userState?.cwd ?? this.config.agent.cwd,
        fetch: (sid, count) => client.getSessionMessages(sid, count),
        // Title is best-effort: a missing session (404) or a network blip
        // just omits the 会话「…」 header piece instead of failing the
        // whole `/history` command. fetchAndFormatHistory swallows the
        // error from this closure on its own; we still wrap the outer
        // call in the try/catch below for the messages-fetch path.
        getSessionTitle: async (sid) => {
          const info = await client.getSession(sid);
          return info.title;
        },
      });
      await this.sendReply(contextToken, text);
    } catch (err) {
      this.log(`History error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ 拉取历史失败: ${String(err)}`);
    }
  }

  // ─── Notify command (/notify) ───

  /**
   * Handle the `/notify` command — configure the cross-session
   * notification feature. Mirrors the persistence pattern of
   * `/auto-permission` (master setting + sub-toggles stored on
   * `userState`, applied to the notifier in real time, persisted
   * to `.wechat-bridge-state.json` for restart).
   *
   * Subcommands (parsed by `parseNotifyCommand`):
   *   - `on` / `off`  — master switch
   *   - `status`      — print current settings
   *   - `types <t> on|off` — per-event-type toggle (`t` ∈ question|permission|error|completion)
   */
  private async handleNotifyCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseNotifyCommand>,
  ): Promise<void> {
    if (!this.notifier) {
      await this.sendReply(contextToken, "⚠️ Notify 模块未初始化");
      return;
    }

    // Lazy-init userState if absent (covers the rare case where the
    // user runs /notify before sending any non-slash message). Mirrors
    // the pattern in `handleMessage` that creates the bare userState
    // on first user message.
    if (!this.userState) {
      this.userState = { userId: "", sessionId: "", cwd: this.config.agent.cwd };
    }

    switch (cmd!.mode) {
      case "status": {
        const s = this.notifier.getSettings();
        await this.sendReply(contextToken, formatNotifyStatus(s.enabled, s.types));
        return;
      }
      case "on": {
        const newVal = this.notifier.setEnabled(true);
        this.userState.notify = this.notifier.getSettings();
        this.saveUserState();
        await this.sendReply(
          contextToken,
          newVal
            ? "✅ Cross-session notify: on"
            : "⚠️ Cross-session notify 已是开启状态",
        );
        return;
      }
      case "off": {
        const newVal = this.notifier.setEnabled(false);
        this.userState.notify = this.notifier.getSettings();
        this.saveUserState();
        await this.sendReply(
          contextToken,
          !newVal
            ? "❌ Cross-session notify: off"
            : "⚠️ Cross-session notify 已是关闭状态",
        );
        return;
      }
    }

    // If we reach here, the command was `types <t> on|off`.
    if (!cmd!.type) {
      await this.sendReply(contextToken, "⚠️ /notify types 需要 <type> on|off");
      return;
    }
    const newVal = this.notifier.setTypeEnabled(cmd!.type, cmd!.mode === "on");
    this.userState.notify = this.notifier.getSettings();
    this.saveUserState();
    const typeLabelMap: Record<string, string> = {
      question: "Question 通知",
      permission: "Permission 通知",
      error: "Error 通知",
      completion: "Completion 通知",
    };
    await this.sendReply(
      contextToken,
      newVal
        ? `✅ ${typeLabelMap[cmd!.type]}: on`
        : `❌ ${typeLabelMap[cmd!.type]}: off`,
    );
  }

  // ─── Restart command (/restart) ───

  private async handleRestartCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseRestartCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    const cwd = this.userState?.cwd ?? this.config.agent.cwd;
    // Capture BEFORE any destructive operation — once we cancel/stop/restart
    // the original sessionId is still valid (server storage persists it),
    // and we want to re-attach to it.
    const previousSessionId = this.userState?.sessionId ?? this.sessionManager.getSessionId();

    // External-server mode (--server-url was used) — we don't own the
    // server process, so we can only re-attach to the existing session.
    if (!this.restartServer) {
      await this.sendReply(contextToken, "⚠️ 当前为外部 server 模式，无法重启 server；尝试恢复之前的会话");
      await this.restoreOrCreateSession(previousSessionId, cwd);
      return;
    }

    // We own the server — do a full restart: kill server, spawn new one,
    // wait for ready, then restore the previous session and resume SSE.
    await this.sendReply(contextToken, "🔄 重启 OpenCode Server...");
    try {
      // 1. Cancel any in-flight prompt (best-effort — server may be unresponsive soon)
      await this.sessionManager.cancelPrompt().catch((err) => {
        this.log(`Cancel prompt during restart (ignored): ${String(err)}`);
      });

      // 2. Tear down the SSE event pipeline (the old SSE connection is dead)
      await this.sessionManager.stopEventPipeline();

      // 3. Restart the server (CLI does stop + start + wait-for-health)
      const t0 = Date.now();
      await this.restartServer!();
      this.log(`Server restart took ${Date.now() - t0}ms`);

      // 4. Restore the previous session on the fresh server
      const restoredId = await this.restoreOrCreateSession(previousSessionId, cwd);

      // 5. Re-establish the SSE pipeline against the new server
      await this.sessionManager.startEventPipeline(cwd);

      const tag = restoredId === previousSessionId ? "已恢复" : "旧会话不存在，已创建新会话";
      await this.sendReply(contextToken, `✅ Server 已重启，会话${tag}\n  ${restoredId}`);
    } catch (err) {
      this.log(`Restart error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ 重启失败: ${String(err)}`);
    }
  }

  /**
   * Try to re-attach to `previousSessionId` on the current server. If the
   * session no longer exists (e.g. server data dir was wiped between
   * restarts), create a fresh one. Updates `userState.sessionId` and
   * reports back the resulting session id.
   */
  private async restoreOrCreateSession(
    previousSessionId: string | null,
    cwd: string,
  ): Promise<string> {
    if (!this.sessionManager) throw new Error("No session manager");

    let sessionId: string;
    if (previousSessionId) {
      try {
        await this.sessionManager.switchSession(previousSessionId, cwd);
        sessionId = previousSessionId;
        this.log(`Restored session ${previousSessionId}`);
      } catch (err) {
        this.log(`Previous session ${previousSessionId} not found, creating new: ${String(err)}`);
        sessionId = await this.sessionManager.createNewSession(cwd);
      }
    } else {
      sessionId = await this.sessionManager.createNewSession(cwd);
    }

    if (this.userState) this.userState.sessionId = sessionId;
    return sessionId;
  }

  // ─── Version command (/version) ───

  private async handleVersionCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseVersionCommand>,
  ): Promise<void> {
    const lines: string[] = ["📦 Versions:"];

    // Bridge version (always available — read from package.json at module load)
    lines.push(`  🌉 Bridge: v${BRIDGE_VERSION}`);

    // OpenCode Server version (from /global/health — doesn't require a session)
    const serverVersion = this.sessionManager
      ? await this.sessionManager.getServerVersion()
      : null;
    if (serverVersion) {
      lines.push(`  🖥️  Server: v${serverVersion}`);
    } else {
      lines.push(`  🖥️  Server: (unreachable at ${this.config.server.url})`);
    }

    // Latest version from the npm registry (best-effort — never fail the
    // command if the registry is unreachable).
    const pkgName = resolveOpencodePackageName(
      this.config.server.command ?? "npx",
      this.config.server.args ?? [],
    );
    const latestVersion = await this.getLatestNpmVersion(pkgName);
    if (latestVersion) {
      lines.push(`  📡 Latest: v${latestVersion}  (${pkgName})`);
      // Update hint: in sidecar mode (we own the server) `/restart` picks up
      // the latest package on next launch (npx fetches fresh on every invoke;
      // binary installs rely on the user updating the binary separately, but
      // we surface that case below as "external-server mode" so it's visible).
      // In external-server mode (--server-url) we don't own the server, so
      // we can never update it from inside the bridge.
      if (!this.restartServer) {
        lines.push("  ℹ️  外部 server 模式，无法通过 bridge 更新");
      } else if (serverVersion && isNewerSemver(latestVersion, serverVersion)) {
        lines.push("  ⬆️ 有新版本，使用 `/restart` 更新 server");
      }
    } else {
      lines.push(`  📡 Latest: (unable to query npm registry)`);
    }

    await this.sendReply(contextToken, lines.join("\n"));
  }

  /**
   * Fetch the `version` field from `https://registry.npmjs.org/<pkg>/latest`.
   * Returns null on any failure (network, timeout, 404, malformed JSON) so
   * the `/version` command stays usable offline.
   */
  private async getLatestNpmVersion(pkgName: string): Promise<string | null> {
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        this.log(`npm registry ${res.status} for ${pkgName}`);
        return null;
      }
      const data = (await res.json()) as { version?: string };
      return typeof data.version === "string" ? data.version : null;
    } catch (err) {
      this.log(`npm registry fetch failed: ${String(err)}`);
      return null;
    }
  }

  // ─── Helpers ───

  /**
   * Run `fn` and, if it hasn't resolved within `SLOW_WARN_THRESHOLD_MS`,
   * send a short "still working, please wait" hint to the user before
   * `fn`'s real reply lands. The hint is sent *only* when the operation
   * actually takes longer than the threshold — fast operations stay
   * silent and the user sees a single, clean reply.
   *
   * Implementation notes:
   * - The hint goes through `sendReply` (i.e. the same outbound queue as
   *   every other WeChat message) so it can never arrive after the real
   *   reply even under back-pressure.
   * - The timer is always cleared in `finally` so a fast fn that races
   *   the timer doesn't leave a dangling setTimeout firing a stale hint
   *   later (which would be confusing — the user already saw the answer).
   * - Hint-send failures are swallowed: if WeChat itself is degraded,
   *   surfacing that to the user via the hint channel would be worse
   *   than just dropping the hint and letting the real reply try.
   * - Returns whatever `fn` returns (or re-throws), so callers can use
   *   the wrapper transparently.
   */
  private async runWithSlowWarn<T>(
    contextToken: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timer = setTimeout(() => {
      this.sendReply(contextToken, `⏳ 正在获取 ${label}，请稍候...`).catch((err: unknown) => {
        this.log(`slow-warn send error: ${String(err)}`);
      });
    }, SLOW_WARN_THRESHOLD_MS);
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
    }
  }

  private detectUnknownSlashCommand(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const match = trimmed.match(/^\/(\w+)/);
    if (!match) return null;

    const cmdName = match[1].toLowerCase();
    const bridgeCommands = [
      "workspace", "ws", "session", "s", "agent", "a", "model",
      "reasoning", "help", "h", "?", "status",
      "thought-display",
      "tool-display",
      "stop", "compact", "summarize", "restart", "next", "version",
      // History (chat-log) command. Listed here so a typo like
      // `/historys` still surfaces the unknown-command hint, but the
      // valid `/history` / `/hist` are always routed to the bridge.
      "history", "hist",
      // Permission commands (parsed by parseAutoPermissionCommand /
      // parseRejectPermissionCommand, never forwarded to agent when
      // pending; otherwise safe to list as bridge commands so the
      // "unknown slash command" hint doesn't trigger on them).
      "auto-permission", "ap",
      "reject-permission", "rp",
      // Cross-session notification command. Same rationale as
      // permission commands: recognized by the bridge so the
      // "unknown slash command" hint doesn't fire when the user
      // mistypes a subcommand.
      "notify", "n",
      // Silent / immersive mode command. Recognized by the bridge so
      // the "unknown slash command" hint doesn't fire when the user
      // mistypes `/slent` etc.
      "silent", "sl",
    ];
    if (bridgeCommands.includes(cmdName)) return null;

    return `⚠️ Command "/${match[1]}" is not a bridge command, forwarding to agent.`;
  }

  private async sendHelpReply(contextToken: string): Promise<void> {
    // Capture to a local for the same TS-narrowing reason as
    // handleStatusCommand — `this.sessionManager` is `SessionManager | null`
    // and the narrowing from the optional chain doesn't survive the await.
    // Preserve the null-tolerant behavior of the original code (when no
    // session manager exists, still send a help reply with no native
    // commands appended) by handling null inside the closure.
    const sessionManager = this.sessionManager;

    await this.runWithSlowWarn(contextToken, "帮助", async () => {
      const nativeCommands = sessionManager
        ? (await sessionManager.getAvailableCommands()) ?? []
        : [];
      const helpText = formatHelpWithNativeCommands(nativeCommands);
      await this.sendReply(contextToken, helpText);
    });
  }

  private extractTextFromMessage(msg: WeixinMessage): string | null {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    }
    return null;
  }

  private async enqueueMessage(msg: WeixinMessage, contextToken: string): Promise<void> {
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    const parts = await weixinMessageToPrompt(msg, this.config.wechat.cdnBaseUrl, this.log, tempDir);
    await this.sessionManager!.enqueue(parts, contextToken);
  }

  /**
   * Arm the auto-flush ("auto /next") timer, if enabled and not already
   * pending. Called whenever messages are cached into `pendingOutbound`
   * (outbound send limit hit). When the timer fires, `runAutoFlush`
   * delivers the cached messages without requiring a user message or a
   * manual `/next`.
   */
  private scheduleAutoFlush(contextToken: string): void {
    const delayMs = this.config.wechat.autoFlushMs;
    if (!delayMs || delayMs <= 0 || this.autoFlushTimer) return;
    this.autoFlushTimer = setTimeout(() => {
      this.autoFlushTimer = null;
      this.runAutoFlush(contextToken).catch((err: unknown) => {
        this.log(`auto-flush error: ${String(err)}`);
      });
    }, delayMs);
  }

  /**
   * Auto-flush body. Waits for any in-flight outbound send on the same
   * contextToken to settle (so the flush doesn't interleave with an agent
   * reply and reorder messages on WeChat), then runs the same flush the
   * manual `/next` command uses. If the 10-msg limit still left messages
   * cached, re-arms the timer for another round instead of waiting for the
   * user.
   */
  private async runAutoFlush(contextToken: string): Promise<void> {
    if (this.pendingOutbound.length === 0) return;
    const inflight = this.outboundQueue.get(contextToken);
    if (inflight) await inflight.catch(() => {});
    if (this.pendingOutbound.length === 0) return;
    await this.flushPending(contextToken);
    if (this.pendingOutbound.length > 0) {
      this.scheduleAutoFlush(contextToken);
    }
  }

  private async flushPending(contextToken: string): Promise<void> {
    if (this.pendingOutbound.length === 0) {
      await this.sendReply(contextToken, "✅ No cached messages");
      return;
    }

    this.wechatMsgCount = 0;
    this.log(`/next: flushing ${this.pendingOutbound.length} cached messages`);

    const remaining: PendingMessage[] = [];
    let sent = 0;

    for (const msg of this.pendingOutbound) {
      if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
        remaining.push(msg);
        continue;
      }
      this.wechatMsgCount++;

      try {
        const text = msg.kind === "text" || msg.kind === "tool_text" ? msg.text : "";
        const payload =
          text && this.wechatMsgCount > WeChatOpencodeBridge.MSG_LIMIT_WARN
            ? text + `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${this.wechatMsgCount} 条）${this.msgLimitNotice()}`
            : text;

        switch (msg.kind) {
          case "text":
          case "tool_text":
            await sendTextMessage(this.userState?.userId ?? "", payload || msg.text, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
            });
            break;
          case "media":
            if (msg.block.type === "image" && msg.block.data) {
              await sendMediaMessage(this.userState?.userId ?? "", UploadMediaType.IMAGE, Buffer.from(msg.block.data, "base64"), {
                baseUrl: this.tokenData!.baseUrl,
                token: this.tokenData!.token,
                contextToken,
                cdnBaseUrl: this.config.wechat.cdnBaseUrl,
                mimeType: msg.block.mimeType ?? "image/jpeg",
              });
            } else if (msg.block.type === "resource" && msg.block.blob) {
              const buf = Buffer.from(msg.block.blob, "base64");
              const mime = msg.block.resourceMimeType ?? "application/octet-stream";
              const mediaType = this.mimeToMediaType(mime);
              const fileName = msg.block.uri ? msg.block.uri.split("/").pop() : "file";
              await sendMediaMessage(this.userState?.userId ?? "", mediaType, buf, {
                baseUrl: this.tokenData!.baseUrl,
                token: this.tokenData!.token,
                contextToken,
                cdnBaseUrl: this.config.wechat.cdnBaseUrl,
                mimeType: mime,
                fileName,
              });
            }
            break;
          case "tool_file": {
            const buf = await fs.promises.readFile(msg.filePath);
            const mime = msg.mimeType ?? this.guessMimeType(msg.fileName);
            await sendMediaMessage(this.userState?.userId ?? "", this.mimeToMediaType(mime), buf, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
              cdnBaseUrl: this.config.wechat.cdnBaseUrl,
              mimeType: mime,
              fileName: msg.filePath.split(/[\\/]/).pop(),
            });
            break;
          }
        }
        sent++;
      } catch (err) {
        this.log(`/next send error: ${String(err)}`);
      }
    }

    if (remaining.length > 0) {
      this.pendingOutbound = remaining;
      await this.sendReply(contextToken, `✅ Sent ${sent}, ${remaining.length} cached, /next to continue`);
      this.scheduleAutoFlush(contextToken);
    } else {
      this.pendingOutbound = [];
      await this.sendReply(contextToken, `✅ All ${sent} cached messages sent`);
    }
  }

  private sendReply(contextToken: string, text: string): Promise<void> {
    return this.enqueueOutbound(contextToken, () => this.sendReplyImpl(contextToken, text));
  }

  /**
   * Suffix for the WeChat 10-msg-limit warning. When auto-flush is enabled
   * the user doesn't need to do anything — remaining messages are delivered
   * automatically — so we say so instead of asking for a manual `/next`.
   */
  private msgLimitNotice(): string {
    const autoFlushMs = this.config.wechat.autoFlushMs;
    return autoFlushMs && autoFlushMs > 0
      ? "（其余消息将自动续发）"
      : "（发送 /next 可重置）";
  }

  private async sendReplyImpl(contextToken: string, text: string): Promise<void> {
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);

    for (const segment of segments) {
      if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
        this.log(`WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching remaining segments`);
        const remaining = segments.slice(segments.indexOf(segment));
        const cached: PendingMessage[] = remaining.map((s) => ({ kind: "text", text: s, contextToken }));
        this.pendingOutbound = [...this.pendingOutbound, ...cached];
        this.scheduleAutoFlush(contextToken);
        break;
      }

      this.wechatMsgCount++;
      let payload = segment;
      if (this.wechatMsgCount > WeChatOpencodeBridge.MSG_LIMIT_WARN) {
        payload += `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${this.wechatMsgCount} 条）${this.msgLimitNotice()}`;
      }

      await sendTextMessage(this.userState?.userId ?? "", payload, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
      });
      this.log(`Sent text (${payload.length} chars, sent=${this.wechatMsgCount})`);
    }

    this.cancelTypingIndicator(contextToken).catch(() => {});
  }

  private sendMediaReply(contextToken: string, blocks: MediaContent[]): Promise<void> {
    return this.enqueueOutbound(contextToken, () => this.sendMediaReplyImpl(contextToken, blocks));
  }

  /**
   * Best-effort, single-shot warning sender used by the SessionManager
   * when an `onReply` call exhausts its retries. Sends a single short
   * `⚠️ 上一条<label>发送失败…` notice with NO retry (`retries: 0`) so
   * we don't compound network failures, and swallows any error — if
   * the warning itself fails (network fully down), the bridge just
   * logs and moves on; there is no further escalation possible when
   * the WeChat gateway itself is unreachable. Unlike `sendReply`,
   * this also does NOT go through the outbound queue — we want the
   * warning to land ASAP without waiting for any queued message, and
   * we don't want a queued-but-blocked outbound segment to delay the
   * user's visibility into the failure.
   */
  private async sendWarningReply(contextToken: string, text: string): Promise<void> {
    try {
      await sendTextMessage(this.userState?.userId ?? "", text, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
        retries: 0,
      });
      this.log(`Sent send-failure warning (${text.length} chars)`);
    } catch (err) {
      this.log(`sendWarningReply ALSO failed (network fully down?): ${String(err)}`);
    }
  }

  private async sendMediaReplyImpl(contextToken: string, blocks: MediaContent[]): Promise<void> {
    for (const block of blocks) {
      if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
        this.log(`WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching media`);
        const remaining = blocks.slice(blocks.indexOf(block));
        const cached: PendingMessage[] = remaining.map((b) => ({ kind: "media", block: b, contextToken }));
        this.pendingOutbound = [...this.pendingOutbound, ...cached];
        this.scheduleAutoFlush(contextToken);
        break;
      }

      this.wechatMsgCount++;
      const targetUserId = this.userState?.userId ?? "";

      if (block.type === "image" && block.data) {
        await sendMediaMessage(targetUserId, UploadMediaType.IMAGE, Buffer.from(block.data, "base64"), {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: block.mimeType ?? "image/jpeg",
        });
        this.log(`Sent image (sent=${this.wechatMsgCount})`);
      } else if (block.type === "resource" && block.blob) {
        const buf = Buffer.from(block.blob, "base64");
        const mime = block.resourceMimeType ?? "application/octet-stream";
        const mt = this.mimeToMediaType(mime);
        const fileName = block.uri ? block.uri.split("/").pop() : "file";
        await sendMediaMessage(targetUserId, mt, buf, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: mime,
          fileName,
        });
        const typeLabel = mt === UploadMediaType.IMAGE ? "image" : mt === UploadMediaType.VIDEO ? "video" : "file";
        this.log(`Sent ${typeLabel} (sent=${this.wechatMsgCount})`);
      }
    }

    this.cancelTypingIndicator(contextToken).catch(() => {});
  }

  /**
   * Run `fn` strictly after every previously enqueued operation for the same
   * `contextToken`. Without this guard the SessionManager's back-to-back
   * `onReply` calls (tool summary + thought line, or text part + tool
   * summary) race each other: each `await sendTextMessage(...)` returns in
   * arbitrary order depending on network timing, and the WeChat display
   * ends up showing the SHORT payload before the LONG one — e.g. R2 (56ch)
   * arriving before the bash-1 tool summary (30ch), or the 2ch "ok" text
   * arriving before the 44ch webfetch tool summary.
   *
   * The chain swallows rejected predecessors so a failed send doesn't
   * poison subsequent sends for the same contextToken. `next.finally`
   * removes the entry from the map once this task settles AND no newer
   * task has taken its slot — keeps the map bounded for contextTokens
   * that have stopped sending.
   *
   * Bug fix: `next.finally(...)` returns a NEW promise that inherits
   * `next`'s rejection. That new promise was unhandled when `fn()`
   * rejected (e.g. WeChat API timeout → `TypeError: fetch failed`),
   * which crashed the process under Node ≥15's default unhandled-
   * rejection policy. The `.catch(() => { })` below is the small
   * suppression: the original `next` is still returned to the caller
   * (and the caller attaches its own `.catch`), and we only need the
   * `finally` callback to run for the map cleanup.
   */
  private enqueueOutbound<T>(contextToken: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.outboundQueue.get(contextToken) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => fn());
    this.outboundQueue.set(contextToken, next);
    next.finally(() => {
      if (this.outboundQueue.get(contextToken) === next) {
        this.outboundQueue.delete(contextToken);
      }
    }).catch(() => {
      // Suppress the unhandled-rejection that `next.finally(...)` would
      // otherwise propagate when `fn()` rejects. See bug note above.
    });
    return next;
  }

  // ─── Typing indicator ───

  private async cancelTypingIndicator(contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(contextToken);
    if (!ticket) return;
    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: { ilink_user_id: this.userState?.userId ?? "", typing_ticket: ticket, status: TypingStatus.CANCEL },
    });
  }

  private async sendTypingIndicator(contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(contextToken);
      if (!ticket) return;
      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: { ilink_user_id: this.userState?.userId ?? "", typing_ticket: ticket, status: TypingStatus.TYPING },
      });
    } catch {
      // best-effort
    }
  }

  private async getTypingTicket(contextToken: string): Promise<string | null> {
    if (this.typingTicket && this.typingTicket.expiresAt > Date.now()) return this.typingTicket.ticket;
    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: this.userState?.userId ?? "",
        contextToken,
      });
      if (resp.typing_ticket) {
        this.typingTicket = { ticket: resp.typing_ticket, expiresAt: Date.now() + 24 * 60 * 60_000 };
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }
}
