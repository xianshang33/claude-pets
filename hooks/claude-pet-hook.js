#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const defaultBridgePort = "38987";
const defaultHookTimeoutMs = 750;
const defaultPermissionTimeoutMs = 30_000;
const maxStdinBytes = 256 * 1024;
const maxTranscriptTailBytes = 256 * 1024;
const maxResponseSummaryLength = 500;
const maxProcessTreeDepth = 8;
const terminalNames = new Set(
  process.platform === "win32"
    ? [
        "windowsterminal.exe",
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "code.exe",
        "cursor.exe",
        "alacritty.exe",
        "wezterm-gui.exe",
        "kitty.exe",
        "ghostty.exe"
      ]
    : process.platform === "linux"
      ? [
          "gnome-terminal",
          "kgx",
          "konsole",
          "xfce4-terminal",
          "tilix",
          "alacritty",
          "wezterm",
          "wezterm-gui",
          "kitty",
          "ghostty",
          "xterm",
          "lxterminal",
          "terminator",
          "code",
          "cursor"
        ]
      : ["terminal", "iterm2", "alacritty", "wezterm-gui", "kitty", "ghostty", "code", "cursor"]
);
const systemBoundaryNames = new Set(
  process.platform === "win32" ? ["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"] : ["launchd", "init", "systemd"]
);
const editorNames = new Map([
  ["code", "code"],
  ["code.exe", "code"],
  ["code-insiders", "code"],
  ["cursor", "cursor"],
  ["cursor.exe", "cursor"]
]);

main().catch(() => {
  process.exitCode = 0;
});

async function main() {
  const rawInput = await readStdin();
  const event = parseJson(rawInput);
  if (!event) {
    return;
  }

  const bridgeUrl = getBridgeUrl();
  if (!bridgeUrl) {
    return;
  }
  const eventWithContext = withLocalContext(event);
  const hookEventName = getHookEventName(eventWithContext);

  if (hookEventName !== "PermissionRequest") {
    await ignoreErrors(() =>
      postJson(bridgeUrl, "/hook", eventWithContext, getTimeoutMs("CLAUDE_PET_HOOK_TIMEOUT_MS", defaultHookTimeoutMs))
    );
    return;
  }

  const response = await ignoreErrors(() =>
    postJson(
      bridgeUrl,
      "/permission-request",
      eventWithContext,
      getTimeoutMs("CLAUDE_PET_PERMISSION_TIMEOUT_MS", defaultPermissionTimeoutMs)
    )
  );
  const decision = normalizeDecision(response && response.decision);
  if (!decision) {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision
      }
    })
  );
}

function getBridgeUrl() {
  if (process.env.CLAUDE_PET_BRIDGE_URL) {
    return normalizeLoopbackBridgeUrl(process.env.CLAUDE_PET_BRIDGE_URL);
  }

  const port = process.env.CLAUDE_PET_BRIDGE_PORT || defaultBridgePort;
  return normalizeLoopbackBridgeUrl(`http://127.0.0.1:${port}`);
}

function normalizeLoopbackBridgeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:") {
    return null;
  }

  if (!isLoopbackHost(url.hostname)) {
    return null;
  }

  return url.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function getHookEventName(event) {
  return typeof event.hook_event_name === "string"
    ? event.hook_event_name
    : typeof event.hookEventName === "string"
      ? event.hookEventName
      : "";
}

function withLocalContext(event) {
  const hasWorkingDirectory =
    hasString(event.cwd) ||
    hasString(event.current_working_directory) ||
    hasString(event.currentWorkingDirectory) ||
    hasString(event.project_dir) ||
    hasString(event.projectDir) ||
    hasString(event.workspace);
  const terminal = event.terminal && typeof event.terminal === "object" ? event.terminal : detectTerminalContext();
  const processContext = hasProcessContext(event) ? {} : detectProcessContext();
  const responseContext = hasResponseSummary(event) ? {} : detectResponseContext(event);

  if (hasWorkingDirectory && !terminal && Object.keys(processContext).length === 0 && Object.keys(responseContext).length === 0) {
    return event;
  }

  return {
    ...event,
    ...(!hasWorkingDirectory ? { cwd: process.cwd() } : {}),
    ...(terminal ? { terminal } : {}),
    ...processContext,
    ...responseContext
  };
}

