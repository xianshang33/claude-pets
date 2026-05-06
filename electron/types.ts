export type PetAtlas = {
  width: number;
  height: number;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
};

export type PetPackage = {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  atlas: PetAtlas;
};

export type PetPackageWarning = {
  petId: string;
  message: string;
};

export type ClaudeHookEventName =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "PermissionRequest"
  | "Stop"
  | "StopFailure";

export type ClaudeBridgePetState = "idle" | "running" | "waiting" | "review" | "failed";

export type ClaudeActivityDerivationKind = "observed" | "heuristic" | "transcript-tail" | "fallback";

export type ClaudeActivityConfidence = "high" | "medium" | "low";

export type ClaudeOpenContextCapability = "focus-session" | "open-cwd" | "none";

export type ClaudeOpenContextCapabilityDerivationKind =
  | "pid-context-observed"
  | "cwd-context-observed"
  | "missing-context"
  | "unsupported-platform";

export type ClaudeTerminalContext = {
  appName: string | null;
  termProgram: string | null;
  term: string | null;
};

export type ClaudeActivityObservedFacts = {
  hookEventName: ClaudeHookEventName;
  sessionId: string | null;
  cwd: string | null;
  terminal: ClaudeTerminalContext | null;
  sourcePid: number | null;
  agentPid: number | null;
  pidChain: number[];
  editor: string | null;
  headless: boolean;
  toolName: string | null;
  prompt: string | null;
  message: string | null;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  responseSummary: string | null;
  failureReason: string | null;
  failed: boolean;
};

export type ClaudeActivityDerivedPresentation = {
  visualState: ClaudeBridgePetState;
  title: string;
  body: string;
  confidence: ClaudeActivityConfidence;
  derivationKind: ClaudeActivityDerivationKind;
};

export type ClaudeActivityCapabilityProvenance = {
  openContextCapability: ClaudeOpenContextCapability;
  openContextConfidence: ClaudeActivityConfidence;
  openContextDerivationKind: ClaudeOpenContextCapabilityDerivationKind;
  canReply: false;
  unsupportedReasons: string[];
};

export type NormalizedClaudeEvent = {
  hookEventName: ClaudeHookEventName;
  sessionId: string | null;
  cwd: string | null;
  terminal: ClaudeTerminalContext | null;
  sourcePid: number | null;
  agentPid: number | null;
  pidChain: number[];
  editor: string | null;
  headless: boolean;
  petState: ClaudeBridgePetState;
  title: string;
  body: string;
  receivedAt: string;
  observedFacts?: ClaudeActivityObservedFacts;
  derivedPresentation?: ClaudeActivityDerivedPresentation;
  capabilityProvenance?: ClaudeActivityCapabilityProvenance;
};

export type ClaudeBridgeStatus = {
  listening: boolean;
  host: "127.0.0.1";
  port: number;
  url: string;
  latestEvent: NormalizedClaudeEvent | null;
};

export type PermissionDecisionBehavior = "allow" | "deny";

export type ClaudePermissionDecision = {
  behavior: PermissionDecisionBehavior;
  message?: string;
  interrupt?: boolean;
};

export type NormalizedPermissionRequest = {
  requestId: string;
  sessionId: string | null;
  toolName: string;
  body: string;
  receivedAt: string;
  expiresAt: string;
};

export type InitialState = {
  petsDirectory: string;
  petsDirectoryReady: boolean;
  petCount: number;
  hasPets: boolean;
  pets: PetPackage[];
  selectedPet: PetPackage | null;
  warnings: PetPackageWarning[];
  bridge: ClaudeBridgeStatus;
};

export type ClaudePetOverlayBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  minimumWindowWidth?: number;
  minimumWindowHeight?: number;
};

export type OpenEventContextResult = {
  outcome: "focused-session" | "opened-cwd-fallback" | "unavailable";
  method?: "pid" | "cwd";
  reason?: string;
};

export type ClaudePetApi = {
  getInitialState: () => Promise<InitialState>;
  reloadPets: () => Promise<InitialState>;
  selectPet: (petId: string) => Promise<InitialState>;
  openPetsDirectory: () => Promise<void>;
  closePet: () => Promise<void>;
  getBridgeStatus: () => Promise<ClaudeBridgeStatus>;
  onStateChanged: (handler: (state: InitialState | undefined) => void) => () => void;
  onClaudeEvent: (handler: (event: NormalizedClaudeEvent) => void) => () => void;
  onPermissionRequest: (handler: (request: NormalizedPermissionRequest) => void) => () => void;
  submitPermissionDecision: (requestId: string, behavior: PermissionDecisionBehavior) => Promise<boolean>;
  openEventContext: (event: NormalizedClaudeEvent) => Promise<OpenEventContextResult>;
  moveWindowBy: (deltaX: number, deltaY: number) => Promise<void>;
  setOverlayContentBounds: (bounds: ClaudePetOverlayBounds) => Promise<void>;
  setDragAnchorBounds: (bounds: ClaudePetOverlayBounds) => Promise<void>;
  setPointerInteractivity: (isInteractive: boolean) => Promise<void>;
  quit: () => Promise<void>;
};
