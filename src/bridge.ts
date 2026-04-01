/**
 * WeChatOpencodeBridge — the main orchestrator.
 *
 * Two concepts:
 *   - Session: OpenCode conversation (from SQLite)
 *   - Directory: working directory (cwd)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType, UploadMediaType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import { listSessions } from "./acp/opencode-sessions.js";
import type { MediaContent } from "./acp/client.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import {
  parseWorkspaceCommand,
  parseSessionCommand,
  parseHelpCommand,
  formatHelp,
} from "./adapter/workspace-cmd.js";
import type { WeChatOpencodeConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;
const TOOL_API_PORT = 18792;
const TOOL_API_HOST = "127.0.0.1";

interface UserState {
  userId: string;
  sessionId: string;       // OpenCode session ID (for resume)
  cwd: string;
}

export class WeChatOpencodeBridge {
  private config: WeChatOpencodeConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  private userStates = new Map<string, UserState>();
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private toolApiServer: http.Server | null = null;
  private log: (msg: string) => void;

  constructor(config: WeChatOpencodeConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-opencode] ${msg}`));
  }

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
      this.log(`Use --login to force re-login`);
    }

    // 2. Load saved user states
    this.loadUserStates();

    // 3. Create SessionManager
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentEnv: this.config.agent.env,
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (userId, contextToken, text) => this.sendReply(userId, contextToken, text),
      onMediaReply: (userId, contextToken, blocks) => this.sendMediaReply(userId, contextToken, blocks),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
      resolveCwd: (userId) => this.userStates.get(userId)?.cwd ?? this.config.agent.cwd,
      getExistingSessionId: (userId) => {
        const state = this.userStates.get(userId);
        return state?.sessionId && state.sessionId !== "" ? state.sessionId : undefined;
      },
      onSessionReady: (userId, sessionId) => {
        const state = this.userStates.get(userId);
        if (state && state.sessionId !== sessionId) {
          this.setUserState(userId, sessionId, state.cwd);
        }
      },
    });
    this.sessionManager.start();

    // 4. Tool API server
    this.startToolApiServer();

    // 5. Monitor loop
    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    await this.sessionManager?.stop();
    if (this.toolApiServer) {
      await new Promise<void>((resolve) => this.toolApiServer!.close(() => resolve()));
      this.toolApiServer = null;
    }
    this.log("Bridge stopped");
  }

  // ─── User state ───

  private loadUserStates(): void {
    try {
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      const raw = fs.readFileSync(stateFile, "utf-8");
      const state = JSON.parse(raw) as { users?: Array<{ userId: string; sessionId?: string; cwd: string }> };
      if (state.users) {
        for (const u of state.users) {
          this.userStates.set(u.userId, {
            userId: u.userId,
            sessionId: u.sessionId ?? "",
            cwd: u.cwd,
          });
        }
      }
    } catch {
      // No saved state
    }
  }

  private saveUserStates(): void {
    try {
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      const users = Array.from(this.userStates.values());
      fs.writeFileSync(stateFile, JSON.stringify({ users, updatedAt: new Date().toISOString() }, null, 2));
    } catch {
      // Best effort
    }
  }

  private setUserState(userId: string, sessionId: string, cwd: string): void {
    this.userStates.set(userId, { userId, sessionId, cwd });
    this.saveUserStates();
  }

  private getUserState(userId: string): UserState | null {
    return this.userStates.get(userId) ?? null;
  }

  // ─── Tool API ───

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
        const { sessionId, userId: directUserId, filePath, mimeType } = JSON.parse(body) as {
          sessionId?: string; userId?: string; filePath: string; mimeType?: string;
        };

        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "filePath is required" }));
          return;
        }

        let targetUserId: string;
        let contextToken: string;

        if (sessionId) {
          const userInfo = this.sessionManager!.getUserBySessionId(sessionId);
          if (!userInfo) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          targetUserId = userInfo.userId;
          contextToken = userInfo.contextToken;
        } else if (directUserId) {
          const session = this.sessionManager!.getSession(directUserId);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "User session not found. Has this user sent a message recently?" }));
            return;
          }
          targetUserId = directUserId;
          contextToken = session.contextToken;
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Either sessionId or userId is required" }));
          return;
        }

        const fileBuffer = await fs.promises.readFile(filePath);
        const fileName = path.basename(filePath);
        const detectedMimeType = mimeType ?? this.guessMimeType(fileName);

        await sendMediaMessage(targetUserId, detectedMimeType.startsWith("image/") ? UploadMediaType.IMAGE : UploadMediaType.FILE, fileBuffer, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: detectedMimeType,
          fileName,
        });

        this.log(`[tool-api] Sent file ${fileName} to user ${targetUserId}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, fileName }));
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
      pdf: "application/pdf", zip: "application/zip",
      txt: "text/plain", md: "text/markdown", json: "application/json",
      js: "text/javascript", ts: "text/typescript", py: "text/x-python",
      html: "text/html", css: "text/css", xml: "text/xml",
    };
    return map[ext] ?? "application/octet-stream";
  }

  // ─── Message handling ───

  private handleMessage(msg: WeixinMessage): void {
    if (msg.message_type !== MessageType.USER) return;
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    const textContent = this.extractTextFromMessage(msg);
    if (textContent) {
      if (parseHelpCommand(textContent)) {
        this.sendReply(userId, contextToken, formatHelp()).catch(() => {});
        return;
      }

      const wsCmd = parseWorkspaceCommand(textContent);
      if (wsCmd) {
        this.handleDirectoryCommand(userId, contextToken, wsCmd).catch((err) => {
          this.log(`Directory command error: ${String(err)}`);
        });
        return;
      }

      const sCmd = parseSessionCommand(textContent);
      if (sCmd) {
        this.handleSessionCommand(userId, contextToken, sCmd).catch((err) => {
          this.log(`Session command error: ${String(err)}`);
        });
        return;
      }
    }

    this.enqueueMessage(msg, userId, contextToken).catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
    });
  }

  // ─── Directory commands (/workspace or /ws) ───

  private async handleDirectoryCommand(
    userId: string,
    contextToken: string,
    cmd: ReturnType<typeof parseWorkspaceCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const sessions = listSessions();
        // Unique directories, preserve order (most recent first)
        const dirs: string[] = [];
        for (const s of sessions) {
          if (!dirs.includes(s.directory)) dirs.push(s.directory);
        }
        if (dirs.length === 0) {
          await this.sendReply(userId, contextToken, "No directories found.");
        } else {
          const lines = ["📂 Directories:"];
          for (let i = 0; i < dirs.length; i++) {
            lines.push(`  ${i + 1}. ${dirs[i]}`);
          }
          await this.sendReply(userId, contextToken, lines.join("\n"));
        }
        break;
      }

      case "status": {
        const state = this.getUserState(userId);
        await this.sendReply(userId, contextToken, `📂 ${state?.cwd ?? this.config.agent.cwd}`);
        break;
      }

      case "switch": {
        const sessions = listSessions();
        const dirs: string[] = [];
        for (const s of sessions) {
          if (!dirs.includes(s.directory)) dirs.push(s.directory);
        }

        // Try numeric index first
        const idx = parseInt(cmd!.name!, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= dirs.length) {
          const targetDir = dirs[idx - 1];
          const targetSession = sessions.find((s) => s.directory === targetDir)!;
          const state = this.getUserState(userId);
          if (state && state.cwd === targetDir) {
            await this.sendReply(userId, contextToken, `Already on ${targetDir}`);
            return;
          }
          this.setUserState(userId, targetSession.id, targetDir);
          await this.sessionManager.switchWorkspace(userId, contextToken);
          await this.sendReply(userId, contextToken, `🔄 Switched to\n  ${targetDir}`);
          return;
        }

        // Fallback: match by directory path
        const target = sessions.find((s) => s.directory === cmd!.name);
        if (!target) {
          await this.sendReply(userId, contextToken, `Directory "${cmd!.name}" not found. Use /workspace list to see available directories.`);
          return;
        }
        const state = this.getUserState(userId);
        if (state && state.cwd === target.directory) {
          await this.sendReply(userId, contextToken, `Already on ${target.directory}`);
          return;
        }
        this.setUserState(userId, target.id, target.directory);
        await this.sessionManager.switchWorkspace(userId, contextToken);
        await this.sendReply(userId, contextToken, `🔄 Switched to\n  ${target.directory}`);
        break;
      }

      case "add": {
        const targetPath = cmd!.path!;
        const state = this.getUserState(userId);
        if (state && state.cwd === targetPath) {
          await this.sendReply(userId, contextToken, `Already on ${targetPath}`);
          return;
        }
        // Create directory if it doesn't exist
        try {
          fs.mkdirSync(targetPath, { recursive: true });
        } catch (err) {
          await this.sendReply(userId, contextToken, `Failed to create directory: ${String(err)}`);
          return;
        }
        // Find existing session for this directory
        const sessions = listSessions();
        const existing = sessions.find((s) => s.directory === targetPath);
        const sessionId = existing?.id ?? "";
        this.setUserState(userId, sessionId, targetPath);
        await this.sessionManager.switchWorkspace(userId, contextToken);
        await this.sendReply(userId, contextToken, `🔄 Switched to\n  ${targetPath}`);
        break;
      }

      case "remove": {
        await this.sendReply(userId, contextToken, "Use /workspace switch to change directories.");
        break;
      }
    }
  }

  // ─── Session commands (/session or /s) ───

  private async handleSessionCommand(
    userId: string,
    contextToken: string,
    cmd: ReturnType<typeof parseSessionCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const sessions = listSessions();
        const lines: string[] = ["💬 Recent Sessions:"];
        for (let i = 0; i < Math.min(sessions.length, 10); i++) {
          const s = sessions[i];
          lines.push(`  ${i + 1}. ${s.title} — ${s.directory}`);
        }
        await this.sendReply(userId, contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        const sessions = listSessions().slice(0, 10);

        // Try numeric index first
        const idx = parseInt(cmd!.name!, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
          const target = sessions[idx - 1];
          this.setUserState(userId, target.id, target.directory);
          await this.sessionManager.switchWorkspace(userId, contextToken);
          await this.sendReply(userId, contextToken, `🔄 Switched to "${target.title}"\n  ${target.directory}`);
          return;
        }

        // Fallback: match by slug/id/title
        const target = sessions.find(
          (s) => s.slug === cmd!.name || s.id === cmd!.name || s.title.toLowerCase() === cmd!.name!.toLowerCase(),
        );
        if (!target) {
          await this.sendReply(userId, contextToken, `Session "${cmd!.name}" not found. Use /session list to see available sessions.`);
          return;
        }

        this.setUserState(userId, target.id, target.directory);
        await this.sessionManager.switchWorkspace(userId, contextToken);
        await this.sendReply(userId, contextToken, `🔄 Switched to "${target.title}"\n  ${target.directory}`);
        break;
      }

      case "status": {
        const state = this.getUserState(userId);
        if (state && state.sessionId) {
          const sessions = listSessions();
          const current = sessions.find((s) => s.id === state.sessionId);
          if (current) {
            await this.sendReply(userId, contextToken, `💬 ${current.title}\n  ${current.directory}`);
            break;
          }
        }
        await this.sendReply(userId, contextToken, `📂 ${this.getUserState(userId)?.cwd ?? this.config.agent.cwd}`);
        break;
      }

      case "new": {
        await this.sessionManager.restartSession(userId, contextToken);
        await this.sendReply(userId, contextToken, "🔄 Session restarted. Context cleared.");
        break;
      }

      case "remove": {
        await this.sendReply(userId, contextToken, "Sessions are managed by OpenCode.");
        break;
      }
    }
  }

  // ─── Helpers ───

  private extractTextFromMessage(msg: WeixinMessage): string | null {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    }
    return null;
  }

  private async enqueueMessage(msg: WeixinMessage, userId: string, contextToken: string): Promise<void> {
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    const prompt = await weixinMessageToPrompt(msg, this.config.wechat.cdnBaseUrl, this.log, tempDir);
    await this.sessionManager!.enqueue(userId, { prompt, contextToken });
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);
    for (const segment of segments) {
      await sendTextMessage(userId, segment, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
      });
    }
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async sendMediaReply(userId: string, contextToken: string, blocks: MediaContent[]): Promise<void> {
    for (const block of blocks) {
      if (block.type === "image" && block.data) {
        await sendMediaMessage(userId, UploadMediaType.IMAGE, Buffer.from(block.data, "base64"), {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: block.mimeType ?? "image/jpeg",
        });
      } else if (block.type === "resource" && block.blob) {
        const buffer = Buffer.from(block.blob, "base64");
        const mimeType = block.resourceMimeType ?? "application/octet-stream";
        if (mimeType.startsWith("image/")) {
          await sendMediaMessage(userId, UploadMediaType.IMAGE, buffer, {
            baseUrl: this.tokenData!.baseUrl,
            token: this.tokenData!.token,
            contextToken,
            cdnBaseUrl: this.config.wechat.cdnBaseUrl,
            mimeType,
          });
        } else {
          await sendMediaMessage(userId, UploadMediaType.FILE, buffer, {
            baseUrl: this.tokenData!.baseUrl,
            token: this.tokenData!.token,
            contextToken,
            cdnBaseUrl: this.config.wechat.cdnBaseUrl,
            mimeType,
            fileName: block.uri ? block.uri.split("/").pop() : "file",
          });
        }
      }
    }
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;
    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: { ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.CANCEL },
    });
  }

  private async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;
      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: { ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.TYPING },
      });
    } catch {
      // best-effort
    }
  }

  private async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: userId,
        contextToken,
      });
      if (resp.typing_ticket) {
        this.typingTickets.set(userId, { ticket: resp.typing_ticket, expiresAt: Date.now() + 24 * 60 * 60_000 });
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
