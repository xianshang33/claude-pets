import type {
  ClaudeActivityCapabilityProvenance,
  ClaudeActivityConfidence,
  ClaudeActivityDerivationKind,
  ClaudeActivityDerivedPresentation,
  ClaudeActivityObservedFacts,
  ClaudeBridgePetState,
  ClaudeHookEventName,
  ClaudeTerminalContext,
  NormalizedClaudeEvent,
  NormalizedPermissionRequest
} from "../types";

const maxBodyLength = 140;
const maxPermissionBodyLength = 180;
const supportedHookEvents = new Set<ClaudeHookEventName>([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "PermissionRequest",
  "Stop",
  "StopFailure"
]);

type RawHookEvent = Record<string, unknown>;
type NormalizedEventBase = Omit<
  NormalizedClaudeEvent,
  "petState" | "title" | "body" | "observedFacts" | "derivedPresentation" | "capabilityProvenance"
>;

export function normalizeClaudeHookEvent(rawEvent: unknown): NormalizedClaudeEvent {
  const event = isRecord(rawEvent) ? rawEvent : {};
  const hookEventName = normalizeHookEventName(event.hook_event_name ?? event.hookEventName);
  const sessionId = getString(event.session_id ?? event.sessionId);
  const cwd = getString(
    event.cwd ?? event.current_working_directory ?? event.currentWorkingDirectory ?? event.workspace ?? event.project_dir ?? event.projectDir
  );
  const terminal = normalizeTerminalContext(event.terminal);
  const sourcePid = getPositiveInteger(event.source_pid ?? event.sourcePid);
  const agentPid = getPositiveInteger(event.agent_pid ?? event.agentPid ?? event.claude_pid ?? event.claudePid);
  const pidChain = getPositiveIntegerArray(event.pid_chain ?? event.pidChain);
  const editor = getString(event.editor);
  const headless = event.headless === true;
  const rawToolName = getString(event.tool_name ?? event.toolName);
  const toolName = rawToolName ?? "tool";
  const failed = isFailureHookEvent(hookEventName) || hasFailureSignal(event);
  const toolInputSummary = summarizeToolInput(event);
  const toolOutputSummary = summarizeToolOutput(event);
  const responseSummary = getString(event.response_summary ?? event.responseSummary);
  const failureReason = summarizeFailureReason(event);
  const message = getString(event.message) ?? getString(event.body);

  const base = {
    hookEventName,
    sessionId,
    cwd,
    terminal,
    sourcePid,
    agentPid,
    pidChain,
    editor,
    headless,
    receivedAt: new Date().toISOString()
  };
  const observedFacts: ClaudeActivityObservedFacts = {
    ...base,
    toolName: rawToolName,
    prompt: getString(event.prompt),
    message,
    toolInputSummary: toolInputSummary || null,
    toolOutputSummary: toolOutputSummary || null,
    responseSummary,
    failureReason: failureReason || null,
    failed
  };

  if (hookEventName === "UserPromptSubmit") {
    return createNormalizedEvent(base, observedFacts, {
      visualState: "running",
      title: "Thinking",
      body: cropText(getString(event.prompt) ?? ""),
      confidence: "high",
      derivationKind: "observed"
    });
  }

  if (hookEventName === "PreToolUse") {
    return createNormalizedEvent(base, observedFacts, {
      visualState: "running",
      title: `Using ${toolName}`,
      body: cropText(toolInputSummary),
      confidence: rawToolName ? "high" : "medium",
      derivationKind: "observed"
    });
  }

  if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
    if (!failed) {
      return createNormalizedEvent(base, observedFacts, {
        visualState: "running",
        title: "Thinking",
        body: cropText(summarizeCompletedToolActivity(event, toolName)),
        confidence: rawToolName ? "medium" : "low",
        derivationKind: "heuristic"
      });
    }

    return createNormalizedEvent(base, observedFacts, {
      visualState: "failed",
      title: `${toolName} failed`,
      body: cropText(toolOutputSummary),
      confidence: "high",
      derivationKind: "observed"
    });
  }

  if (hookEventName === "Notification") {
    const croppedMessage = cropText(message ?? "");
    if (isPassiveClaudeWaitingMessage(croppedMessage)) {
      return createNormalizedEvent(base, observedFacts, {
        visualState: "idle",
        title: "",
        body: "",
        confidence: "high",
        derivationKind: "observed"
      });
    }

    return createNormalizedEvent(base, observedFacts, {
      visualState: "waiting",
      title: "Waiting",
      body: croppedMessage,
      confidence: "medium",
      derivationKind: "observed"
    });
  }

  if (hookEventName === "PermissionRequest") {
    return createNormalizedEvent(base, observedFacts, {
      visualState: "waiting",
      title: `Allow ${toolName}?`,
      body: cropText(toolInputSummary),
      confidence: rawToolName ? "high" : "medium",
      derivationKind: "observed"
    });
  }

  return createNormalizedEvent(base, observedFacts, {
    visualState: failed ? "failed" : "review",
    title: failed ? "Run failed" : "Ready for review",
    body: cropText(failed ? failureReason : summarizeReviewBody(event)),
    confidence: failed ? "high" : responseSummary ? "medium" : "low",
    derivationKind: failed ? "observed" : responseSummary ? "transcript-tail" : "fallback"
  });
}

