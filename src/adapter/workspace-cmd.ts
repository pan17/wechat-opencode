/**
 * Parse workspace and session commands from WeChat messages.
 *
 * Workspace commands (/workspace or /ws):
 *   list                          — List all workspaces
 *   add /path [name]              — Add a workspace
 *   switch <name|id>              — Switch to a workspace
 *   remove <name|id>              — Remove a workspace
 *   status                        — Show current workspace
 *
 * Session commands (/session or /s):
 *   new [name]                    — Create a new session
 *   switch <name|id>              — Switch to an existing session
 *   remove <name|id>              — Remove a session
 *   list                          — List all sessions
 *   status                        — Show current session info
 */

export interface WorkspaceCommand {
  kind: "list" | "add" | "switch" | "remove" | "status";
  path?: string;
  name?: string;
}

export interface SessionCommand {
  kind: "new" | "switch" | "remove" | "list" | "status";
  name?: string;
  cwdFilter?: string;  // When set, filter sessions by this cwd
}

export interface AgentCommand {
  kind: "list" | "switch" | "status";
  name?: string;
}

export interface ModelCommand {
  kind: "list" | "switch" | "status";
  name?: string;
  provider?: string;
}

export interface ReasoningCommand {
  kind: "list" | "switch" | "status";
  name?: string;
}

export function parseWorkspaceCommand(text: string): WorkspaceCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:workspace|ws)\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls":
      return { kind: "list" };

    case "status":
    case "current":
      return { kind: "status" };

    case "add": {
      const pathArg = args[1];
      if (!pathArg) return null;
      return { kind: "add", path: pathArg, name: args.slice(2).join(" ") || undefined };
    }

    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }

    case "remove":
    case "rm":
    case "delete":
    case "del": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "remove", name: target };
    }

    default:
      return null;
  }
}

export function parseSessionCommand(text: string): SessionCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:session|s)\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "new":
    case "create":
      return { kind: "new", name: args.slice(1).join(" ") || undefined };

    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }

    case "remove":
    case "rm":
    case "delete":
    case "del": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "remove", name: target };
    }

    case "list":
    case "ls": {
      // /s list                  → no filter
      // /s list --cwd            → filter by current workspace
      // /s list /path/to/cwd     → filter by specific cwd
      // /s list N                → filter by workspace at index N (resolved by bridge)
      const hasCwdFlag = args.includes("--cwd");
      let cwdFilter: string | undefined;
      if (hasCwdFlag) {
        cwdFilter = "__current__";
      } else if (args.length > 1) {
        // Take everything after "list" as the filter value
        const filterValue = args.slice(1).join(" ");
        if (filterValue) cwdFilter = filterValue;
      }
      return { kind: "list", cwdFilter };
    }

    case "status":
    case "current":
    case "info":
      return { kind: "status" };

    default:
      return null;
  }
}

export function parseAgentCommand(text: string): AgentCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/agent\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseModelCommand(text: string): ModelCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/model\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls": {
      const provider = args.slice(1).join(" ").trim() || undefined;
      return { kind: "list", provider };
    }
    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseReasoningCommand(text: string): ReasoningCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/reasoning\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function formatWorkspaceList(
  workspaces: Array<{ id: string; name: string; cwd: string }>,
  activeId: string | null,
): string {
  if (workspaces.length === 0) return "No workspaces configured.";

  const lines = ["📂 Workspaces:"];
  for (const ws of workspaces) {
    const prefix = ws.id === activeId ? "▶ " : "  ";
    lines.push(`${prefix}${ws.name} (${ws.id})`);
    lines.push(`   ${ws.cwd}`);
  }
  return lines.join("\n");
}

export function formatWorkspaceStatus(name: string, id: string, cwd: string): string {
  return `📂 Current workspace:\n  ${name} (${id})\n  ${cwd}`;
}

