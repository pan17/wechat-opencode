/**
 * WeChat long-poll monitor loop.
 * Polls getUpdates, dispatches messages via callback.
 */

import fs from "node:fs";
import path from "node:path";
import { getUpdates } from "./api.js";
import type { WeixinMessage, GetUpdatesResp } from "./types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;

export interface MonitorOpts {
  baseUrl: string;
  token?: string;
  storageDir: string;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log: (msg: string) => void;
  onMessage: (msg: WeixinMessage) => void;
  /**
   * Best-effort user-visible notice for WeChat-channel conditions the
   * user should know about but that are neither messages nor replies:
   * session expiry (the bot pauses for an hour), repeated poll
   * failures (backing off), and recovery. The bridge pushes the text
   * to the user's WeChat chat; failures are logged, not thrown.
   */
  onNotify?: (msg: string) => void;
}

function getSyncBufPath(storageDir: string): string {
  return path.join(storageDir, "sync-buf.json");
}

function loadSyncBuf(storageDir: string): string {
  const p = getSyncBufPath(storageDir);
  if (!fs.existsSync(p)) return "";
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { get_updates_buf?: string };
    return data.get_updates_buf ?? "";
  } catch {
    return "";
  }
}

function saveSyncBuf(storageDir: string, buf: string): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(getSyncBufPath(storageDir), JSON.stringify({ get_updates_buf: buf }), "utf-8");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

export async function startMonitor(opts: MonitorOpts): Promise<void> {
  const { baseUrl, token, storageDir, abortSignal, log, onMessage, onNotify } = opts;

  let getUpdatesBuf = loadSyncBuf(storageDir);
  if (getUpdatesBuf) {
    log(`Resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log("No previous sync buf, starting fresh");
  }

  let nextTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  let notifiedBackoff = false;

  const notify = (msg: string): void => {
    try {
      onNotify?.(msg);
    } catch (err) {
      log(`onNotify error: ${String(err)}`);
    }
  };

  while (!abortSignal?.aborted) {
    try {
      const resp: GetUpdatesResp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          log(`Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing 1 hour...`);
          notify("⚠️ 微信登录会话已过期，机器人将在 1 小时后自动重试。若仍无效请重启 wbo 重新扫码登录。");
          consecutiveFailures = 0;
          notifiedBackoff = false;
          await sleep(60 * 60_000, abortSignal);
          continue;
        }

        consecutiveFailures++;
        log(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          if (!notifiedBackoff) {
            notifiedBackoff = true;
            notify("⚠️ 微信消息通道连续失败，正在退避重试（30 秒后自动继续）。");
          }
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      if (consecutiveFailures > 0 || notifiedBackoff) {
        log("getUpdates recovered");
        if (notifiedBackoff) {
          notifiedBackoff = false;
          notify("✅ 微信消息通道已恢复。");
        }
      }
      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveSyncBuf(storageDir, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        onMessage(msg);
      }
    } catch (err) {
      if (abortSignal?.aborted) return;

      consecutiveFailures++;
      log(`getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
        if (!notifiedBackoff) {
          notifiedBackoff = true;
          notify("⚠️ 微信消息通道连续失败，正在退避重试（30 秒后自动继续）。");
        }
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
}