function createNormalizedEvent(
  base: NormalizedEventBase,
  observedFacts: ClaudeActivityObservedFacts,
  presentation: ClaudeActivityDerivedPresentation
): NormalizedClaudeEvent {
  return {
    ...base,
    petState: presentation.visualState,
    title: presentation.title,
    body: presentation.body,
    observedFacts,
    derivedPresentation: presentation,
    capabilityProvenance: getCapabilityProvenance(observedFacts)
  };
}

function getCapabilityProvenance(
  facts: Pick<ClaudeActivityObservedFacts, "cwd" | "sourcePid" | "pidChain">
): ClaudeActivityCapabilityProvenance {
  const hasPidContext = Boolean(facts.sourcePid || facts.pidChain.length > 0);
  const unsupportedReasons = ["reply transport is unavailable"];

  if (hasPidContext && supportsProcessFocus(process.platform)) {
    return {
      openContextCapability: "focus-session",
      openContextConfidence: "high",
      openContextDerivationKind: "pid-context-observed",
      canReply: false,
      unsupportedReasons
    };
  }

  if (facts.cwd && supportsCwdOpen(process.platform)) {
    return {
      openContextCapability: "open-cwd",
      openContextConfidence: "medium",
      openContextDerivationKind: "cwd-context-observed",
      canReply: false,
      unsupportedReasons
    };
  }

  return {
    openContextCapability: "none",
    openContextConfidence: "high",
    openContextDerivationKind: hasPidContext || facts.cwd ? "unsupported-platform" : "missing-context",
    canReply: false,
    unsupportedReasons: hasPidContext || facts.cwd
      ? [...unsupportedReasons, `context opening is unsupported on ${process.platform}`]
      : unsupportedReasons
  };
}

function supportsProcessFocus(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function supportsCwdOpen(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

function normalizeTerminalContext(value: unknown): ClaudeTerminalContext | null {
  if (!isRecord(value)) {
    return null;
  }

  const terminal = {
    appName: getString(value.appName),
    termProgram: getString(value.termProgram),
    term: getString(value.term)
  };

  return terminal.appName || terminal.termProgram || terminal.term ? terminal : null;
}

export function normalizePermissionRequest(
  rawEvent: unknown,
  requestId: string,
  timeoutMs: number
): NormalizedPermissionRequest {
  const event = isRecord(rawEvent) ? rawEvent : {};
  const receivedAtMs = Date.now();
  const toolName = getString(event.tool_name ?? event.toolName) ?? "tool";

  return {
    requestId,
    sessionId: getString(event.session_id ?? event.sessionId),
    toolName,
    body: cropText(summarizeToolInput(event), maxPermissionBodyLength),
    receivedAt: new Date(receivedAtMs).toISOString(),
    expiresAt: new Date(receivedAtMs + timeoutMs).toISOString()
  };
}

function normalizeHookEventName(value: unknown): ClaudeHookEventName {
  if (typeof value === "string" && supportedHookEvents.has(value as ClaudeHookEventName)) {
    return value as ClaudeHookEventName;
  }

  return "Notification";
}

function summarizeToolInput(event: RawHookEvent): string {
  const toolInput = event.tool_input ?? event.toolInput;
  if (isRecord(toolInput)) {
    return getString(toolInput.command) ?? getString(toolInput.description) ?? stableJson(toolInput);
  }

  return getString(toolInput) ?? "";
}

function summarizeCompletedToolActivity(event: RawHookEvent, toolName: string): string {
  const toolInput = event.tool_input ?? event.toolInput;
  const fileName = isRecord(toolInput) ? getFileName(getString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path)) : null;

  switch (toolName.toLowerCase()) {
    case "bash":
      return "Ran command";
    case "read":
      return fileName ? `Read ${fileName}` : "Read file";
    case "write":
      return fileName ? `Edited ${fileName}` : "Edited file";
    case "edit":
    case "multiedit":
      return fileName ? `Edited ${fileName}` : "Edited file";
    case "ls":
      return "Listed files";
    case "grep":
    case "glob":
      return "Searched files";
    case "webfetch":
    case "websearch":
      return "Searched web";
    default:
      return toolName === "tool" ? "Called tool" : `Called ${toolName}`;
  }
}

function getFileName(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function summarizeToolOutput(event: RawHookEvent): string {
  return (
    getString(event.error) ??
    getString(event.message) ??
    getString(event.summary) ??
    getString(event.tool_response) ??
    getString(event.toolResponse) ??
    ""
  );
}

function summarizeFailureReason(event: RawHookEvent): string {
  return getString(event.error) ?? getString(event.message) ?? getString(event.reason) ?? "";
}

function summarizeReviewBody(event: RawHookEvent): string {
  return getString(event.response_summary ?? event.responseSummary) ?? "";
}

function isFailureHookEvent(hookEventName: ClaudeHookEventName): boolean {
  return hookEventName.endsWith("Failure");
}

function hasFailureSignal(event: RawHookEvent): boolean {
  const status = getString(event.status ?? event.outcome ?? event.result);
  const exitCode = typeof event.exit_code === "number" ? event.exit_code : undefined;
  return (
    event.error !== undefined ||
    event.is_error === true ||
    event.failed === true ||
    status === "failed" ||
    status === "failure" ||
    status === "error" ||
    (exitCode !== undefined && exitCode !== 0)
  );
}

function isPassiveClaudeWaitingMessage(message: string): boolean {
  return message === "Claude is waiting for your input";
}

function cropText(value: string, maxLength = maxBodyLength): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}…`;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function getPositiveIntegerArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function isRecord(value: unknown): value is RawHookEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
