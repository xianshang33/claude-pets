type SimulationKind = "pretool" | "notification" | "stop";

const defaultPort = 38987;
const args = process.argv.slice(2);
const port = readPort(args) ?? defaultPort;
const payload = createPayload(args.filter((arg) => !arg.startsWith("--port")));

async function main() {
  const response = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Bridge returned ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as { event?: { petState?: string; title?: string } };
  console.log(`sent ${payload.hook_event_name} -> ${result.event?.petState ?? "unknown"} (${result.event?.title ?? ""})`);
}

function createPayload(argv: string[]): Record<string, unknown> {
  const kind = (argv[0]?.toLowerCase() ?? "pretool") as SimulationKind;
  const value = argv[1]?.toLowerCase();

  if (kind === "notification") {
    return {
      hook_event_name: "Notification",
      message: "Claude needs your attention."
    };
  }

  if (kind === "stop") {
    return {
      hook_event_name: "Stop",
      status: value === "failed" || value === "failure" ? "failed" : "success"
    };
  }

  return {
    hook_event_name: "PreToolUse",
    tool_name: argv[1] ?? "Bash",
    tool_input: {
      command: "npm test"
    }
  };
}

function readPort(argv: string[]): number | null {
  const portArg = argv.find((arg) => arg.startsWith("--port="));
  if (!portArg) {
    return null;
  }

  const port = Number(portArg.slice("--port=".length));
  return Number.isInteger(port) && port > 0 ? port : null;
}

void main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : "Unable to send simulated event.");
  process.exitCode = 1;
});
