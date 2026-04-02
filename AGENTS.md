# AGENTS.md — wechat-opencode

> Bridge WeChat direct messages to any ACP-compatible AI agent.

## Project Overview

- **Package**: `wechat-opencode` v0.1.8 — ESM-only (`"type": "module"`)
- **Runtime**: Node.js 20+
- **Language**: TypeScript, compiled to JS via `tsc`
- **Package manager**: npm (use `package-lock.json`)
- **Repository**: https://github.com/pan17/wechat-opencode

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode: tsc --watch
npm start            # Run compiled CLI: node dist/bin/wechat-opencode.js
npm run prepack      # Runs build before npm publish
```

**No test framework or linter is configured.** This is a lean project with only `tsc` for builds.

### Running the CLI locally

```bash
npm run build
node dist/bin/wechat-opencode.js --help
node dist/bin/wechat-opencode.js --agent opencode
```

## Architecture

```
bin/wechat-opencode.ts          — CLI entry (arg parsing, daemon, QR rendering)
src/index.ts                    — Public API exports
src/bridge.ts                   — Main orchestrator (WeChat poll ↔ ACP sessions)
src/config.ts                   — Config types, defaults, agent preset registry
src/vendor.d.ts                 — Type declarations for untyped npm packages
src/acp/
  session.ts                    — Per-user ACP session manager (spawn/kill/queue)
  agent-manager.ts              — Spawn agent subprocess + ACP connection (newSession/resumeSession)
  opencode-sessions.ts          — Read OpenCode SQLite (sessions list, @deprecated fallback only)
  workspace-manager.ts          — (removed — simplified to direct session management)
src/adapter/
  inbound.ts                    — WeChat message → ACP ContentBlock[] (text, image, file)
  outbound.ts                   — ACP reply → WeChat text (formatting, splitting)
  workspace-cmd.ts              — Parse /workspace, /session, /agent, /model, /reasoning, /help commands
src/weixin/
  auth.ts                       — WeChat iLink login (QR code, token persistence)
  monitor.ts                    — Long-poll for new messages
  send.ts                       — Send text/image/file/video to WeChat
  api.ts                        — WeChat iLink API (typing indicator, config)
  media.ts                      — CDN download + AES decryption
  types.ts                      — WeChat iLink types (MessageType, UploadMediaType, etc.)
