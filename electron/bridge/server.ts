import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { normalizeClaudeHookEvent, normalizePermissionRequest } from "./events";
import type {
  ClaudeBridgeStatus,
  ClaudePermissionDecision,
  NormalizedClaudeEvent,
  NormalizedPermissionRequest
} from "../types";

const bridgeHost = "127.0.0.1" as const;
const defaultBridgePort = 38987;
const maxRequestBytes = 64 * 1024;
const defaultPermissionTimeoutMs = 30_000;

type ClaudeBridgeServerOptions = {
  defaultPort?: number;
  onEvent?: (event: NormalizedClaudeEvent) => void;
  onPermissionRequest?: (request: NormalizedPermissionRequest) => void;
  permissionTimeoutMs?: number;
};

export type ClaudeBridgeServer = {
  start: () => Promise<ClaudeBridgeStatus>;
  close: () => Promise<void>;
  getStatus: () => ClaudeBridgeStatus;
  submitPermissionDecision: (requestId: string, decision: ClaudePermissionDecision) => boolean;
};

export function parsePreferredBridgePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return undefined;
  }

  return port;
}

type PendingPermissionRequest = {
  request: NormalizedPermissionRequest;
  resolve: (decision: ClaudePermissionDecision | null) => void;
  timeout: NodeJS.Timeout;
};

export function createClaudeBridgeServer(options: ClaudeBridgeServerOptions = {}): ClaudeBridgeServer {
  let server: http.Server | null = null;
  let status = createStatus(options.defaultPort ?? defaultBridgePort, false, null);
  const permissionTimeoutMs = normalizePermissionTimeoutMs(options.permissionTimeoutMs);
  const pendingPermissionRequests = new Map<string, PendingPermissionRequest>();

  async function start(): Promise<ClaudeBridgeStatus> {
    if (server) {
      return status;
    }

    server = http.createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/status") {
        sendJson(response, 200, status);
        return;
      }

      if (request.method === "POST" && request.url === "/permission-request") {
        try {
          validatePostRequest(request);
          const rawEvent = await readJsonRequest(request);
          const decision = await waitForPermissionDecision(rawEvent);
          sendJson(response, 200, { decision });
        } catch (cause) {
          const error = requestError(cause);
          sendJson(response, error.statusCode, { error: error.message });
        }
        return;
      }

      if (request.method !== "POST" || (request.url !== "/hook" && request.url !== "/event")) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        validatePostRequest(request);
        const rawEvent = await readJsonRequest(request);
        const normalized = normalizeClaudeHookEvent(rawEvent);
        status = createStatus(status.port, true, normalized);
        options.onEvent?.(normalized);
        sendJson(response, 200, { ok: true, event: normalized });
      } catch (cause) {
        const error = requestError(cause);
        sendJson(response, error.statusCode, { error: error.message });
      }
    });

    const preferredPort = options.defaultPort ?? defaultBridgePort;
    try {
      status = await listen(server, preferredPort);
    } catch (cause) {
      if (!isAddressInUse(cause)) {
        server = null;
        throw cause;
      }
      status = await listen(server, 0);
    }

    return status;
  }

  async function close(): Promise<void> {
    if (!server) {
      status = createStatus(status.port, false, status.latestEvent);
      return;
    }

    for (const pending of pendingPermissionRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    pendingPermissionRequests.clear();

    const closingServer = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      closingServer.close((error) => (error ? reject(error) : resolve()));
    });
    status = createStatus(status.port, false, status.latestEvent);
  }

  function submitPermissionDecision(requestId: string, decision: ClaudePermissionDecision): boolean {
    const pending = pendingPermissionRequests.get(requestId);
    if (!pending || !isPermissionDecision(decision)) {
      return false;
    }

    clearTimeout(pending.timeout);
    pendingPermissionRequests.delete(requestId);
    pending.resolve(sanitizePermissionDecision(decision));
    return true;
  }

  function waitForPermissionDecision(rawEvent: unknown): Promise<ClaudePermissionDecision | null> {
    const requestId = randomUUID();
    const permissionRequest = normalizePermissionRequest(rawEvent, requestId, permissionTimeoutMs);
    const waitingEvent = normalizeClaudeHookEvent({ ...(isRecord(rawEvent) ? rawEvent : {}), hook_event_name: "PermissionRequest" });
    status = createStatus(status.port, true, waitingEvent);

    return new Promise<ClaudePermissionDecision | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissionRequests.delete(requestId);
        resolve(null);
      }, permissionTimeoutMs);
      pendingPermissionRequests.set(requestId, {
        request: permissionRequest,
        resolve,
        timeout
      });
      options.onEvent?.(waitingEvent);
      options.onPermissionRequest?.(permissionRequest);
    });
  }

  return {
    start,
    close,
    getStatus: () => status,
    submitPermissionDecision
  };
}

function listen(server: http.Server, port: number): Promise<ClaudeBridgeStatus> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resolve(createStatus(address.port, true, null));
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bridgeHost);
  });
}

function createStatus(port: number, listening: boolean, latestEvent: NormalizedClaudeEvent | null): ClaudeBridgeStatus {
  return {
    listening,
    host: bridgeHost,
    port,
    url: `http://${bridgeHost}:${port}`,
    latestEvent
  };
}

async function readJsonRequest(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxRequestBytes) {
      throw new Error("Event payload too large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function validatePostRequest(request: http.IncomingMessage): void {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    throw new HttpRequestError(403, "Unexpected Origin header");
  }

  const contentType = request.headers["content-type"];
  if (!isJsonContentType(contentType)) {
    throw new HttpRequestError(415, "Content-Type must be application/json");
  }
}

function isJsonContentType(contentType: string | string[] | undefined): boolean {
  if (typeof contentType !== "string") {
    return false;
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function requestError(cause: unknown): HttpRequestError {
  if (cause instanceof HttpRequestError) {
    return cause;
  }

  return new HttpRequestError(400, cause instanceof Error ? cause.message : "Invalid event");
}

function isAddressInUse(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE";
}

function normalizePermissionTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultPermissionTimeoutMs;
  }

  return Math.max(1, Math.round(value));
}

function isPermissionDecision(value: unknown): value is ClaudePermissionDecision {
  if (!isRecord(value)) {
    return false;
  }

  return value.behavior === "allow" || value.behavior === "deny";
}

function sanitizePermissionDecision(decision: ClaudePermissionDecision): ClaudePermissionDecision {
  if (decision.behavior === "allow") {
    return { behavior: "allow" };
  }

  return {
    behavior: "deny",
    ...(typeof decision.message === "string" && decision.message.trim()
      ? { message: decision.message.trim().slice(0, 500) }
      : {}),
    ...(decision.interrupt === true ? { interrupt: true } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
