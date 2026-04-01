/**
 * Spawn and manage ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";

/**
 * Resolve the global opencode config path.
 * Priority: OPENCODE_CONFIG env > ~/.config/opencode/opencode.json
 */
function resolveOpencodeConfig(): string | undefined {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch {
      // not found
    }
  }
  return undefined;
}

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
}

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  log: (msg: string) => void;
  /** Existing OpenCode session ID to resume */
  existingSessionId?: string;
}): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log, existingSessionId } = params;

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  // Resolve opencode config path to ensure global config (with plugins) is loaded
  const opencodeConfig = resolveOpencodeConfig();
  const rawEnv = { ...process.env, ...env };
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  if (opencodeConfig && !mergedEnv.OPENCODE_CONFIG) {
    mergedEnv.OPENCODE_CONFIG = opencodeConfig;
  }
  if (opencodeConfig && !mergedEnv.OPENCODE_CONFIG) {
    mergedEnv.OPENCODE_CONFIG = opencodeConfig;
  }

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: mergedEnv,
    shell: useShell,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error("Failed to get agent process stdio");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // Initialize
  log("Initializing ACP connection...");
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: packageJson.name,
      title: packageJson.name,
      version: packageJson.version,
    },
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  });
  log(`ACP initialized (protocol v${initResult.protocolVersion})`);

  // Create or resume session
  let sessionResult: { sessionId: string };
  if (existingSessionId) {
    log(`Resuming ACP session: ${existingSessionId}`);
    try {
      sessionResult = await connection.unstable_resumeSession({
        sessionId: existingSessionId,
        cwd,
        mcpServers: [],
      });
      log(`ACP session resumed: ${sessionResult.sessionId}`);
    } catch (err) {
      log(`Failed to resume session ${existingSessionId}: ${String(err)}, creating new one`);
      sessionResult = await connection.newSession({
        cwd,
        mcpServers: [],
      });
      log(`ACP session created (fallback): ${sessionResult.sessionId}`);
    }
  } else {
    log("Creating ACP session...");
    sessionResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    log(`ACP session created: ${sessionResult.sessionId}`);
  }

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
  };
}

export function killAgent(proc: ChildProcess): void {
  if (!proc.killed) {
    proc.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5_000).unref();
  }
}
