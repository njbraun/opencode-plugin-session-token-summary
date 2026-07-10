import { describe, expect, test } from "bun:test";
import type { AssistantMessage, OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import {
  computeTotals,
  fetchDescendants,
  sumSessions,
} from "../usage";

function assistant(id: string): AssistantMessage {
  return {
    id,
    sessionID: "root",
    role: "assistant",
    time: { created: 0 },
    parentID: "parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0.5,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    },
  };
}

function session(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/",
    title: id,
    version: "1.17.9",
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

function clientFor(
  children: Record<string, Session[]>,
  messages: Record<string, AssistantMessage[]>,
): OpencodeClient {
  return {
    session: {
      children: async ({ sessionID }: { sessionID: string }) => ({
        data: children[sessionID] ?? [],
      }),
      messages: async ({ sessionID }: { sessionID: string }) => ({
        data: (messages[sessionID] ?? []).map((info) => ({ info, parts: [] })),
      }),
    },
  } as unknown as OpencodeClient;
}

describe("token aggregation", () => {
  test("sums assistant messages and descendant session aggregates", () => {
    const root = computeTotals([assistant("root-1")]);
    const descendants = sumSessions([session("child")], 2);

    expect(root).toMatchObject({ input: 100, output: 20, turns: 1, cost: 0.5 });
    expect(descendants).toMatchObject({ input: 50, output: 10, turns: 2, cost: 1 });
  });
});

describe("descendant fetching", () => {
  test("collects nested descendants once and counts their assistant turns", async () => {
    const child = session("child");
    const grandchild = session("grandchild");
    const client = clientFor(
      { root: [child], child: [grandchild], grandchild: [child] },
      { child: [assistant("child-1")], grandchild: [assistant("grandchild-1")] },
    );

    await expect(fetchDescendants(client, "root")).resolves.toEqual({
      sessions: [child, grandchild],
      turns: 2,
    });
  });

  test("fails the refresh when any descendant request fails", async () => {
    const client = clientFor({ root: [session("child")] }, {});
    const sessionApi = client.session as unknown as {
      messages: () => Promise<never>;
    };
    sessionApi.messages = async () => {
      throw new Error("unavailable");
    };

    await expect(fetchDescendants(client, "root")).rejects.toThrow("unavailable");
  });

  test("limits concurrent descendant requests", async () => {
    let active = 0;
    let peak = 0;
    const children: Record<string, Session[]> = {
      root: Array.from({ length: 8 }, (_, index) => session(`child-${index}`)),
    };
    const client = clientFor(children, {});
    const sessionApi = client.session as unknown as {
      children: ({ sessionID }: { sessionID: string }) => Promise<{ data: Session[] }>;
    };
    sessionApi.children = async ({ sessionID }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return { data: children[sessionID] ?? [] };
    };

    await fetchDescendants(client, "root");
    expect(peak).toBeLessThanOrEqual(4);
  });
});