```

### Key flows
1. **CLI** parses args → resolves agent preset → creates `WeChatOpencodeBridge`
2. **Bridge** handles QR login → starts `SessionManager` → begins WeChat long-poll
3. **SessionManager** spawns one ACP subprocess per WeChat user
4. **Adapters** convert WeChat messages ↔ ACP prompt format and back

### Session management
- Each WeChat user has **one active agent process** at a time
- Switching workspace/session uses ACP protocol (`session/new`, `session/load`) — **no process restart**
- Agent process is spawned once per user; all session/workspace/agent/model/reasoning switches happen within the same process
- `unstable_resumeSession()` is no longer used — `loadSession()` replaces it
- Session ID is persisted per-user in `~/.wechat-opencode/.wechat-bridge-state.json`

## Code Style

### Imports
- **Always use `.js` extension** in relative imports (ESM requirement):
  ```ts
  import { WeChatOpencodeBridge } from "./bridge.js";
  ```
- **Node built-ins** use `node:` prefix:
  ```ts
  import fs from "node:fs";
  import path from "node:path";
  ```
- Group order: Node built-ins → npm packages → relative imports
- Prefer **named exports** over default exports (only `qrcode-terminal` uses default)

### TypeScript
- **Strict mode** enabled (`"strict": true` in tsconfig)
- **Target**: ES2022, **Module**: NodeNext, **ModuleResolution**: NodeNext
- Use `interface` for object shapes/config types, `type` for unions and derived types
- **No `as any`**, `@ts-ignore`, or `@ts-expect-error`
- Declaration files: `declaration: true`, `declarationMap: true`

### Naming
- **Classes**: `PascalCase` — `WeChatOpencodeBridge`, `SessionManager`
- **Interfaces**: `PascalCase` — `WeChatOpencodeConfig`, `AgentPreset`
- **Functions/methods**: `camelCase` — `parseAgentCommand`, `handleMessage`
- **Constants**: `UPPER_SNAKE_CASE` — `BUILT_IN_AGENTS`, `TEXT_CHUNK_LIMIT`
- **Private fields**: `camelCase` with `private` modifier — `private config`, `private abortController`

### Error Handling
- Use `try/catch` with `String(err)` for safe error stringification
- **Best-effort catches**: Non-critical operations (typing indicators, state saves) use empty catches:
  ```ts
  } catch {
    // Typing is best-effort
  }
  ```
- **Throw** `Error` with descriptive messages for invalid input:
  ```ts
  throw new Error("Agent command cannot be empty");
  ```
- CLI errors use `console.error` + `process.exit(1)`

### Formatting
- **Indentation**: 2 spaces (tabs in some files — follow the file you're editing)
- **Semicolons**: Present (explicit `;` at statement ends)
- **String quotes**: Double quotes `"..."`
- **Template literals** for string interpolation

### Logging
- Accept optional `log: (msg: string) => void` parameter for testability
- Default logger prefixes with `[wechat-opencode]`
- Runtime logs include ISO timestamp: `[HH:MM:SS] message`

## Adding Features

1. **New agent preset**: Add entry to `BUILT_IN_AGENTS` in `src/config.ts`
2. **New message type**: Update `MessageType` enum in `src/weixin/types.ts`, add handling in `src/adapter/inbound.ts`
3. **New CLI option**: Add to `parseArgs()` in `bin/wechat-opencode.ts`, update `usage()`, pass through to config

## Constraints

- **Direct messages only** — group chats are intentionally ignored
- **Permission requests are auto-approved** — all agent permission requests are auto-allowed
- **One agent per user** — managed by `SessionManager` with idle timeout and max concurrent limits
- **Runtime state** stored in `~/.wechat-opencode/` (auth tokens, daemon PID, logs, user states)

## WeChat Commands

### Workspace (/workspace or /ws)
| Command | Description |
|---------|-------------|
| `/workspace list` | List all directories from OpenCode sessions |
| `/workspace switch <n\|path>` | Switch to directory by index or path |
| `/workspace add /path [name]` | Add directory (creates if not exists) |
| `/workspace status` | Show current directory |

### Session (/session or /s)
| Command | Description |
|---------|-------------|
| `/session list` | List recent 10 sessions with directory |
| `/session list --cwd` | List sessions in current workspace only |
| `/session list <path\|n>` | List sessions filtered by workspace path or index |
| `/session switch <n\|slug>` | Switch to session by index or slug |
| `/session new` | Restart session (clear context) |
| `/session status` | Show current session info |

### Agent (/agent or /a)
| Command | Description |
|---------|-------------|
| `/agent list` | List available agent modes (Build, Plan, etc.) with index |
| `/agent switch <name\|n>` | Switch agent mode by name or index |
| `/agent status` | Show current agent mode |

### Model (/model)
| Command | Description |
|---------|-------------|
| `/model list` | List all providers with model counts |
| `/model list <provider>` | List models for a specific provider |
| `/model switch <provider/model\|n>` | Switch model by full name or index (last queried provider) |
| `/model status` | Show current model |

### Reasoning (/reasoning)
| Command | Description |
|---------|-------------|
| `/reasoning list` | List available reasoning levels |
| `/reasoning switch <level>` | Switch reasoning level |
| `/reasoning status` | Show current reasoning level |

### Help
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |

## References

- **OpenCode** — https://github.com/anomalyco/opencode
  The AI agent this project bridges to. Source for ACP protocol details, tool definitions, and agent behavior.
- **OpenClaw Weixin** — https://github.com/Tencent/openclaw-weixin
  Official WeChat iLink API reference implementation. Authoritative source for image/file/video sending patterns, `image_item` vs `file_item` structures, CDN upload flows, and `mid_size` (ciphertext size) usage.
- **OpenCode Docs** — https://opencode.ai/docs/
  Official documentation for OpenCode configuration, tool registration, and agent customization.
  **ACP Docs** https://agentclientprotocol.com/
  ACP Server Protocol which OpenCode useing.