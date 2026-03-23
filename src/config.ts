/**
 * Configuration types and defaults for wechat-acp.
 */

import path from "node:path";
import os from "node:os";

export interface WeChatAcpConfig {
  wechat: {
    baseUrl: string;
    cdnBaseUrl: string;
    botType: string;
  };
  agent: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  };
  session: {
    idleTimeoutMs: number;
    maxConcurrentUsers: number;
  };
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
  return path.join(os.homedir(), ".wechat-acp");
}

export function defaultConfig(): WeChatAcpConfig {
  const storageDir = defaultStorageDir();
  return {
    wechat: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      botType: "3",
    },
    agent: {
      command: "",
      args: [],
      cwd: process.cwd(),
    },
    session: {
      idleTimeoutMs: 30 * 60_000, // 30 minutes
      maxConcurrentUsers: 10,
    },
    daemon: {
      enabled: false,
      logFile: path.join(storageDir, "wechat-acp.log"),
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
