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
    case "ls":
      return { kind: "list" };

    case "status":
    case "current":
    case "info":
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
    "  /workspace switch <name> Switch to a workspace",
    "  /workspace remove <name> Remove a workspace",
    "  /workspace status        Show current workspace",
    "  (shorthand: /ws ...)",
    "",
    "── Sessions ──",
    "  /session new [name]      Create a new session",
    "  /session switch <name>   Switch to an existing session",
    "  /session remove <name>   Remove a session",
    "  /session list            List all sessions",
    "  /session status          Show current session",
    "  (shorthand: /s ...)",
    "",
    "── Help ──",
    "  /help                    Show this help message",
  ].join("\n");
}
