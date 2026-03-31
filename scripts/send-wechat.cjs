#!/usr/bin/env node
/**
 * CLI tool to send files via wechat-opencode bridge.
 */

const API_URL = "http://127.0.0.1:18792/send-wechat";
const STATE_FILE = ".wechat-bridge-state.json";

const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/python",
  html: "text/html",
  css: "text/css",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  csv: "text/csv",
  log: "text/plain",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return MIME_TYPES[ext] || "application/octet-stream";
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (e) {
    // ignore
  }
  return {};
}

async function sendFile(filePath, userId, sessionId) {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    console.error("Error: File not found: " + absolutePath);
    process.exit(1);
  }

  const fileName = path.basename(absolutePath);
  const mimeType = getMimeType(absolutePath);

  const body = {
    filePath: absolutePath,
    mimeType: mimeType,
  };

  if (sessionId) {
    body.sessionId = sessionId;
  }

  if (userId) {
    body.userId = userId;
  }

  console.log("Sending " + fileName + " to " + (userId || "last user") + "...");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Error: " + (result.error || "HTTP " + response.status));
      process.exit(1);
    }

    console.log("Sent " + result.fileName + " successfully!");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED")) {
      console.error("Error: Cannot connect to bridge at " + API_URL);
      console.error("Is the wechat-opencode bridge running?");
    } else {
      console.error("Error: " + msg);
    }
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log("wechat-send-file CLI tool\n\nUsage:\n  node send-wechat.mjs <filePath> [userId]\n\nExamples:\n  node send-wechat.mjs \"F:\\\\normal\\\\report.pdf\"\n  node send-wechat.mjs \"F:\\\\normal\\\\image.png\" \"user123@im.wechat\"\n  node send-wechat.mjs \"F:\\\\normal\\\\doc.pdf\" --session ses_abc123\n\nOptions:\n  -h, --help     Show this help message\n  --session      Specify ACP session ID instead of user ID");
    process.exit(0);
  }

  const filePath = args[0];
  let userId = null;
  let sessionId = null;

  // Check for --session flag
  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1 && args[sessionIdx + 1]) {
    sessionId = args[sessionIdx + 1];
  }

  // If no --session, check if second arg is userId
  if (!sessionId && args[1] && !args[1].startsWith("--")) {
    userId = args[1];
  }

  // If no userId/sessionId, use last user from state
  if (!userId && !sessionId) {
    const state = loadState();
    if (state.lastUserId && state.lastSessionId) {
      userId = state.lastUserId;
      sessionId = state.lastSessionId;
      console.log("Using last active user: " + userId);
    } else {
      console.error("Error: No userId or sessionId specified and no previous session found.");
      console.error("Run bridge once first, or specify userId/sessionId explicitly.");
      process.exit(1);
    }
  }

  await sendFile(filePath, userId, sessionId);
}

main();
