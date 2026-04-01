# WeChat OpenCode

Bridge WeChat direct messages to opencode.

`wechat-opencode` logs in with the WeChat iLink bot API, polls incoming 1:1 messages, forwards them to opencode over stdio, and sends the agent reply back to WeChat.

<img src="./resources/screenshot.jpg" alt="wechat-opencode screenshot" width="400" />

## Features

- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in ACP agent presets for common CLIs
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats are ignored
- Background daemon mode
- File sending: agent can send files/images back to WeChat via the `send-wechat` tool
- Automatic model config forwarding for opencode agents

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- [OpenCode](https://github.com/anomalyco/opencode) installed locally or via `npx`

## Installation

Clone this repository and install dependencies:

```bash
git clone https://github.com/pan17/wechat-opencode.git
cd wechat-opencode
npm install
npm run build
```

The `npm install` step automatically installs the `send-wechat` tool to `~/.config/opencode/tools/send-wechat.ts`.

## Quick Start

> **Important**: Run the bridge from your **working directory** (e.g. your project folder), **not** from the `wechat-opencode` installation directory. Running from the install directory may cause conflicts.

Start with a built-in agent preset:

```bash
cd /path/to/your/workdir
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js --agent opencode
```

Or use a raw custom command:

```bash
cd /path/to/your/workdir
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js --agent "npx my-agent --acp"
```

On first run, the bridge will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the login token under `~/.wechat-opencode`
4. Begin polling direct messages

## Built-in Agent Presets

List the bundled presets:

```bash
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js agents
```

Current presets:

- `opencode`

These presets resolve to concrete `command + args` pairs internally, so users do not need to type long `npx ...` commands.

## CLI Usage

```text
wechat-opencode --agent <preset|command> [options]
wechat-opencode agents
wechat-opencode stop
wechat-opencode status
```

Options:

- `--agent <value>`: built-in preset name or raw agent command
- `--cwd <dir>`: working directory for the agent process
- `--login`: force QR re-login and replace the saved token
- `--daemon`: run in background after startup
- `--config <file>`: load JSON config file
- `--idle-timeout <minutes>`: session idle timeout, default `1440` (use `0` for unlimited)
- `--max-sessions <count>`: maximum concurrent user sessions, default `10`
- `--show-thoughts`: forward agent thinking to WeChat (default: off)
- `-h, --help`: show help

Examples:

```bash
cd /path/to/your/workdir
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js --agent opencode
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js --agent opencode --cwd D:\code\project
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js --agent "npx opencode-ai acp"
node /path/to/wechat-opencode/dist/bin/wechat-opencode.js --agent opencode --daemon
```

## Configuration File

You can provide a JSON config file with `--config`.

Example:

```json
{
  "agent": {
    "preset": "opencode",
    "cwd": "D:/code/project"
  },
  "session": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentUsers": 10
  }
}
```

You can also override or add agent presets:

```json
{
  "agent": {
    "preset": "my-agent"
  },
  "agents": {
    "my-agent": {
      "label": "My Agent",
      "description": "Internal team agent",
      "command": "npx",
      "args": ["my-agent-cli", "--acp"]
    }
  }
}
```

## Runtime Behavior

- Each WeChat user gets a dedicated ACP session and subprocess.
- Messages are processed serially per user.
- Replies are formatted for WeChat before sending.
- Typing indicators are sent when supported by the WeChat API.
- Sessions are cleaned up after inactivity (set `idleTimeoutMs` to `0` to disable idle cleanup).
- Switching workspace or session kills the old agent and spawns a new one immediately.
- OpenCode session history is resumed via `unstable_resumeSession()` when switching to an existing session.

## WeChat Commands

Users can manage workspaces and sessions directly from WeChat:

### Workspace (`/workspace` or `/ws`)
| Command | Description |
|---------|-------------|
| `/workspace list` | List all directories from OpenCode sessions |
| `/workspace switch <n\|path>` | Switch to directory by index or path |
| `/workspace add /path` | Add directory (creates if not exists) |
| `/workspace status` | Show current directory |

### Session (`/session` or `/s`)
| Command | Description |
|---------|-------------|
| `/session list` | List recent 10 sessions with directory |
| `/session switch <n\|slug>` | Switch to session by index or slug |
| `/session new` | Restart session (clear context) |
| `/session status` | Show current session info |

### Help
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
- Switching workspace or session kills the old agent and spawns a new one immediately.
- OpenCode session history is resumed via `unstable_resumeSession()` when switching to an existing session.

## WeChat Commands

Users can manage workspaces and sessions directly from WeChat:

### Workspace (`/workspace` or `/ws`)
| Command | Description |
|---------|-------------|
| `/workspace list` | List all directories from OpenCode sessions |
| `/workspace switch <n\|path>` | Switch to directory by index or path |
| `/workspace add /path` | Add directory (creates if not exists) |
| `/workspace status` | Show current directory |

### Session (`/session` or `/s`)
| Command | Description |
|---------|-------------|
| `/session list` | List recent 10 sessions with directory |
| `/session switch <n\|slug>` | Switch to session by index or slug |
| `/session new` | Restart session (clear context) |
| `/session status` | Show current session info |

### Help
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |

## Storage

By default, runtime files are stored under:

```text
~/.wechat-opencode
```

This directory is used for:

- saved login token
- auth tokens
- tempfile (downloaded media)
- daemon pid file
- daemon log file
- sync state
- bridge state (`.wechat-bridge-state.json` — tracks last active user/session for the `send-wechat` tool)

## Custom Tool: send-wechat

After `npm install`, a `send-wechat` tool is automatically installed to `~/.config/opencode/tools/send-wechat.ts`.

This tool is available to opencode agents and lets them send files back to WeChat:

```
send-wechat(filePath: string)
```

The tool reads `~/.wechat-opencode/.wechat-bridge-state.json` to automatically determine the target user and session. The agent only needs to provide the file path.

## Current Limitations

- Direct messages only; group chats are ignored
- Permission requests are auto-approved
- Some preset agents may require separate authentication before they can respond successfully

## Development

For local development:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/bin/wechat-opencode.js --help
```

Watch mode:

```bash
npm run dev
```

## License

MIT
