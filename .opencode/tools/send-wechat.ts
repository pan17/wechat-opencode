/**
 * OpenCode custom tool: send files to WeChat.
 *
 * Place this file at:
 *   - Global:  ~/.config/opencode/tools/send-wechat.ts
 *   - Project: .opencode/tools/send-wechat.ts
 *
 * Tool name: send-wechat
 * Reads userId/sessionId from .wechat-bridge-state.json automatically.
 */

import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"

const API_URL = "http://127.0.0.1:18792/send-wechat"

/** Load state from ~/.wechat-opencode/.wechat-bridge-state.json */
function loadState(): { lastUserId?: string; lastSessionId?: string } {
  try {
    const stateFile = path.join(os.homedir(), ".wechat-opencode", ".wechat-bridge-state.json")
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    }
  } catch {
    // ignore
  }
  return {}
}

export default tool({
  description: "Send a file to the last active WeChat user through the wechat-opencode bridge. Use this to share files, images, PDFs, etc. with the WeChat contact.",
  args: {
    filePath: tool.schema.string().describe("Absolute path to the file to send (e.g., F:\\report.pdf)"),
  },
  async execute(args) {
    const absolutePath = path.resolve(args.filePath)

    // Validate file exists
    try {
      if (!fs.existsSync(absolutePath)) {
        return `Error: File not found: ${absolutePath}`
      }
      const stat = fs.statSync(absolutePath)
      if (!stat.isFile()) {
        return `Error: Not a file: ${absolutePath}`
      }
    } catch (err) {
      return `Error accessing file: ${err instanceof Error ? err.message : String(err)}`
    }

    // Load userId/sessionId from state file
    const state = loadState()
    if (!state.lastUserId && !state.lastSessionId) {
      return "Error: No active WeChat session found. Has anyone messaged you recently? The bridge must be running and have received at least one message."
    }

    const fileName = path.basename(absolutePath)

    // Call the bridge API
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: absolutePath,
          userId: state.lastUserId,
          sessionId: state.lastSessionId,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        return `Error: ${result.error || `HTTP ${response.status}`}`
      }

      return `Successfully sent "${result.fileName || fileName}" to WeChat user ${state.lastUserId}!`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("ECONNREFUSED")) {
        return `Error: Cannot connect to wechat-opencode bridge at 127.0.0.1:18792. Is the bridge running?`
      }
      return `Error: ${msg}`
    }
  },
})
