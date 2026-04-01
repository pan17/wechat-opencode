# WeChat OpenCode

将微信私聊消息桥接到 OpenCode。

<img src="./resources/screenshot.jpg" alt="wechat-bridge-opencode screenshot" width="400" />

## 功能

- **文本消息** — 微信与 OpenCode 之间的双向文本传输
- **图片传输** — 支持发送/接收图片，支持微信 CDN 下载
- **文件传输** — 支持任意类型文件收发
- **音视频传输** — 完整的音频和视频消息支持
- **二维码登录** — 终端渲染二维码，扫码登录微信
- **独立会话** — 每个微信用户拥有独立 ACP 会话
- **后台模式** — 使用 `--daemon` 参数后台运行
- **send-wechat 工具** — Agent 可直接发送文件/图片到微信

## 安装

```bash
npx wechat-bridge-opencode --agent opencode
```

或全局安装：

```bash
npm install -g wechat-bridge-opencode
wbo --agent opencode
```

## 使用

```bash
cd /path/to/your/project
npx wechat-bridge-opencode --agent opencode
```

首次运行会：
1. 终端显示二维码
2. 扫码登录微信
3. 保存登录令牌到 `~/.wechat-bridge-opencode`
4. 开始轮询微信私信

## 选项

| 参数 | 说明 |
|------|------|
| `--agent <预设\|命令>` | 内置预设或自定义命令 |
| `--cwd <目录>` | 工作目录 |
| `--login` | 强制重新登录 |
| `--daemon` | 后台运行 |
| `--config <文件>` | JSON 配置文件 |
| `--idle-timeout <分钟>` | 会话空闲超时（默认 1440，0 = 无限） |
| `--max-sessions <数量>` | 最大并发会话数（默认 10） |
| `--show-thoughts` | 将 Agent 思考过程转发到微信 |

## 微信命令

### 工作区（`/workspace` 或 `/ws`）

| 命令 | 说明 |
|------|------|
| `/workspace list` | 列出所有目录 |
| `/workspace switch <n\|路径>` | 切换目录 |
| `/workspace add /路径 [名称]` | 添加目录 |
| `/workspace status` | 显示当前目录 |

### 会话（`/session` 或 `/s`）

| 命令 | 说明 |
|------|------|
| `/session list` | 列出最近 10 个会话 |
| `/session switch <n\|slug>` | 切换会话 |
| `/session new` | 新会话（清除上下文） |
| `/session status` | 显示当前会话 |

## 环境要求

- Node.js 20+
- 微信 iLink 机器人 API 访问权限
- [OpenCode](https://github.com/anomalyco/opencode) 本地安装或通过 npx 运行

## 数据存储

运行时数据存储在 `~/.wechat-bridge-opencode`：
- 登录令牌
- 认证令牌
- 临时文件（下载的媒体）
- 守护进程 PID / 日志
- 桥接状态（`.wechat-bridge-state.json`）

## 注意事项

- 仅支持私信（群聊会被忽略）
- 权限请求自动批准
- `send-wechat` 工具自动安装到 `~/.config/opencode/tools/send-wechat.ts`

## 许可证

MIT