function hasString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasResponseSummary(event) {
  return hasString(event.response_summary) || hasString(event.responseSummary);
}

function detectResponseContext(event) {
  const hookEventName = getHookEventName(event);
  if (hookEventName !== "Stop" || isFailureStatus(event)) {
    return {};
  }

  const transcriptPath = stringOrNull(event.transcript_path) || stringOrNull(event.transcriptPath);
  const responseSummary = transcriptPath ? extractLatestAssistantResponseFromTranscript(transcriptPath) : null;
  return responseSummary ? { response_summary: responseSummary } : {};
}

function isFailureStatus(event) {
  const status = stringOrNull(event.status || event.outcome || event.result);
  return Boolean(event.error || event.is_error === true || event.failed === true || status === "failed" || status === "failure" || status === "error");
}

function extractLatestAssistantResponseFromTranscript(transcriptPath) {
  const filePath = path.resolve(transcriptPath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  let content;
  try {
    const length = Math.min(stat.size, maxTranscriptTailBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      content = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  if (stat.size > maxTranscriptTailBytes) {
    lines.shift();
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    const entry = parseJson(line);
    const text = entry ? extractAssistantText(entry) : null;
    if (text) {
      return truncateResponseSummary(text);
    }
  }

  return null;
}

function extractAssistantText(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const message = entry.message && typeof entry.message === "object" ? entry.message : null;
  const role = stringOrNull(entry.role) || (message ? stringOrNull(message.role) : null);
  const type = stringOrNull(entry.type);
  if (role !== "assistant" && type !== "assistant") {
    return null;
  }

  const content = entry.content !== undefined ? entry.content : message ? message.content : undefined;
  return collectTextContent(content);
}

function collectTextContent(content) {
  if (typeof content === "string") {
    return normalizeResponseText(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    if ((item.type === "text" || item.type === "reasoning") && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return normalizeResponseText(parts.join(" "));
}

function normalizeResponseText(value) {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return compact || null;
}

function truncateResponseSummary(value) {
  if (value.length <= maxResponseSummaryLength) {
    return value;
  }

  return `${value.slice(0, maxResponseSummaryLength - 1)}…`;
}

function detectTerminalContext() {
  const termProgram = stringOrNull(process.env.TERM_PROGRAM);
  const term = stringOrNull(process.env.TERM);
  const appName = terminalAppNameFromEnv(termProgram, term);

  if (!appName && !termProgram && (!term || term === "dumb")) {
    return null;
  }

  return {
    appName,
    termProgram,
    term
  };
}

function terminalAppNameFromEnv(termProgram, term) {
  const normalizedProgram = (termProgram || "").toLowerCase();
  const normalizedTerm = (term || "").toLowerCase();

  if (normalizedProgram === "apple_terminal") {
    return "Terminal";
  }
  if (normalizedProgram.includes("iterm")) {
    return "iTerm";
  }
  if (normalizedProgram.includes("ghostty") || normalizedTerm === "xterm-ghostty") {
    return "Ghostty";
  }
  if (normalizedProgram.includes("wezterm")) {
    return "WezTerm";
  }
  if (normalizedProgram.includes("kitty")) {
    return "kitty";
  }
  if (normalizedProgram.includes("alacritty")) {
    return "Alacritty";
  }

  return null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasProcessContext(event) {
  return Number.isInteger(event.source_pid) || Number.isInteger(event.sourcePid) || Number.isInteger(event.agent_pid) || Number.isInteger(event.agentPid);
}

function detectProcessContext() {
  const context = resolveProcessTree();
  const result = {};
  if (context.sourcePid) result.source_pid = context.sourcePid;
  if (context.agentPid) {
    result.agent_pid = context.agentPid;
    result.headless = isHeadlessClaudeProcess(context.agentPid);
  }
  if (context.editor) result.editor = context.editor;
  if (context.pidChain.length > 0) result.pid_chain = context.pidChain;
  return result;
}

function resolveProcessTree(startPid = process.ppid) {
  let pid = startPid;
  let lastGoodPid = Number.isInteger(pid) && pid > 0 ? pid : null;
  let terminalPid = null;
  let agentPid = null;
  let editor = null;
  const pidChain = [];

  for (let depth = 0; depth < maxProcessTreeDepth && Number.isInteger(pid) && pid > 0; depth += 1) {
    const info = readProcessInfo(pid);
    if (!info) {
      break;
    }

    pidChain.push(pid);
    const name = info.name;
    if (!editor) {
      editor = editorNames.get(name) ?? detectEditorFromCommand(info.command);
    }
    if (!agentPid && (name === "claude" || name === "claude.exe" || isClaudeNodeCommand(name, info.command))) {
      agentPid = pid;
    }
    if (systemBoundaryNames.has(name)) {
      break;
    }
    if (terminalNames.has(name)) {
      terminalPid = pid;
    }

    lastGoodPid = pid;
    if (!info.parentPid || info.parentPid === pid || info.parentPid <= 1) {
      break;
    }
    pid = info.parentPid;
  }

  return {
    sourcePid: terminalPid || lastGoodPid,
    agentPid,
    editor,
    pidChain
  };
}

function readProcessInfo(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "Name,ParentProcessId,CommandLine", "/format:csv"], {
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true
      });
      const lines = out.trim().split(/\r?\n/).filter((line) => line.includes(","));
      const line = lines[lines.length - 1];
      if (!line) return null;
      const parts = line.split(",");
      return {
        command: parts.slice(1, -2).join(",").trim(),
        name: path.basename((parts[parts.length - 2] || "").trim()).toLowerCase(),
        parentPid: Number.parseInt(parts[parts.length - 1], 10)
      };
    }

    const parentPid = Number.parseInt(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim(), 10);
    const commandPath = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
    return {
      command,
      name: path.basename(commandPath).toLowerCase(),
      parentPid
    };
  } catch {
    return null;
  }
}

function detectEditorFromCommand(command) {
  const normalized = (command || "").toLowerCase();
  if (normalized.includes("visual studio code")) return "code";
  if (normalized.includes("cursor.app")) return "cursor";
  return null;
}

function isClaudeNodeCommand(name, command) {
  return (name === "node" || name === "node.exe") && (command.includes("claude-code") || command.includes("@anthropic-ai"));
}

function isHeadlessClaudeProcess(pid) {
  const info = readProcessInfo(pid);
  return info ? /\s(-p|--print)(\s|$)/.test(` ${info.command} `) : false;
}

function getTimeoutMs(envName, fallback) {
  const value = Number(process.env[envName]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(25, Math.round(value));
}

async function ignoreErrors(callback) {
  try {
    return await callback();
  } catch {
    return null;
  }
}

function normalizeDecision(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (value.behavior === "allow") {
    return { behavior: "allow" };
  }

  if (value.behavior !== "deny") {
    return null;
  }

  return {
    behavior: "deny",
    ...(typeof value.message === "string" && value.message.trim() ? { message: value.message.trim().slice(0, 500) } : {}),
    ...(value.interrupt === true ? { interrupt: true } : {})
  };
}

function postJson(baseUrl, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, baseUrl);
    } catch (cause) {
      reject(cause);
      return;
    }

    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size <= 64 * 1024) {
            chunks.push(buffer);
          }
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            resolve(null);
            return;
          }

          const responseBody = Buffer.concat(chunks).toString("utf8");
          resolve(responseBody ? parseJson(responseBody) : null);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Claude Pets bridge request timed out"));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;

    process.stdin.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size <= maxStdinBytes) {
        chunks.push(buffer);
      }
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.resume();
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
