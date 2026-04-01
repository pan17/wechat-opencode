/**
 * Per-user ACP session manager.
 *
 * Each WeChat user has at most ONE active agent subprocess at a time.
 * Switching workspace kills the old agent and spawns a new one with the new cwd.
 * Restarting session kills the agent and spawns a new one with the same cwd.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { WeChatAcpClient, type MediaContent } from "./client.js";
import { spawnAgent, killAgent, type AgentProcessInfo } from "./agent-manager.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  contextToken: string;
}

export interface UserSession {
  userId: string;
  contextToken: string;
  client: WeChatAcpClient;
  agentInfo: AgentProcessInfo;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  createdAt: number;
  /** Set to true when agent is fully initialized */
  ready: boolean;
}

export interface SessionManagerOpts {
  agentCommand: string;
  agentArgs: string[];
  agentEnv?: Record<string, string>;
  idleTimeoutMs: number;
  maxConcurrentUsers: number;
  showThoughts: boolean;
  log: (msg: string) => void;
  onReply: (userId: string, contextToken: string, text: string) => Promise<void>;
  onMediaReply: (userId: string, contextToken: string, blocks: MediaContent[]) => Promise<void>;
  sendTyping: (userId: string, contextToken: string) => Promise<void>;
  /** Resolve cwd for a given userId */
  resolveCwd: (userId: string) => string;
  /** Get existing OpenCode session ID to resume (optional) */
  getExistingSessionId?: (userId: string) => string | undefined;
  /** Called after agent starts with the actual session ID */
  onSessionReady?: (userId: string, sessionId: string) => void;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private opts: SessionManagerOpts;
  private aborted = false;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 2 * 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    this.aborted = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const session of this.sessions.values()) {
      killAgent(session.agentInfo.process);
    }
    this.sessions.clear();
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    let session = this.sessions.get(userId);

    if (!session) {
      if (this.sessions.size >= this.opts.maxConcurrentUsers) {
        this.evictOldest();
      }

      session = await this.createSession(userId, message.contextToken, this.opts.getExistingSessionId?.(userId));
      this.sessions.set(userId, session);
    }

    session.contextToken = message.contextToken;
    session.lastActivity = Date.now();
    session.queue.push(message);

    if (!session.processing) {
      session.processing = true;
      this.processQueue(session).catch((err) => {
        this.opts.log(`[${userId}] queue processing error: ${String(err)}`);
      });
    }
  }

  /**
   * Restart session for a user: kill old agent, spawn new one with current cwd.
   * Clears ACP conversation context.
   */
  async restartSession(userId: string, contextToken: string): Promise<UserSession | null> {
    const oldSession = this.sessions.get(userId);
    if (oldSession) {
      this.opts.log(`[${userId}] Restarting session`);
      killAgent(oldSession.agentInfo.process);
      this.sessions.delete(userId);
    }

    const newSession = await this.createSession(userId, contextToken);
    this.sessions.set(userId, newSession);
    return newSession;
  }

  /**
   * Switch workspace: kill old agent and start new one immediately.
   * Returns a promise that resolves when the new agent is fully ready.
   */
  switchWorkspace(userId: string, contextToken: string): Promise<void> {
    const oldSession = this.sessions.get(userId);
    if (oldSession) {
      this.opts.log(`[${userId}] Switching workspace: killing agent`);
      killAgent(oldSession.agentInfo.process);
      this.sessions.delete(userId);
    }

    const cwd = this.opts.resolveCwd(userId);
    this.opts.log(`Starting new session for ${userId} (cwd: ${cwd})`);

    // Create a promise that resolves when spawnAndReplace completes
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });

    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: (text) => this.opts.onReply(userId, contextToken, text),
      onMediaFlush: (blocks) => this.opts.onMediaReply(userId, contextToken, blocks),
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
    });

    const placeholder: UserSession = {
      userId,
      contextToken,
      client,
      agentInfo: {
        process: null as unknown as ChildProcess,
        connection: null as unknown as acp.ClientSideConnection,
        sessionId: "",
      },
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      ready: false,
    };
    this.sessions.set(userId, placeholder);

    // Now spawn the agent in background
    this.spawnAndReplace(userId, contextToken, cwd, client, resolveReady!).catch((err) => {
      this.opts.log(`[${userId}] Failed to spawn agent: ${String(err)}`);
      this.sessions.delete(userId);
    });

    return readyPromise;
  }

  private async spawnAndReplace(
    userId: string,
    contextToken: string,
    cwd: string,
    client: WeChatAcpClient,
    onReady?: () => void,
  ): Promise<void> {
    const existingSessionId = this.opts.getExistingSessionId?.(userId);
    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      existingSessionId,
    });

    const session: UserSession = {
      userId,
      contextToken,
      client,
      agentInfo,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      ready: true,
    };

    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.agentInfo.process === agentInfo.process) {
        this.opts.log(`Agent process for ${userId} exited, removing session`);
        this.sessions.delete(userId);
      }
    });

    this.opts.onSessionReady?.(userId, agentInfo.sessionId);
    this.sessions.set(userId, session);
    onReady?.();
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId);
  }

  getUserBySessionId(acpSessionId: string): { userId: string; contextToken: string } | null {
    for (const [userId, session] of this.sessions) {
      if (session.agentInfo.sessionId === acpSessionId) {
        return { userId, contextToken: session.contextToken };
      }
    }
    return null;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private async createSession(userId: string, contextToken: string, existingSessionId?: string): Promise<UserSession> {
    const cwd = this.opts.resolveCwd(userId);
    this.opts.log(`Creating new session for ${userId} (cwd: ${cwd}${existingSessionId ? `, resume: ${existingSessionId}` : ""})`);

    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: (text) => this.opts.onReply(userId, contextToken, text),
      onMediaFlush: (blocks) => this.opts.onMediaReply(userId, contextToken, blocks),
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
    });

    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      existingSessionId,
    });

    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.agentInfo.process === agentInfo.process) {
        this.opts.log(`Agent process for ${userId} exited, removing session`);
        this.sessions.delete(userId);
      }
    });

    // Notify bridge of the actual session ID
    this.opts.onSessionReady?.(userId, agentInfo.sessionId);

    return {
      userId,
      contextToken,
      client,
      agentInfo,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      ready: true,
    };
  }

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;

        session.client.updateCallbacks({
          sendTyping: () => this.opts.sendTyping(session.userId, pending.contextToken),
          onThoughtFlush: (text) => this.opts.onReply(session.userId, pending.contextToken, text),
          onMediaFlush: (blocks) => this.opts.onMediaReply(session.userId, pending.contextToken, blocks),
        });

        await session.client.flush();

        try {
          this.opts.sendTyping(session.userId, pending.contextToken).catch(() => {});

          this.opts.log(`[${session.userId}] Sending prompt to agent...`);
          const result = await session.agentInfo.connection.prompt({
            sessionId: session.agentInfo.sessionId,
            prompt: pending.prompt,
          });

          let replyText = await session.client.flush();

          if (result.stopReason === "cancelled") {
            replyText += "\n[cancelled]";
          } else if (result.stopReason === "refusal") {
            replyText += "\n[agent refused to continue]";
          }

          this.opts.log(`[${session.userId}] Agent done (${result.stopReason}), reply ${replyText.length} chars`);

          if (replyText.trim()) {
            await this.opts.onReply(session.userId, pending.contextToken, replyText);
          }
        } catch (err) {
          this.opts.log(`[${session.userId}] Agent prompt error: ${String(err)}`);

          if (session.agentInfo.process.killed || session.agentInfo.process.exitCode !== null) {
            this.opts.log(`[${session.userId}] Agent process died, removing session`);
            this.sessions.delete(session.userId);
            return;
          }

          try {
            await this.opts.onReply(
              session.userId,
              pending.contextToken,
              `⚠️ Agent error: ${String(err)}`,
            );
          } catch {
            // best effort
          }
        }
      }
    } finally {
      session.processing = false;
    }
  }

  private cleanupIdleSessions(): void {
    if (this.opts.idleTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity > this.opts.idleTimeoutMs && !session.processing) {
        this.opts.log(`Session for ${userId} idle for ${Math.round((now - session.lastActivity) / 60_000)}min, removing`);
        killAgent(session.agentInfo.process);
        this.sessions.delete(userId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: { userId: string; lastActivity: number } | null = null;
    for (const [userId, session] of this.sessions) {
      if (!session.processing && (!oldest || session.lastActivity < oldest.lastActivity)) {
        oldest = { userId, lastActivity: session.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Evicting oldest idle session: ${oldest.userId}`);
      const session = this.sessions.get(oldest.userId);
      if (session) killAgent(session.agentInfo.process);
      this.sessions.delete(oldest.userId);
    }
  }
}
