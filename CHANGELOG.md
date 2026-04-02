# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.9] - 2026-04-03

### Added
- `/agent list` `/agent switch` `/agent status` — 通过 ACP 协议动态切换 Agent 模式（Build/Plan 等），支持序号和名称切换
- `/model list` `/model switch` `/model status` — 通过 ACP 协议动态切换模型，支持 list providers → list models 两级浏览，支持序号和完整名称切换
- `/reasoning list` `/reasoning switch` `/reasoning status` — 通过 ACP 协议动态切换推理级别

### Changed
- `/help` 动态显示 OpenCode Agent 当前可用的 slash commands（来自 `available_commands_update`）

### Fixed
- 未知 slash command（如 `/new`、`/compact` 等 OpenCode TUI 指令）不再静默透传，改为立即回复提示"⚠️ 指令 "/xxx" 不是 Bridge 内置指令，已转交 Agent 处理。"并继续转发至 Agent

## [0.1.7] - 2026-04-02

### Added
- `/session list --cwd` 和 `/session list <path|n>` 支持按工作区过滤会话
- GitHub Actions 自动 npm 发布流程（`release.yml`）
- `CHANGELOG.md` 维护发布日志

### Changed
- `/workspace switch` 和 `/workspace add` 自动加载目标工作区最近会话，而非创建新会话
- 会话/工作区切换从 kill+respawn 改为 ACP 协议调用（`session/new` / `session/load`），切换速度提升一个数量级
- 会话列表和切换使用 SQLite 作为权威数据源，过滤掉子 agent 会话（`parent_id IS NULL`）
- 切换消息时序优化：先显示 `🔄 Switching to`，切换完成后显示 `✅ Ready on`
- 更新 README 安装/使用说明，分离安装和使用两个章节
- 更新 AGENTS.md 同步最新架构和命令列表

### Fixed
- Agent 进程未启动时执行切换命令报错的问题

## [0.1.6]

- Fix session switch timing — send "Switching to" before the switch, "Ready on" after
- Filter sub-agent sessions from session list (`parent_id IS NULL`)
- Update AGENTS.md and README documentation

## [0.1.5]

- Optimize session and workspace management

## [0.1.2]

- Add `--show-thoughts` flag to forward agent thinking to WeChat (off by default)
- Stream thought messages in real-time at thought→tool and thought→message transitions
- Log all agent thought chunks to terminal for debugging

## 0.1.1

- Set default idle timeout to 1440 minutes (24 hours); use `--idle-timeout 0` for unlimited
- Send typing indicator immediately when prompt is received
- Cancel typing indicator after reply is delivered
- Add GitHub Actions CI workflow

## 0.1.0

- Initial release
- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in agent presets: copilot, claude, gemini, qwen, codex, opencode
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats ignored
- Background daemon mode with `--daemon`
- Config file support with `--config`
- Session idle timeout and max concurrent user limits
