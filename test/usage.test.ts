import { describe, expect, test } from "bun:test";
import type { OpenCodeClient, SessionInfo as Session, SessionMessageInfo } from "@opencode/client";
import { fmt, fmtCost } from "../tui";
import {
  combineCosts,
  computeTotals,
  detectCacheMisses,
  estimateCost,
  fetchSessionMessages,
  fetchDescendants,
  needsCostEstimate,
  sumSessions,
  type SessionMessageCache,
} from "../usage";
import { assistant, cacheRequest, clientFor, pricedModel, session } from "./helpers";

describe("number formatting", () => {
  test("promotes units only after rounding", () => {
    expect(fmt(999)).toBe("999");
    expect(fmt(1_000)).toBe("1K");
    expect(fmt(999_949)).toBe("999.9K");
    expect(fmt(999_999)).toBe("1M");
    expect(fmt(1_250_000)).toBe("1.3M");
  });

  test("groups cost thousands and keeps small-cost notation", () => {
    expect(fmtCost(0.005)).toBe("<$0.01");
    expect(fmtCost(1_234.5)).toBe("$1,234.50");
  });
});

describe("token aggregation", () => {
  test("sums assistant messages and descendant session aggregates", () => {
    const root = computeTotals([assistant("root-1")]);
    const descendants = sumSessions([session("child")], 2);

    expect(root).toMatchObject({ input: 100, output: 20, turns: 1, cost: 0.5 });
    expect(descendants).toMatchObject({ input: 50, output: 10, turns: 2, cost: 1 });
  });
});

