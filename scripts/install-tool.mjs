/**
 * Postinstall: copy send-wechat tool to global opencode tools directory.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = path.join(import.meta.dirname, "..", ".opencode", "tools", "send-wechat.ts");
const dstDir = path.join(os.homedir(), ".config", "opencode", "tools");
const dst = path.join(dstDir, "send-wechat.ts");

fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, dst);
console.log("[wechat-bridge-opencode] Installed send-wechat tool to", dst);
