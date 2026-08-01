/**
 * Tests for user-visible system notices ("stuck"/outage alerts).
 *
 * Two sources of notices:
 *   1. `SessionManager` — the 5-minute stuck-turn timeout (force-finalize
 *      now also tells the user the agent was unresponsive) and SSE event
 *      pipeline outages (reconnecting > 60s → warning, recovery → OK).
 *   2. `startMonitor` — WeChat-channel session expiry, repeated poll
 *      failures (backoff), and recovery.
 *
 * The methods under test are private — TS `private` is compile-time
 * only, so the compiled dist/ methods are reachable at runtime. The
 * SessionManager is driven through a fake EventPipeline injected via
 * the `useEventStream: false` path is NOT used here; instead we call
 * the pipeline-status handler directly with crafted status values.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi } from "vitest";
import { SessionManager } from "../../dist/src/server/session.js";
import { defaultConfig } from "../../dist/src/config.js";

function makeManager(onNotify) {
  const config = defaultConfig();
  const manager = new SessionManager({
    serverUrl: config.server.url,
    cwd: config.agent.cwd,
    log: () => {},
    onReply: async () => {},
    onMediaReply: async () => {},
    sendTyping: async () => {},
    onNotify,
  });
  return manager;
}

describe("SessionManager stuck-turn notice", () => {
  test("stuck timeout notifies the user before force-finalizing", async () => {
    vi.useFakeTimers();
    try {
      const notified = vi.fn().mockResolvedValue(undefined);
      const manager = makeManager(notified);
      const finalizeSpy = vi.spyOn(manager, "finalizeTurn").mockImplementation(() => {
        manager.currentTurn = null;
      });

      // Begin a turn, then let the 5-minute stuck timer elapse.
      manager.currentTurn = {
        contextToken: "ctx-1",
        status: "accumulating",
      };
      manager.scheduleStuckTimeout();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(notified).toHaveBeenCalledTimes(1);
      const [ctx, text] = notified.mock.calls[0];
      expect(ctx).toBe("ctx-1");
      expect(text).toContain("无响应");
      expect(finalizeSpy).toHaveBeenCalledWith("finalized");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stuck notice is not sent when onNotify is omitted", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager(undefined);
      const finalizeSpy = vi.spyOn(manager, "finalizeTurn").mockImplementation(() => {
        manager.currentTurn = null;
      });
      manager.currentTurn = { contextToken: "ctx-1", status: "accumulating" };
      manager.scheduleStuckTimeout();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(finalizeSpy).toHaveBeenCalledWith("finalized"); // force-finalize still ran
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionManager pipeline-outage notice", () => {
  test("reconnecting for >60s notifies once; recovery notifies again", async () => {
    vi.useFakeTimers();
    try {
      const notified = vi.fn().mockResolvedValue(undefined);
      const manager = makeManager(notified);
      manager.lastEnqueuedContextToken = "ctx-9";

      manager.handlePipelineStatus("reconnecting");
      await vi.advanceTimersByTimeAsync(59_000);
      manager.handlePipelineStatus("reconnecting");
      expect(notified).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      manager.handlePipelineStatus("reconnecting");
      expect(notified).toHaveBeenCalledTimes(1);
      expect(notified.mock.calls[0][0]).toBe("ctx-9");
      expect(notified.mock.calls[0][1]).toContain("重连");

      // Recovery: connected clears the outage and sends an OK notice.
      manager.handlePipelineStatus("connected");
      expect(notified).toHaveBeenCalledTimes(2);
      expect(notified.mock.calls[1][1]).toContain("已恢复");

      // A later reconnect must NOT re-notify instantly (fresh outage).
      manager.handlePipelineStatus("reconnecting");
      expect(notified).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("brief reconnects under the threshold never notify", async () => {
    vi.useFakeTimers();
    try {
      const notified = vi.fn().mockResolvedValue(undefined);
      const manager = makeManager(notified);

      manager.handlePipelineStatus("reconnecting");
      await vi.advanceTimersByTimeAsync(10_000);
      manager.handlePipelineStatus("connected");
      manager.handlePipelineStatus("reconnecting");
      await vi.advanceTimersByTimeAsync(10_000);
      manager.handlePipelineStatus("connected");

      expect(notified).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionManager retry-failure notice", () => {
  test("zero-output turn after retry tells the user the request failed", async () => {
    vi.useFakeTimers();
    try {
      const replies = [];
      const config = defaultConfig();
      const manager = new SessionManager({
        serverUrl: config.server.url,
        cwd: config.agent.cwd,
        log: () => {},
        onReply: async (contextToken, text) => {
          replies.push({ contextToken, text });
        },
        onMediaReply: async () => {},
        sendTyping: async () => {},
      });
      manager.currentTurn = {
        contextToken: "ctx-retry",
        status: "accumulating",
        retried: true,
      };
      const finalizeSpy = vi.spyOn(manager, "finalizeTurn").mockImplementation(() => {
        manager.currentTurn = null;
      });

      // The retry flag is set when session.status=retry arrives mid-turn.
      manager.handleSessionStatus({
        type: "session.status",
        properties: { sessionID: "ses-x", status: { type: "retry" } },
      });
      expect(manager.currentTurn.retried).toBe(true);

      // Force-finalize (what the debounce does); currentTurn is cleared by
      // the spy so finalizeTurn's fallback runs against a snapshot... it
      // doesn't — finalizeTurn reads this.currentTurn. Simulate directly:
      finalizeSpy.mockRestore();
      // Rebuild a turn and call finalizeTurn for real.
      manager.currentTurn = {
        sessionId: "ses-x",
        userMessageId: "msg-1",
        assistantMessageId: null,
        parts: new Map(),
        textBuffer: "",
        finalText: "",
        toolCalls: new Map(),
        hasBackgroundTasks: false,
        contextToken: "ctx-retry",
        hint: null,
        status: "accumulating",
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        retried: true,
        sentTextPartIds: new Set(),
        pendingTextParts: [],
        pendingReasoningParts: [],
        showThoughtsSnapshot: false,
        showToolsSnapshot: false,
        immersiveSnapshot: false,
        immersiveLastText: "",
        reasoningCharCount: 0,
        reasoningStartMs: null,
        reasoningEndMs: null,
        sentReasoningPartIds: new Set(),
        reasoningPartTimestamps: new Map(),
        currentPartType: null,
        currentPartID: null,
        currentReasoningText: "",
        currentReasoningStartMs: null,
        currentReasoningEndMs: null,
        currentText: "",
        currentToolKey: null,
      };
      manager.finalizeTurn("finalized");

      expect(replies).toHaveLength(1);
      expect(replies[0].contextToken).toBe("ctx-retry");
      expect(replies[0].text).toContain("❌ Agent 请求失败");
    } finally {
      vi.useRealTimers();
    }
  });

  test("zero-output turn WITHOUT retry stays silent (no false positives)", async () => {
    vi.useFakeTimers();
    try {
      const replies = [];
      const config = defaultConfig();
      const manager = new SessionManager({
        serverUrl: config.server.url,
        cwd: config.agent.cwd,
        log: () => {},
        onReply: async (contextToken, text) => {
          replies.push({ contextToken, text });
        },
        onMediaReply: async () => {},
        sendTyping: async () => {},
      });
      manager.currentTurn = {
        sessionId: "ses-y",
        userMessageId: "msg-2",
        assistantMessageId: null,
        parts: new Map(),
        textBuffer: "",
        finalText: "",
        toolCalls: new Map(),
        hasBackgroundTasks: false,
        contextToken: "ctx-silent",
        hint: null,
        status: "accumulating",
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        retried: false,
        sentTextPartIds: new Set(),
        pendingTextParts: [],
        pendingReasoningParts: [],
        showThoughtsSnapshot: false,
        showToolsSnapshot: false,
        immersiveSnapshot: false,
        immersiveLastText: "",
        reasoningCharCount: 0,
        reasoningStartMs: null,
        reasoningEndMs: null,
        sentReasoningPartIds: new Set(),
        reasoningPartTimestamps: new Map(),
        currentPartType: null,
        currentPartID: null,
        currentReasoningText: "",
        currentReasoningStartMs: null,
        currentReasoningEndMs: null,
        currentText: "",
        currentToolKey: null,
      };
      manager.finalizeTurn("interrupted");
      expect(replies).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