describe("cost estimation", () => {
  test("uses the same token categories and per-million rates as OpenCode", () => {
    const message = assistant("priced");
    message.cost = 0;
    message.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(estimateCost([message], [model])).toBeCloseTo(
      0.0006855,
    );
  });

  test("finds API pricing across providers for quota-backed model aliases", () => {
    const message = assistant("quota");
    message.cost = 0;
    message.model = { id: "claude-opus-4.6", providerID: "github-copilot" };
    const quotaModel = pricedModel(message.model.id, message.model.providerID, {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    const apiModel = pricedModel("claude-opus-4-6", "anthropic", {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      estimateCost(
        [message],
        [
          quotaModel,
          apiModel,
        ],
      ),
    ).toBeGreaterThan(0);
  });

  test("combines reported and estimated costs into one mixed total", () => {
    const reported = assistant("reported");
    const quota = assistant("quota");
    quota.cost = 0;
    quota.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const model = pricedModel(quota.model.id, quota.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      combineCosts(reported.cost!, [reported, quota], [model]),
    ).toEqual({ cost: 0.5006855, mode: "mixed" });
  });

  test("marks a fully estimated total", () => {
    const quota = assistant("quota");
    quota.cost = 0;
    const model = pricedModel(quota.model.id, quota.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0, [quota], [model])).toEqual({
      cost: 0.0006855,
      mode: "estimated",
    });
  });

  test("does not estimate messages with an omitted cost", () => {
    const message = assistant("missing");
    delete (message as { cost?: number }).cost;
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0.25, [message], [model])).toEqual({
      cost: 0.25,
      mode: "reported",
    });
  });

  test("uses context tiers only above their threshold", () => {
    const message = assistant("tiered");
    const model = pricedModel("model", "provider", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    model.cost.push({
      tier: { type: "context", size: 112 },
      input: 2, output: 2, cache: { read: 2, write: 2 },
    });
    expect(estimateCost([message], [model])).toBeCloseTo(0.000137);
    message.tokens!.input += 1;
    expect(estimateCost([message], [model])).toBeCloseTo(0.000276);
  });

  test("skips unfinished assistant messages without tokens", () => {
    const message = assistant("unfinished");
    delete message.tokens;
    const model = pricedModel("model", "provider", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    expect(estimateCost([message], [model])).toBe(0);
    expect(computeTotals([message])).toMatchObject({ input: 0, turns: 1 });
  });

  test("prefers a same-provider normalized match over a cross-provider alias", () => {
    const message = assistant("alias");
    message.cost = 0;
    message.model = { id: "claude-opus-4.6", providerID: "local" };
    const local = pricedModel("claude-opus-4-6", "local", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    const expensive = pricedModel("claude-opus-4.6", "other", {
      input: 99, output: 99, cache: { read: 99, write: 99 },
    });

    expect(estimateCost([message], [expensive, local])).toBeCloseTo(0.000137);
  });

  test("estimates usage from zero-cost compaction records", () => {
    const compaction: SessionMessageInfo = {
      id: "compaction",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "",
      recent: "",
      time: { created: 0 },
      model: { id: "model", providerID: "provider" },
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    };
    const model = pricedModel("model", "provider", {
      input: 3, output: 15, cache: { read: 0.3, write: 3.75 },
    });

    expect(needsCostEstimate(compaction)).toBe(true);
    expect(combineCosts(0, [compaction], [model])).toEqual({
      cost: 0.0003,
      mode: "estimated",
    });
  });
});

describe("descendant fetching", () => {
  test("follows message cursors and requests only assistant messages", async () => {
    const client = clientFor({}, {});
    const calls: unknown[] = [];
    client.message.list = async (input) => {
      calls.push(input);
      return input.cursor
        ? { data: [assistant("second")], cursor: {} }
        : { data: [assistant("first")], cursor: { next: "more" } };
    };
    expect(await fetchSessionMessages(client, "root")).toHaveLength(2);
    expect(calls).toEqual([
      { sessionID: "root", type: "assistant", limit: 100, order: "desc" },
      { sessionID: "root", type: "assistant", limit: 100, cursor: "more" },
    ]);
  });

  test("follows child cursors without including unrelated sessions", async () => {
    const client = clientFor({}, {});
    client.session.list = async (input) => {
      if (input?.parentID !== "root") return { data: [], cursor: {} };
      return input.cursor
        ? { data: [session("second")], cursor: {} }
        : { data: [session("first")], cursor: { next: "more" } };
    };
    expect((await fetchDescendants(client, "root")).sessions.map((s) => s.id))
      .toEqual(["first", "second"]);
  });

  test("includes compactions only when requested and follows their message cursors", async () => {
    const reset: SessionMessageInfo = {
      id: "reset", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 1 },
    };
    const client = clientFor({}, {});
    const calls: unknown[] = [];
    client.message.list = async (input) => {
      calls.push(input);
      return input.cursor
        ? { data: [assistant("first")], cursor: {} }
        : { data: [reset], cursor: { next: "more" } };
    };
    expect(await fetchSessionMessages(client, "root", true)).toEqual([reset, assistant("first")]);
    expect(calls).toEqual([
      { sessionID: "root", limit: 100, order: "desc" },
      { sessionID: "root", limit: 100, cursor: "more" },
    ]);
  });

  test("reuses cached messages and fetches only until a known message", async () => {
    const cache: SessionMessageCache = new Map();
    const calls: unknown[] = [];
    let version = 3;
    const client = {
      message: {
        list: async (input: { cursor?: string }) => {
          calls.push(input);
          if (version === 3) {
            return input.cursor
              ? { data: [cacheRequest("first", 0, { write: 1_000 })], cursor: {} }
              : {
                  data: [
                    cacheRequest("third", 200, { write: 1_000 }),
                    cacheRequest("second", 100, { write: 1_000 }),
                  ],
                  cursor: { next: "older" },
                };
          }
          return {
            data: [
              cacheRequest("fourth", 300, { write: 1_000 }),
              cacheRequest("third", 200, { write: 1_000 }),
            ],
            cursor: { next: "older" },
          };
        },
      },
    } as unknown as OpenCodeClient;

    expect((await fetchSessionMessages(client, "root", true, cache)).map((message) => message.id))
      .toEqual(["first", "second", "third"]);
    version = 4;
    calls.length = 0;
    expect((await fetchSessionMessages(client, "root", true, cache)).map((message) => message.id))
      .toEqual(["first", "second", "third", "fourth"]);
    expect(calls).toHaveLength(1);
  });

  test("detects descendant misses separately and excludes compactions from turn counts", async () => {
    const reset: SessionMessageInfo = {
      id: "reset", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 0 },
    };
    const client = clientFor({ root: [session("a"), session("b")] }, {
      a: [cacheRequest("a-first", 1, { read: 100_000 })],
      b: [reset, cacheRequest("b-first", 2, { write: 100_000 }), cacheRequest("b-miss", 3, { write: 110_000 })],
    });
    const data = await fetchDescendants(client, "root", true);
    expect(data.turns).toBe(3);
    expect(data.messages.every((message) => message.type === "assistant")).toBe(true);
    expect(data.cacheMisses).toEqual([{
      sessionID: "b", messageID: "b-miss", missedTokens: 100_000, modelChanged: false, idleMs: 0,
    }]);
  });

  test("collects nested descendants once and counts their assistant turns", async () => {
    const child = session("child");
    const grandchild = session("grandchild");
    const client = clientFor(
      { root: [child], child: [grandchild], grandchild: [child] },
      { child: [assistant("child-1")], grandchild: [assistant("grandchild-1")] },
    );

    await expect(fetchDescendants(client, "root")).resolves.toEqual({
      sessions: [child, grandchild],
      messages: [assistant("child-1"), assistant("grandchild-1")],
      costMessages: [assistant("child-1"), assistant("grandchild-1")],
      turns: 2,
      cacheMisses: [],
      partial: false,
    });
  });

  test("marks the refresh partial when any descendant request fails", async () => {
    const client = clientFor({ root: [session("child")] }, {});
    const messageApi = client.message as unknown as {
      list: () => Promise<never>;
    };
    messageApi.list = async () => {
      throw new Error("unavailable");
    };

    const data = await fetchDescendants(client, "root");
    expect(data.partial).toBe(true);
    expect(data.sessions.map((session) => session.id)).toEqual(["child"]);
    expect(data.messages).toEqual([]);
    expect(data.costMessages).toEqual([]);
  });

  test("limits concurrent descendant requests", async () => {
    let active = 0;
    let peak = 0;
    const children: Record<string, Session[]> = {
      root: Array.from({ length: 8 }, (_, index) => session(`child-${index}`)),
    };
    const client = clientFor(children, {});
    const sessionApi = client.session as unknown as {
      list: ({ parentID }: { parentID: string }) => Promise<{ data: Session[]; cursor: object }>;
    };
    sessionApi.list = async ({ parentID }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return { data: children[parentID] ?? [], cursor: {} };
    };

    await fetchDescendants(client, "root");
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("Pi-style cache-miss detection", () => {
  test("ignores the first request and healthy cache reads, and detects full and partial misses", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const healthy = cacheRequest("healthy", 60_000, { read: 100_000, write: 5_000 });
    expect(detectCacheMisses([healthy, first], "root")).toEqual([]);
    const miss = cacheRequest("miss", 600_000, { write: 110_000 });
    expect(detectCacheMisses([miss, healthy, first], "root")).toEqual([{
      sessionID: "root", messageID: "miss", missedTokens: 105_000, modelChanged: false, idleMs: 539_999,
    }]);
    const partial = cacheRequest("partial", 120_000, { read: 80_000, write: 30_000 });
    expect(detectCacheMisses([first, healthy, partial], "root")[0].missedTokens).toBe(25_000);
  });

  test("ignores 1024-token noise, prompt growth, and a fully cached smaller prompt", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const noise = cacheRequest("noise", 1, { read: 98_976, write: 1024 });
    expect(detectCacheMisses([first, noise], "root")).toEqual([]);
    noise.tokens!.cache.read -= 1;
    noise.tokens!.cache.write += 1;
    expect(detectCacheMisses([first, noise], "root")[0].missedTokens).toBe(1025);
    const smaller = cacheRequest("smaller", 1, { read: 20_000 });
    const larger = cacheRequest("larger", 2, { read: 20_000, write: 100_000 });
    expect(detectCacheMisses([first, smaller, larger], "root")).toEqual([]);
  });

  test("requires cache activity but remembers it for read-only providers and zero-usage messages", () => {
    const first = cacheRequest("first", 0, { input: 100_000 });
    const next = cacheRequest("next", 1, { input: 110_000 });
    expect(detectCacheMisses([first, next], "root")).toEqual([]);
    first.tokens!.cache.read = 100_000;
    first.tokens!.input = 0;
    const zero = cacheRequest("zero", 0.5, {});
    expect(detectCacheMisses([first, zero, next], "root")[0].missedTokens).toBe(100_000);
  });

  test("resets after compaction and does not exempt model switches", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const next = cacheRequest("next", 2, { write: 100_000 });
    next.model = { providerID: "other-provider", id: "other-model" };
    expect(detectCacheMisses([first, next], "root")[0].modelChanged).toBe(true);
    const reset: SessionMessageInfo = {
      id: "reset", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 1 },
    };
    expect(detectCacheMisses([first, reset, next], "root")).toEqual([]);
  });

  test("ignores failed, incomplete, and tokenless responses without replacing the baseline", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const failed = cacheRequest("failed", 1, { write: 200_000 });
    failed.error = { type: "provider.unknown", message: "unavailable" };
    const streaming = cacheRequest("streaming", 2, { write: 200_000 });
    delete streaming.time.completed;
    const tokenless = cacheRequest("tokenless", 3, {});
    delete tokenless.tokens;
    const healthy = cacheRequest("healthy", 4, { read: 100_000 });
    expect(detectCacheMisses([first, failed, streaming, tokenless, healthy], "root")).toEqual([]);
  });
});
