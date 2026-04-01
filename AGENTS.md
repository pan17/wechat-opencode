# AGENTS.md — wechat-opencode

> Bridge WeChat direct messages to any ACP-compatible AI agent.

## Project Overview

- **Package**: `wechat-opencode` v0.1.2 — ESM-only (`"type": "module"`)
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
src/index.ts               — Public API exports
src/bridge.ts              — Main orchestrator (WeChat poll ↔ ACP sessions)
src/config.ts              — Config types, defaults, agent preset registry
src/vendor.d.ts            — Type declarations for untyped npm packages
src/acp/                   — ACP protocol: session management, client, agent manager
src/adapter/               — Message format adapters (inbound/outbound)
src/weixin/                — WeChat iLink API: auth, monitor, send, media, types
```

### Key flows
1. **CLI** parses args → resolves agent preset → creates `WeChatOpencodeBridge`
2. **Bridge** handles QR login → starts `SessionManager` → begins WeChat long-poll
3. **SessionManager** spawns one ACP subprocess per WeChat user
4. **Adapters** convert WeChat messages ↔ ACP prompt format and back

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
- **No MCP servers** — agent communication is stdio-only
- **Auto-approve permissions** — all agent permission requests are auto-allowed
- **One session per user** — managed by `SessionManager` with idle timeout and max concurrent limits
- **Runtime state** stored in `~/.wechat-opencode/` (auth tokens, daemon PID, logs)
