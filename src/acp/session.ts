/**
 * Per-user ACP session manager.
 *
 * New architecture: ONE agent process per user, MULTIPLE ACP sessions within it.
 * Session/workspace switching uses ACP protocol methods (newSession/loadSession)
 * instead of kill+respawn.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { WeChatAcpClient, type MediaContent } from "./client.js";
import { spawnAgent, killAgent, type AgentCapabilities } from "./agent-manager.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  contextToken: string;
  hint?: string;  // Optional hint to append to the reply (e.g., "unrecognized slash command")
}

export interface UserSession {
  userId: string;
  contextToken: string;
  client: WeChatAcpClient;
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  capabilities: AgentCapabilities;
  activeSessionId: string;
  sessions: Map<string, { cwd: string; title?: string }>;
  currentMode?: string;
  currentModelId?: string;
  /** Real available modes from ACP response (e.g., build, plan) */
  availableModes?: acp.SessionMode[];
  /** Real available models from ACP response */
  availableModels?: acp.ModelInfo[];
  /** Available config options from ACP response (thought_level, etc.) */
  configOptions?: acp.SessionConfigOption[];
  /** Current thought level value (tracked manually when setReasoning is called) */
  currentThoughtLevel?: string;
  /** Last queried models (used when user does /model list <provider>) */
  lastQueriedModels?: Map<string, acp.ModelInfo[]>;
  /** Track which provider was last queried for index-based switching */
  lastQueriedProvider?: string;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  createdAt: number;
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
      killAgent(session.process);
    }
    this.sessions.clear();
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    let session = this.sessions.get(userId);

    if (!session) {
      if (this.sessions.size >= this.opts.maxConcurrentUsers) {
        this.evictOldest();
      }

      session = await this.createInitialSession(userId, message.contextToken);
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
   * Update session state from ACP loadSession/newSession response.
   */
  private applyLoadSessionState(
    session: UserSession,
    result: {
      modes?: { availableModes: acp.SessionMode[]; currentModeId: string } | null;
      models?: { availableModels: acp.ModelInfo[]; currentModelId: string } | null;
      configOptions?: acp.SessionConfigOption[] | null;
    },
  ): void {
    if (result.modes) {
      session.availableModes = result.modes.availableModes;
      session.currentMode = result.modes.currentModeId;
    }
    if (result.models) {
      session.availableModels = result.models.availableModels;
      session.currentModelId = result.models.currentModelId;
    }
    if (result.configOptions) {
      session.configOptions = result.configOptions;
    }
  }

  /**
   * Switch workspace: loads the most recent session for the given cwd,
   * or creates a new one if none exists.
   * NO kill/respawn of the agent process.
   */
  async switchWorkspace(userId: string, contextToken: string, cwd: string, existingSessionId?: string): Promise<void> {
    let session = this.sessions.get(userId);
    if (!session) {
      // No process yet — create initial session first
      session = await this.createInitialSession(userId, contextToken);
      this.sessions.set(userId, session);
    }

    if (existingSessionId) {
      // Load existing session for this cwd
      this.opts.log(`[${userId}] Loading session ${existingSessionId} for workspace switch (cwd: ${cwd})`);
        session.client.setReplaying(true);
        try {
          const loadResult = await session.connection.loadSession({
            sessionId: existingSessionId,
            cwd,
            mcpServers: [],
          });
          session.activeSessionId = existingSessionId;
          this.applyLoadSessionState(session, loadResult);
          if (!session.sessions.has(existingSessionId)) {
            session.sessions.set(existingSessionId, { cwd });
          }
        } finally {
          session.client.setReplaying(false);
        }
    } else {
      // No existing session — create new one
      this.opts.log(`[${userId}] Creating new session for workspace switch (cwd: ${cwd})`);
      const result = await session.connection.newSession({
        cwd,
        mcpServers: [],
      });
      session.activeSessionId = result.sessionId;
      this.applyLoadSessionState(session, result);
      session.sessions.set(result.sessionId, { cwd });
    }

    session.contextToken = contextToken;
    session.lastActivity = Date.now();
    this.opts.onSessionReady?.(userId, session.activeSessionId);
  }

  /**
   * Switch to an existing ACP session, replaying its conversation history.
   */
  async switchSession(userId: string, contextToken: string, sessionId: string, cwd: string): Promise<void> {
    let session = this.sessions.get(userId);
    if (!session) {
      // No process yet — create initial session first
      session = await this.createInitialSession(userId, contextToken);
      this.sessions.set(userId, session);
    }

    this.opts.log(`[${userId}] Loading session ${sessionId} (cwd: ${cwd})`);

    // Suppress replayed content
    session.client.setReplaying(true);
    try {
      const loadResult = await session.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      session.activeSessionId = sessionId;
      this.applyLoadSessionState(session, loadResult);
      if (!session.sessions.has(sessionId)) {
        session.sessions.set(sessionId, { cwd });
      }
    } finally {
      session.client.setReplaying(false);
    }

    session.contextToken = contextToken;
    session.lastActivity = Date.now();

    this.opts.onSessionReady?.(userId, sessionId);
  }

  /**
   * Create a new ACP session, returns the new session ID.
   */
  async createNewSession(userId: string, contextToken: string, cwd: string): Promise<string> {
    let session = this.sessions.get(userId);
    if (!session) {
      // No process yet — create initial session first
      session = await this.createInitialSession(userId, contextToken);
      this.sessions.set(userId, session);
    }

    this.opts.log(`[${userId}] Creating new ACP session (cwd: ${cwd})`);

    const result = await session.connection.newSession({
      cwd,
      mcpServers: [],
    });

    session.sessions.set(result.sessionId, { cwd });
    session.activeSessionId = result.sessionId;
    this.applyLoadSessionState(session, result);
    session.contextToken = contextToken;
    session.lastActivity = Date.now();

    return result.sessionId;
  }

  /**
   * List sessions for the current agent.
   */
  async listAgentSessions(userId: string, cwd?: string): Promise<acp.ListSessionsResponse> {
    const session = this.sessions.get(userId);
    if (!session) {
      return { sessions: [] };
    }

    if (!session.capabilities.sessionCapabilities?.list) {
      this.opts.log(`[${userId}] Agent does not support listSessions`);
      return { sessions: [] };
    }

    return session.connection.listSessions({ cwd });
  }

  /**
   * Close an ACP session.
   */
  async closeSession(userId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    if (!session.capabilities.sessionCapabilities?.close) {
      this.opts.log(`[${userId}] Agent does not support closeSession`);
      return;
    }

    this.opts.log(`[${userId}] Closing session ${sessionId}`);

    await session.connection.unstable_closeSession({ sessionId });
    session.sessions.delete(sessionId);

    // If we closed the active session, switch to another or create a new one
    if (session.activeSessionId === sessionId) {
      const remaining = Array.from(session.sessions.keys());
      if (remaining.length > 0) {
        session.activeSessionId = remaining[0];
      } else {
        // Create a new session
        const cwd = this.opts.resolveCwd(userId);
        const result = await session.connection.newSession({ cwd, mcpServers: [] });
        session.activeSessionId = result.sessionId;
        session.sessions.set(result.sessionId, { cwd });
      }
    }
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId);
  }

  /**
   * Get available slash commands advertised by the agent.
   */
  getAvailableCommands(userId: string): acp.AvailableCommand[] {
    const session = this.sessions.get(userId);
    if (!session) return [];
    return session.client.getAvailableCommands();
  }

  getUserBySessionId(acpSessionId: string): { userId: string; contextToken: string } | null {
    for (const [userId, session] of this.sessions) {
      if (session.activeSessionId === acpSessionId) {
        return { userId, contextToken: session.contextToken };
      }
    }
    return null;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Switch the agent mode (agent) using ACP protocol.
   */
  async switchAgent(userId: string, mode: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    this.opts.log(`[${userId}] Switching agent mode to: ${mode}`);

    await session.connection.setSessionMode({
      sessionId: session.activeSessionId,
      modeId: mode,
    });

    session.currentMode = mode;
    session.lastActivity = Date.now();
  }

  /**
   * Switch the model using ACP protocol.
   */
  async setModel(userId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    this.opts.log(`[${userId}] Switching model to: ${modelId}`);

    await session.connection.unstable_setSessionModel({
      sessionId: session.activeSessionId,
      modelId: modelId,
    });

    session.currentModelId = modelId;
    session.lastActivity = Date.now();
  }

  /**
   * Switch the reasoning level (thought_level) using ACP protocol.
   */
  async setReasoning(userId: string, level: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    // Find the thought_level config option to get its id
    const thoughtLevelOpt = session.configOptions?.find(
      (o) => o.category === "thought_level",
    );

    if (thoughtLevelOpt) {
      // Use the actual config option id
      await session.connection.setSessionConfigOption({
        sessionId: session.activeSessionId,
        configId: thoughtLevelOpt.id,
        type: "select",
        value: level,
      });
      // Track locally so status works even if ACP doesn't echo back
      session.currentThoughtLevel = level;
    } else {
      // Fallback: try without config discovery
      await session.connection.setSessionConfigOption({
        sessionId: session.activeSessionId,
        configId: level,
        type: "select",
        value: level,
      });
      session.currentThoughtLevel = level;
    }

    session.lastActivity = Date.now();
  }

  /**
   * Get the currently active agent mode for a user.
   */
  getActiveMode(userId: string): string | undefined {
    return this.sessions.get(userId)?.currentMode;
  }

  /**
   * Get all available agent modes for a user (real ACP data).
   */
  getAvailableModes(userId: string): acp.SessionMode[] | undefined {
    return this.sessions.get(userId)?.availableModes;
  }

  /**
   * Get current reasoning/thought level.
   */
  getCurrentReasoning(userId: string): string | undefined {
    const session = this.sessions.get(userId);
    if (!session) return undefined;
    const localTracking = session.currentThoughtLevel;
    if (localTracking) return localTracking;
    const thoughtLevelOpt = session.configOptions?.find(
      (o) => o.category === "thought_level",
    );
    return thoughtLevelOpt?.type === "select" ? thoughtLevelOpt.currentValue : undefined;
  }

  /**
   * Cache last queried models for a provider.
   */
  cacheModelListForProvider(userId: string, provider: string, models: acp.ModelInfo[]): void {
    const session = this.sessions.get(userId);
    if (!session) return;
    if (!session.lastQueriedModels) session.lastQueriedModels = new Map();
    session.lastQueriedModels.set(provider, models);
    session.lastQueriedProvider = provider;
  }

  /**
   * Get last queried models for a provider.
   */
  getCachedModelsForProvider(userId: string, provider: string): acp.ModelInfo[] | undefined {
    return this.sessions.get(userId)?.lastQueriedModels?.get(provider);
  }

  /**
   * Get the provider that was last queried.
   */
  getLastQueriedProvider(userId: string): string | undefined {
    return this.sessions.get(userId)?.lastQueriedProvider;
  }

  /**
   * Get all last queried models in order of last queried provider.
   */
  getCachedModelsForLastQueried(userId: string): acp.ModelInfo[] | undefined {
    const session = this.sessions.get(userId);
    if (!session) return undefined;
    if (!session.lastQueriedProvider) return undefined;
    return session.lastQueriedModels?.get(session.lastQueriedProvider);
  }

  /**
   * Get the currently active model for a user.
   */
  getCurrentModel(userId: string): string | undefined {
    return this.sessions.get(userId)?.currentModelId;
  }

  /**
   * Get all available models for a user (real ACP data).
   */
  getAvailableModels(userId: string): acp.ModelInfo[] | undefined {
    return this.sessions.get(userId)?.availableModels;
  }

  /**
   * Get config options for a user (real ACP data).
   */
  getConfigOptions(userId: string): acp.SessionConfigOption[] | undefined {
    return this.sessions.get(userId)?.configOptions;
  }

  private async createInitialSession(userId: string, contextToken: string): Promise<UserSession> {
    const cwd = this.opts.resolveCwd(userId);
    const existingSessionId = this.opts.getExistingSessionId?.(userId);

    this.opts.log(
      `Creating initial session for ${userId} (cwd: ${cwd}${existingSessionId ? `, resume: ${existingSessionId}` : ""})`,
    );

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

    // Set up process exit handler
    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.process === agentInfo.process) {
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
      process: agentInfo.process,
      connection: agentInfo.connection,
      capabilities: agentInfo.capabilities,
      activeSessionId: agentInfo.sessionId,
      sessions: new Map([[agentInfo.sessionId, { cwd }]]),
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      ready: true,
      // Store real ACP session state data
      currentMode: agentInfo.currentModeId,
      currentModelId: agentInfo.currentModelId,
      availableModes: agentInfo.availableModes,
      availableModels: agentInfo.availableModels,
      configOptions: agentInfo.configOptions,
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
          const result = await session.connection.prompt({
            sessionId: session.activeSessionId,
            prompt: pending.prompt,
          });

          let replyText = await session.client.flush();

          if (result.stopReason === "cancelled") {
            replyText += "\n[cancelled]";
          } else if (result.stopReason === "refusal") {
            replyText += "\n[agent refused to continue]";
          }

          this.opts.log(`[${session.userId}] Agent done (${result.stopReason}), reply ${replyText.length} chars`);

          // Append hint if present
          if (pending.hint && replyText.trim()) {
            replyText += `\n\n${pending.hint}`;
          }

          if (replyText.trim()) {
            await this.opts.onReply(session.userId, pending.contextToken, replyText);
          }
        } catch (err) {
          this.opts.log(`[${session.userId}] Agent prompt error: ${String(err)}`);

          if (session.process.killed || session.process.exitCode !== null) {
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
        killAgent(session.process);
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
      if (session) killAgent(session.process);
      this.sessions.delete(oldest.userId);
    }
  }
}
