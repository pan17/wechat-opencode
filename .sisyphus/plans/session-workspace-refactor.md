# 重构计划：Session/Workspace 管理

## 问题陈述

当前架构每次切换 workspace 或 session 都 kill + respawn agent 进程，这是方向性错误。ACP 协议设计上支持在单一进程内管理多个 session，`cwd` 是 session 级别参数而非进程级别。

## 当前架构（错误）

```
1 WeChat用户 → 1 Agent进程 → 1 Session
切换 = kill process → spawn new → ACP init → newSession/loadSession
```

## 目标架构（正确）

```
1 WeChat用户 → 1 Agent进程 → N Sessions (通过协议切换)
切换 = session/new 或 session/load (无需重启进程)
```

## ACP 协议方法映射

| 用户操作 | 当前做法 | 新做法 |
|----------|---------|--------|
| 首次发消息 | spawn + init + newSession | 不变（仍需 spawn） |
| `/workspace switch` | kill + spawn + init + newSession | `session/new(cwd=新目录)` |
| `/session switch` | kill + spawn + init + resumeSession | `session/load(sessionId=目标)` |
| `/session new` | kill + spawn + init + newSession | `session/new(cwd=当前目录)` |
| `/workspace list` | 读 OpenCode SQLite | `session/list` (ACP) |
| `/session list` | 读 OpenCode SQLite | `session/list` (ACP) |
| 空闲超时 | kill agent process | `session/close` (ACP) |

## 能力检测

在 `agent-manager.ts` 的 `initialize` 响应中检测：

```typescript
agentCapabilities: {
  loadSession: boolean;        // 必须为 true，否则报错
  sessionCapabilities?: {
    list?: {};                 // 可选，用于 session/list
    close?: {};                // 可选，用于 session/close
  };
}
```

**策略**：如果 `loadSession !== true`，在 spawnAgent 时直接 throw Error，要求用户升级 OpenCode。

## 文件变更清单

### 1. `src/acp/agent-manager.ts` — 重大修改

**改动**：
- `spawnAgent()` 返回的 `AgentProcessInfo` 增加 `agentCapabilities` 字段
- 保存 `initialize` 的完整响应（包含 agentCapabilities）
- 增加 `loadSession` 能力检测，不支持则 throw Error
- `killAgent()` 保留（用于 bridge stop 和异常处理）

**新增导出**：
```typescript
export interface AgentCapabilities {
  loadSession: boolean;
  sessionCapabilities?: {
    list?: {};
    close?: {};
  };
}

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  capabilities: AgentCapabilities;  // 新增
}
```

### 2. `src/acp/session.ts` — 核心重写

**当前结构**：
- `UserSession` 包含一个 agent process + 一个 session
- `switchWorkspace()` = kill + spawn
- `restartSession()` = kill + spawn
- `createSession()` = spawn + init + newSession

**新结构**：
- `UserSession` 包含一个 agent process + 一个 **当前活跃 sessionId** + 一个 **sessions Map**（追踪该用户的所有 session）
- 新增 `switchSession(userId, sessionId, cwd?)` — 调用 `connection.session/load` 或 `session/new`
- 新增 `switchWorkspace(userId, cwd)` — 调用 `session/new({ cwd })`
- 新增 `listSessions(userId)` — 调用 `connection.session/list`
- 删除 `restartSession()` — 替换为 `switchSession()` 创建新 session
- 删除 `switchWorkspace()` 的 kill+spawn 逻辑
- `processQueue()` 中使用当前活跃 sessionId 发送 prompt

**新 `UserSession` 结构**：
```typescript
export interface UserSession {
  userId: string;
  contextToken: string;
  client: WeChatAcpClient;
  process: ChildProcess;          // 单一 agent 进程
  connection: acp.ClientSideConnection;
  capabilities: AgentCapabilities;
  activeSessionId: string;        // 当前活跃的 session
  sessions: Map<string, { cwd: string; title?: string }>;  // 该用户的所有 session
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  createdAt: number;
  ready: boolean;
}
```

