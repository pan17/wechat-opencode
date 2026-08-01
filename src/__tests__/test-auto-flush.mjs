/**
 * Tests for the auto-flush ("auto /next") feature.
 *
 * When the bridge hits WeChat's 10-consecutive-message send limit, the
 * remaining outbound segments are cached in `pendingOutbound`. Without
 * auto-flush they are only delivered on the next user message or an
 * explicit `/next`. With `wechat.autoFlushMs` > 0, the bridge arms a
 * timer on the first cache hit and flushes the cached messages
 * automatically once the delay elapses; if the limit still holds
 * (more than 10 segments cached), the timer re-arms for another round.
 *
 * The methods under test are private — TS `private` is compile-time
 * only, so the compiled dist/ methods are reachable at runtime. We
 * drive the real instance with fake timers and stub the outbound send
 * path (`flushPending` / `sendReplyImpl`) so no network is touched.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi } from "vitest";
import { WeChatOpencodeBridge } from "../../dist/src/bridge.js";
import { defaultConfig } from "../../dist/src/config.js";

function makeBridge(overrides = {}) {
  const config = defaultConfig();
  Object.assign(config.wechat, overrides);
  const bridge = new WeChatOpencodeBridge(config, () => {});
  return bridge;
}

describe("auto-flush (auto /next)", () => {
  test("does not arm a timer when autoFlushMs is 0 (disabled)", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 0 });
      bridge.pendingOutbound = [{ kind: "text", text: "cached", contextToken: "ctx-1" }];

      const flushSpy = vi.spyOn(bridge, "flushPending").mockResolvedValue(undefined);
      bridge.scheduleAutoFlush("ctx-1");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(flushSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not arm a timer when nothing is cached", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 60_000 });
      const flushSpy = vi.spyOn(bridge, "flushPending").mockResolvedValue(undefined);

      bridge.scheduleAutoFlush("ctx-1");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(flushSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("flushes cached messages once the delay elapses", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 60_000 });
      bridge.pendingOutbound = [{ kind: "text", text: "cached", contextToken: "ctx-1" }];
      const flushSpy = vi.spyOn(bridge, "flushPending").mockResolvedValue(undefined);

      bridge.scheduleAutoFlush("ctx-1");
      expect(bridge.autoFlushTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(flushSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(flushSpy).toHaveBeenCalledWith("ctx-1");
    } finally {
      vi.useRealTimers();
    }
  });

  test("re-arms for another round when messages remain cached after a flush", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 60_000 });
      bridge.pendingOutbound = [{ kind: "text", text: "cached", contextToken: "ctx-1" }];
      vi.spyOn(bridge, "flushPending").mockImplementation(async () => {
        // Simulate the 10-msg limit still holding: messages stay cached.
        bridge.pendingOutbound = [{ kind: "text", text: "still-cached", contextToken: "ctx-1" }];
      });

      bridge.scheduleAutoFlush("ctx-1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.autoFlushTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.pendingOutbound).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not flush while an in-flight outbound send is still running", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 60_000 });
      bridge.pendingOutbound = [{ kind: "text", text: "cached", contextToken: "ctx-1" }];
      const flushSpy = vi.spyOn(bridge, "flushPending").mockResolvedValue(undefined);

      // Simulate an agent reply in flight on the same contextToken.
      let releaseInflight = () => {};
      const inflight = new Promise((resolve) => {
        releaseInflight = () => resolve(undefined);
      });
      bridge.outboundQueue.set("ctx-1", inflight);

      bridge.scheduleAutoFlush("ctx-1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flushSpy).not.toHaveBeenCalled();

      releaseInflight();
      await vi.advanceTimersByTimeAsync(0);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cache hits after the first timer is pending do not double-arm", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 60_000 });
      bridge.pendingOutbound = [{ kind: "text", text: "cached", contextToken: "ctx-1" }];
      const flushSpy = vi.spyOn(bridge, "flushPending").mockResolvedValue(undefined);

      bridge.scheduleAutoFlush("ctx-1");
      const timer = bridge.autoFlushTimer;
      bridge.scheduleAutoFlush("ctx-1"); // second cache hit
      expect(bridge.autoFlushTimer).toBe(timer);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop() clears a pending auto-flush timer", async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge({ autoFlushMs: 60_000 });
      bridge.pendingOutbound = [{ kind: "text", text: "cached", contextToken: "ctx-1" }];
      const flushSpy = vi.spyOn(bridge, "flushPending").mockResolvedValue(undefined);

      bridge.scheduleAutoFlush("ctx-1");
      expect(bridge.autoFlushTimer).not.toBeNull();

      await bridge.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flushSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
