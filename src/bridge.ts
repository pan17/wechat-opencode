/**
 * WeChatOpencodeBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
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
import type { MediaContent } from "./acp/client.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { WeChatOpencodeConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;
const TOOL_API_PORT = 18792;
const TOOL_API_HOST = "127.0.0.1";

export class WeChatOpencodeBridge {
  private config: WeChatOpencodeConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private toolApiServer: http.Server | null = null;
  private log: (msg: string) => void;

  constructor(config: WeChatOpencodeConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-opencode] ${msg}`));
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    // 0. Ensure config directories exist
    const authDir = path.join(this.config.storage.dir, "auth");
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    this.log(`Auth directory: ${authDir}`);
    this.log(`Temp directory: ${tempDir}`);

    // 1. Login or load token
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

    // 2. Create SessionManager
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (userId, contextToken, text) => this.sendReply(userId, contextToken, text),
      onMediaReply: (userId, contextToken, blocks) => this.sendMediaReply(userId, contextToken, blocks),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
    });
    this.sessionManager.start();

    // 3. Start tool API server (for custom tools like send-wechat)
    this.startToolApiServer();

    // 4. Start monitor loop
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

  private startToolApiServer(): void {
    this.toolApiServer = http.createServer(async (req, res) => {
      // Only accept POST requests to /send-wechat
      if (req.method !== "POST" || req.url !== "/send-wechat") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      try {
        const { sessionId, userId: directUserId, filePath, mimeType } = JSON.parse(body) as {
          sessionId?: string;
          userId?: string;
          filePath: string;
          mimeType?: string;
        };

        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "filePath is required" }));
          return;
        }

        let targetUserId: string;
        let contextToken: string;

        if (sessionId) {
          // Look up user by ACP session ID
          const userInfo = this.sessionManager!.getUserBySessionId(sessionId);
          if (!userInfo) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          targetUserId = userInfo.userId;
          contextToken = userInfo.contextToken;
        } else if (directUserId) {
          // Use userId directly - need to get contextToken from session
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

        // Read the file
        const fileBuffer = await fs.promises.readFile(filePath);
        const fileName = path.basename(filePath);
        const detectedMimeType = mimeType ?? this.guessMimeType(fileName);

        // Send the file to WeChat
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

  private handleMessage(msg: WeixinMessage): void {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    // Convert and enqueue — fire-and-forget (don't block the poll loop)
    this.enqueueMessage(msg, userId, contextToken).catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
    });
  }

  private saveBridgeState(userId: string): void {
    try {
      const state = {
        lastUserId: userId,
        lastSessionId: this.sessionManager?.getSession(userId)?.agentInfo?.sessionId,
        updatedAt: new Date().toISOString(),
      };
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Best effort
    }
  }

  private async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
      tempDir,
    );

    await this.sessionManager!.enqueue(userId, { prompt, contextToken });

    // Save state after session is created (enqueue creates the session)
    this.saveBridgeState(userId);
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

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async sendMediaReply(
    userId: string,
    contextToken: string,
    blocks: MediaContent[],
  ): Promise<void> {
    for (const block of blocks) {
      if (block.type === "image" && block.data) {
        // Send image
        const buffer = Buffer.from(block.data, "base64");
        await sendMediaMessage(userId, UploadMediaType.IMAGE, buffer, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: block.mimeType ?? "image/jpeg",
        });
      } else if (block.type === "resource" && block.blob) {
        // Send as file (binary blob)
        const buffer = Buffer.from(block.blob, "base64");
        const mimeType = block.resourceMimeType ?? "application/octet-stream";
        // Determine if it's an image based on mime type
        if (mimeType.startsWith("image/")) {
          await sendMediaMessage(userId, UploadMediaType.IMAGE, buffer, {
            baseUrl: this.tokenData!.baseUrl,
            token: this.tokenData!.token,
            contextToken,
            cdnBaseUrl: this.config.wechat.cdnBaseUrl,
            mimeType,
          });
        } else {
          // Send as file
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

    // Cancel typing indicator after media is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;

    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  private async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;

      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // Typing is best-effort
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
        this.typingTickets.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + 24 * 60 * 60_000, // 24h cache
        });
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