**新方法**：
```typescript
// 切换到已有 session（通过 session/load）
async switchSession(userId: string, contextToken: string, sessionId: string, cwd: string): Promise<void>

// 创建新 session（通过 session/new）
async createNewSession(userId: string, contextToken: string, cwd: string): Promise<string>

// 列出 sessions（通过 session/list）
async listAgentSessions(userId: string, cwd?: string): Promise<SessionInfo[]>

// 关闭指定 session（通过 session/close，如果支持）
async closeSession(userId: string, sessionId: string): Promise<void>
```

### 3. `src/bridge.ts` — 修改命令处理逻辑

**`handleDirectoryCommand()` 变更**：
- `list`: 调用 `sessionManager.listAgentSessions()` 替代 `listSessions()` (SQLite)
- `switch`: 调用 `sessionManager.switchWorkspace()` (协议方式) 替代 kill+spawn
- `add`: 同上，创建新 session 而非重启进程
- 删除对 `listSessions()` 的 SQLite 导入

**`handleSessionCommand()` 变更**：
- `list`: 调用 `sessionManager.listAgentSessions()` 替代 SQLite
- `switch`: 调用 `sessionManager.switchSession()` 加载已有 session
- `new`: 调用 `sessionManager.createNewSession()` 创建新 session
- `status`: 从 `sessionManager` 获取当前活跃 session 信息
- `remove`: 调用 `sessionManager.closeSession()` (如果支持)

**`start()` 变更**：
- `SessionManager` 的 `getExistingSessionId` 回调保留但行为改变：不再用于 spawn 时 resume，而是用于首次 `session/load`
- `onSessionReady` 回调简化

### 4. `src/acp/opencode-sessions.ts` — 标记废弃

- 保留文件但标记 `@deprecated`
- `listSessions()` 函数不再被 bridge.ts 使用
- 可作为 fallback 保留（如果 `session/list` 不可用）

### 5. `src/adapter/workspace-cmd.ts` — 无需改动

- 纯解析逻辑，不涉及实现

### 6. `src/acp/client.ts` — 小修改

- `sessionUpdate()` 需要处理新的 notification 类型：
  - `session_info_update` — session 元数据更新（title 等）
  - `config_option_update` — 配置变更通知
- 这些 notification 在 session/load 时会 replay，需要正确处理

## 迁移风险

### 风险 1：OpenCode 不支持 `session/load`
- **缓解**：spawnAgent 时检测 `loadSession` 能力，不支持直接抛错
- **影响**：用户使用旧版 OpenCode 会收到明确错误提示

### 风险 2：`session/load` 的 replay 行为
- ACP 规范：`session/load` 会 replay 整个对话历史作为 `session/update` notifications
- **处理**：WeChatAcpClient 在 session/load 期间需要忽略 replay 的 message chunks（这些是历史回放，不是新回复）
- **方案**：在 load 期间设置 `loading` 标志，忽略 replay 的 content chunks

### 风险 3：`session/list` 能力检测
- `session/list` 是可选能力（`sessionCapabilities.list`）
- **处理**：如果不支持，fallback 到现有 SQLite 读取方式

### 风险 4：多 session 的 prompt 路由
- `session/prompt` 需要指定 `sessionId`
- **处理**：`processQueue` 使用 `activeSessionId` 发送 prompt

### 风险 5：空闲超时
- 当前：kill 整个 agent process
- 新：调用 `session/close`（如果支持），否则保留 process 不操作
- **处理**：检测 `sessionCapabilities.close`，不支持则不清理（process 本身不占太多资源）

## 实施顺序

1. **agent-manager.ts** — 增加 capabilities 检测和返回
2. **client.ts** — 增加 session/load replay 处理、新 notification 类型
3. **session.ts** — 核心重写（最大改动）
4. **bridge.ts** — 修改命令处理逻辑
5. **opencode-sessions.ts** — 标记 deprecated
6. **集成测试** — 验证所有命令正常工作

## 成功标准

- [ ] `/workspace switch` 不再 kill + respawn agent 进程
- [ ] `/session switch` 不再 kill + respawn agent 进程
- [ ] `/session new` 不再 kill + respawn agent 进程
- [ ] `/workspace list` 和 `/session list` 通过 ACP `session/list` 获取
- [ ] 空闲超时使用 `session/close` 而非 kill process
- [ ] 如果 `loadSession` 不支持，启动时明确报错
- [ ] 所有 `lsp_diagnostics` 通过
- [ ] `npm run build` 通过
