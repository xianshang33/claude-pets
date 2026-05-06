import type { NormalizedPermissionRequest } from "../../electron/types";

export type PermissionQueueState = {
  order: string[];
  requests: Record<string, NormalizedPermissionRequest>;
  submitting: Record<string, boolean>;
  errors: Record<string, string | null>;
};

export type PermissionStatus = {
  request: NormalizedPermissionRequest | null;
  submitting: boolean;
  error: string | null;
  pendingCount: number;
};

export function createPermissionQueueState(): PermissionQueueState {
  return {
    order: [],
    requests: {},
    submitting: {},
    errors: {}
  };
}

export function enqueuePermissionRequest(
  state: PermissionQueueState,
  request: NormalizedPermissionRequest
): PermissionQueueState {
  const exists = state.requests[request.requestId] !== undefined;

  return {
    order: exists ? state.order : [...state.order, request.requestId],
    requests: { ...state.requests, [request.requestId]: request },
    submitting: { ...state.submitting, [request.requestId]: state.submitting[request.requestId] ?? false },
    errors: { ...state.errors, [request.requestId]: state.errors[request.requestId] ?? null }
  };
}

export function getCurrentPermissionStatus(state: PermissionQueueState): PermissionStatus {
  const requestId = state.order.find((id) => state.requests[id] !== undefined);
  const request = requestId ? state.requests[requestId] : null;

  return {
    request,
    submitting: requestId ? Boolean(state.submitting[requestId]) : false,
    error: requestId ? (state.errors[requestId] ?? null) : null,
    pendingCount: state.order.length
  };
}

export function startPermissionSubmit(
  state: PermissionQueueState,
  requestId: string
): { state: PermissionQueueState; accepted: boolean } {
  if (!state.requests[requestId]) {
    return { state, accepted: false };
  }

  return {
    state: {
      ...state,
      submitting: { ...state.submitting, [requestId]: true },
      errors: { ...state.errors, [requestId]: null }
    },
    accepted: true
  };
}

export function completePermissionSubmit(
  state: PermissionQueueState,
  requestId: string,
  accepted: boolean
): { state: PermissionQueueState; accepted: boolean } {
  if (!state.requests[requestId]) {
    return { state, accepted: false };
  }

  if (accepted) {
    return removePermissionRequest(state, requestId);
  }

  return {
    state: {
      ...state,
      submitting: { ...state.submitting, [requestId]: false },
      errors: { ...state.errors, [requestId]: "Request expired." }
    },
    accepted: false
  };
}

export function failPermissionSubmit(
  state: PermissionQueueState,
  requestId: string,
  message: string
): { state: PermissionQueueState; accepted: boolean } {
  if (!state.requests[requestId]) {
    return { state, accepted: false };
  }

  return {
    state: {
      ...state,
      submitting: { ...state.submitting, [requestId]: false },
      errors: { ...state.errors, [requestId]: message }
    },
    accepted: true
  };
}

export function expirePermissionRequest(
  state: PermissionQueueState,
  requestId: string
): { state: PermissionQueueState; accepted: boolean } {
  if (!state.requests[requestId]) {
    return { state, accepted: false };
  }

  return removePermissionRequest(state, requestId);
}

function removePermissionRequest(
  state: PermissionQueueState,
  requestId: string
): { state: PermissionQueueState; accepted: boolean } {
  const { [requestId]: _request, ...requests } = state.requests;
  const { [requestId]: _submitting, ...submitting } = state.submitting;
  const { [requestId]: _error, ...errors } = state.errors;

  return {
    state: {
      order: state.order.filter((id) => id !== requestId),
      requests,
      submitting,
      errors
    },
    accepted: true
  };
}