export function formatSessionList(
  sessions: Array<{ id: string; name: string; workspaceId: string; workspaceName?: string }>,
  activeId: string | null,
  workspaces: Array<{ id: string; name: string }> = [],
): string {
  if (sessions.length === 0) return "No sessions.";

  // Group sessions by workspace
  const wsMap = new Map<string, { name: string; sessions: Array<{ id: string; name: string; workspaceId: string; workspaceName?: string }> }>();
  for (const s of sessions) {
    const wsName = s.workspaceName || s.workspaceId;
    if (!wsMap.has(s.workspaceId)) {
      const ws = workspaces.find((w) => w.id === s.workspaceId);
      wsMap.set(s.workspaceId, { name: ws?.name ?? wsName, sessions: [] });
    }
    wsMap.get(s.workspaceId)!.sessions.push(s);
  }

  const lines: string[] = [];
  for (const [wsId, group] of wsMap) {
    lines.push(`📂 ${group.name} (${wsId}):`);
    for (const s of group.sessions) {
      const prefix = s.id === activeId ? "  ▶ " : "    ";
      lines.push(`${prefix}${s.name} (${s.id})`);
    }
  }
  return lines.join("\n");
}

export function formatSessionStatus(
  sessionName: string,
  sessionId: string,
  workspaceName: string,
  workspaceId: string,
): string {
  return `💬 Current session:\n  ${sessionName} (${sessionId})\n  Workspace: ${workspaceName} (${workspaceId})`;
}

/**
 * Check if a message is a help command.
 */
export function parseHelpCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/help" || trimmed === "/h" || trimmed === "/?";
}

/**
 * Format the help message listing all available commands.
 */
export function formatHelp(): string {
  return [
    "📖 Available Commands:",
    "",
    "── Workspaces ──",
    "  /workspace list          List all workspaces",
    "  /workspace add /path [name]  Add a workspace",
    "  /workspace switch <n|path> Switch to workspace by index or path (loads most recent session)",
    "  /workspace remove <name> Remove a workspace",
    "  /workspace status        Show current workspace",
    "  (shorthand: /ws ...)",
    "",
    "── Sessions ──",
    "  /session new [name]      Create a new session",
    "  /session switch <n|slug> Switch to session by index or slug/title",
    "  /session remove <name>   Remove a session",
    "  /session list            List all sessions",
    "  /session list --cwd      List sessions in current workspace",
    "  /session list <path|n>   List sessions by workspace path or index",
    "  /session status          Show current session",
    "  (shorthand: /s ...)",
    "",
    "── Agent / Model / Reasoning ──",
    "  /agent list              List available agents (build, plan, etc.)",
    "  /agent switch <id>       Switch agent mode",
    "  /agent status            Show current agent",
    "  (shorthand: /a ...)",
    "",
    "  /model list              List available models",
    "  /model switch <provider/model>  Switch model",
    "  /model status            Show current model",
    "",
    "  /reasoning list          List reasoning levels",
    "  /reasoning switch <level>  Switch reasoning level",
    "  /reasoning status        Show current reasoning level",
    "",
    "── Help ──",
    "  /help                    Show this help message",
  ].join("\n");
}

/**
 * Format help message including OpenCode native slash commands from available_commands_update.
 */
export function formatHelpWithNativeCommands(nativeCommands: Array<{ name: string; description: string }>): string {
  const lines = [
    "📖 Available Commands:",
    "",
    "── Bridge Commands ──",
    "  /workspace list          List all workspaces",
    "  /workspace add /path [name]  Add a workspace",
    "  /workspace switch <n|path> Switch to workspace by index or path",
    "  /workspace status        Show current workspace",
    "  (shorthand: /ws ...)",
    "",
    "  /session new             Create a new session",
    "  /session switch <n|slug> Switch to session by index or slug/title",
    "  /session list            List all sessions",
    "  /session list --cwd      List sessions in current workspace",
    "  /session list <path|n>   List sessions by workspace path or index",
    "  /session status          Show current session",
    "  (shorthand: /s ...)",
    "",
    "── Agent / Model / Reasoning ──",
    "  /agent list              List available agents (build, plan, etc.)",
    "  /agent switch <id>       Switch agent mode",
    "  /agent status            Show current agent",
    "  (shorthand: /a ...)",
    "",
    "  /model list              List available models",
    "  /model switch <provider/model>  Switch model",
    "  /model status            Show current model",
    "",
    "  /reasoning list          List reasoning levels",
    "  /reasoning switch <level>  Switch reasoning level",
    "  /reasoning status        Show current reasoning level",
    "",
    "  /help                    Show this help message",
  ];

  if (nativeCommands.length > 0) {
    lines.push("");
    lines.push("── OpenCode Agent Commands ──");
    for (const cmd of nativeCommands) {
      lines.push(`  /${cmd.name}`);
    }
  }

  return lines.join("\n");
}
