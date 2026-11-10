import type {
  SessionMessageAssistant as AssistantMessage,
  SessionMessageInfo,
  ModelInfo as Model,
  OpenCodeClient,
  SessionInfo as Session,
} from "@opencode/client";
import { createStore, produce, unwrap } from "solid-js/store";

export function assistant(id: string): AssistantMessage {
  return {
    id,
    type: "assistant",
    time: { created: 0 },
    model: { id: "model", providerID: "provider" },
    agent: "build",
    content: [],
    cost: 0.5,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    },
  };
}

export function session(id: string): Session {
  return {
    id,
    projectID: "project",
    location: { directory: "/" },
    title: id,
    cost: 1,
    tokens: {
      input: 50,
      output: 10,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    },
    time: { created: 0, updated: 0 },
  };
}

export function pricedModel(
  id: string,
  providerID: string,
  cost: Model["cost"][number],
): Model {
  return {
    id,
    modelID: id,
    providerID,
    cost: [cost],
  } as Model;
}

export function cacheRequest(id: string, created: number, tokens: { input?: number; read?: number; write?: number }): AssistantMessage {
  return {
    ...assistant(id),
    time: { created, completed: created + 1 },
    tokens: { input: tokens.input ?? 0, output: 0, reasoning: 0, cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 } },
  };
}

export function clientFor(
  children: Record<string, Session[]>,
  messages: Record<string, SessionMessageInfo[]>,
): OpenCodeClient {
  return {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => session(sessionID),
      list: async ({ parentID }: { parentID: string }) => ({
        data: children[parentID] ?? [],
        cursor: {},
      }),
    },
    message: {
      list: async ({ sessionID }: { sessionID: string }) => ({
        data: messages[sessionID] ?? [],
        cursor: {},
      }),
    },
  } as unknown as OpenCodeClient;
}

export function storageFor(saved: Record<string, object>) {
  return {
    store<Value extends object>(key: string, { initial }: { initial: Value }) {
      const [state, setState] = createStore(structuredClone((saved[key] ?? initial) as Value));
      return [state, async (mutation: (draft: Value) => void) => {
        setState(produce(mutation));
        saved[key] = structuredClone(unwrap(state));
      }] as const;
    },
  };
}
