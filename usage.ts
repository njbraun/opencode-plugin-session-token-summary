import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  ModelInfo,
  OpenCodeClient,
  SessionInfo,
} from "@opencode/client";

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost: number;
};

export type DescendantData = {
  sessions: ReadonlyArray<SessionInfo>;
  messages: ReadonlyArray<SessionMessageAssistant>;
  costMessages: ReadonlyArray<SessionMessageInfo>;
  turns: number;
  cacheMisses: ReadonlyArray<CacheMiss>;
  partial: boolean;
};

export type SessionMessageCache = Map<string, SessionMessageInfo[]>;

export type CacheMiss = {
  sessionID: string;
  messageID: string;
  missedTokens: number;
  modelChanged: boolean;
  idleMs: number;
};

export type CostMode = "reported" | "estimated" | "mixed";

export type CostMessage = {
  model?: { id: string; providerID: string };
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  error?: unknown;
  cost?: number;
  [key: string]: unknown;
};

export const EMPTY: TokenTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  cost: 0,
};

const FETCH_CONCURRENCY = 4;
const CACHE_MISS_TOKEN_THRESHOLD = 1024;

type PricingIndex = {
  exact: Map<string, ModelInfo>;
  normalized: Map<string, ModelInfo[]>;
};

function hasPrice(model: ModelInfo): boolean {
  return model.cost.some((cost) =>
    cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0
  );
}

function normalizedModelID(id: string): string {
  return (id.split("/").pop() || id).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pricingKey(providerID: string, modelID: string): string {
  return `${providerID}\u0000${modelID}`;
}

function buildPricingIndex(models: ReadonlyArray<ModelInfo>): PricingIndex {
  const exact = new Map<string, ModelInfo>();
  const normalized = new Map<string, ModelInfo[]>();
  for (const model of models) {
    if (!hasPrice(model)) continue;
    exact.set(pricingKey(model.providerID, model.id), model);
    if (model.modelID && model.modelID !== model.id) {
      exact.set(pricingKey(model.providerID, model.modelID), model);
    }
    const ids = [model.id, model.modelID].filter((id): id is string => !!id);
    for (const id of new Set(ids)) {
      const key = normalizedModelID(id);
      const candidates = normalized.get(key);
      if (candidates) {
        if (!candidates.includes(model)) candidates.push(model);
      } else {
        normalized.set(key, [model]);
      }
    }
  }
  return { exact, normalized };
}

function pricingFor(
  index: PricingIndex,
  providerID: string,
  modelID: string,
): ModelInfo | undefined {
  const exact = index.exact.get(pricingKey(providerID, modelID));
  if (exact) return exact;

  const candidates = index.normalized.get(normalizedModelID(modelID));
  if (!candidates) return undefined;
  return candidates.find((model) => model.providerID === providerID) ?? candidates[0];
}

export function needsCostEstimate(message: CostMessage): boolean {
  return message.cost === 0 && !!message.tokens && !message.error;
}

export function estimateCost(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
  index?: PricingIndex,
): number {
  const pricing = index ?? buildPricingIndex(models);
  let total = 0;
  for (const message of messages) {
    if (message.error || !message.tokens || !message.model) continue;
    const model = pricingFor(pricing, message.model.providerID, message.model.id);
    if (!model) continue;

    const tokens = message.tokens;
    const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
    const cost =
      model.cost
        .filter(
          (entry) => entry.tier?.type === "context" && contextTokens > entry.tier.size,
        )
        .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ??
      model.cost.find((entry) => !entry.tier);
    if (!cost) continue;

    total +=
      (tokens.input * cost.input +
        (tokens.output + tokens.reasoning) * cost.output +
        tokens.cache.read * cost.cache.read +
        tokens.cache.write * cost.cache.write) /
      1_000_000;
  }
  return total;
}

export function combineCosts(
  reportedCost: number,
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): { cost: number; mode: CostMode } {
  const estimatedCost = estimateCost(
    messages.filter(needsCostEstimate),
    models,
    buildPricingIndex(models),
  );
  return {
    cost: reportedCost + estimatedCost,
    mode:
      estimatedCost > 0
        ? reportedCost > 0
          ? "mixed"
          : "estimated"
        : "reported",
  };
}

export function isAssistant(m: SessionMessageInfo): m is SessionMessageAssistant {
  return m.type === "assistant";
}

export function computeTotals(messages: ReadonlyArray<SessionMessageInfo>): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const m of messages) {
    if (!isAssistant(m)) continue;
    t.input += m.tokens?.input ?? 0;
    t.output += m.tokens?.output ?? 0;
    t.reasoning += m.tokens?.reasoning ?? 0;
    t.cacheRead += m.tokens?.cache.read ?? 0;
    t.cacheWrite += m.tokens?.cache.write ?? 0;
    t.cost += m.cost ?? 0;
    t.turns += 1;
  }
  return t;
}

export function sumSessions(
  sessions: ReadonlyArray<SessionInfo>,
  turns: number,
): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const s of sessions) {
    const tk = s.tokens;
    if (!tk) continue;
    t.input += tk.input;
    t.output += tk.output;
    t.reasoning += tk.reasoning;
    t.cacheRead += tk.cache.read;
    t.cacheWrite += tk.cache.write;
    t.cost += s.cost ?? 0;
  }
  t.turns = turns;
  return t;
}

export async function mapWithConcurrency<Input, Output>(
  items: ReadonlyArray<Input>,
  worker: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let next = 0;
  const count = Math.min(FETCH_CONCURRENCY, items.length);

  await Promise.all(
    Array.from({ length: count }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

// Pi-style prompt-overlap heuristic: token counts cannot prove a cache failure.
export function detectCacheMisses(
  messages: ReadonlyArray<SessionMessageInfo>,
  sessionID: string,
): CacheMiss[] {
  const misses: CacheMiss[] = [];
  let previous: SessionMessageAssistant | undefined;
  let previousPrompt = 0;
  let reportedCache = false;
  for (const message of [...messages].sort((a, b) =>
    a.time.created - b.time.created || a.id.localeCompare(b.id)
  )) {
    if (message.type === "compaction" && message.status === "completed") {
      previous = undefined;
      reportedCache = false;
      continue;
    }
    if (!isAssistant(message) || !message.tokens || message.error || message.time.completed === undefined) continue;
    const tokens = message.tokens;
    const prompt = tokens.input + tokens.cache.read + tokens.cache.write;
    if (prompt <= 0) continue;
    const hasCache = tokens.cache.read + tokens.cache.write > 0;
    const missedTokens = Math.min(previousPrompt, prompt) - tokens.cache.read;
    if (previous && (hasCache || reportedCache) && missedTokens > CACHE_MISS_TOKEN_THRESHOLD) {
      misses.push({
        sessionID,
        messageID: message.id,
        missedTokens,
        modelChanged: message.model.providerID !== previous.model.providerID || message.model.id !== previous.model.id,
        idleMs: Math.max(0, message.time.created - (previous.time.completed ?? previous.time.created)),
      });
    }
    previous = message;
    previousPrompt = prompt;
    reportedCache ||= hasCache;
  }
  return misses;
}

async function fetchCachedSessionMessages(
  client: OpenCodeClient,
  sessionID: string,
  cache: SessionMessageCache,
): Promise<SessionMessageInfo[]> {
  const cached = cache.get(sessionID) ?? [];
  const cachedIDs = new Set(cached.map((message) => message.id));
  const fetched: SessionMessageInfo[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: "desc" }),
    });
    fetched.push(...page.data);
    if (cachedIDs.size > 0 && page.data.some((message) => cachedIDs.has(message.id))) {
      break;
    }
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  const merged = new Map<string, SessionMessageInfo>();
  for (const message of cached) merged.set(message.id, message);
  for (const message of fetched) merged.set(message.id, message);
  const messages = [...merged.values()]
    .filter((message) => isAssistant(message) || message.type === "compaction")
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  cache.set(sessionID, messages);
  return messages;
}

export async function fetchSessionMessages(
  client: OpenCodeClient,
  sessionID: string,
  includeCompactions = false,
  cache?: SessionMessageCache,
): Promise<SessionMessageInfo[]> {
  if (cache) {
    const messages = await fetchCachedSessionMessages(client, sessionID, cache);
    return includeCompactions ? messages : messages.filter(isAssistant);
  }

  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      ...(!includeCompactions ? { type: "assistant" as const } : {}),
      limit: 100,
      ...(cursor ? { cursor } : { order: "desc" }),
    });
    messages.push(...page.data.filter((message) => isAssistant(message) || includeCompactions && message.type === "compaction"));
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return messages;
}

export async function fetchDescendants(
  client: OpenCodeClient,
  rootID: string,
  includeCompactions = false,
  cache?: SessionMessageCache,
): Promise<DescendantData> {
  const out: SessionInfo[] = [];
  const visited = new Set([rootID]);
  let level = [rootID];

  while (level.length > 0) {
    const childLists = await mapWithConcurrency(level, async (sessionID) => {
      const children: SessionInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.session.list({
          parentID: sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "desc" }),
        });
        children.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      return children;
    });
    const nextLevel: string[] = [];

    for (const children of childLists) {
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        out.push(child);
        nextLevel.push(child.id);
      }
    }
    level = nextLevel;
  }

  const histories = await mapWithConcurrency(out, async (session) => {
    try {
      const messages = await fetchSessionMessages(client, session.id, includeCompactions, cache);
      return {
        ok: true as const,
        messages: messages.filter(isAssistant),
        costMessages: messages,
        cacheMisses: includeCompactions ? detectCacheMisses(messages, session.id) : [],
      };
    } catch {
      return {
        ok: false as const,
        messages: [] as SessionMessageAssistant[],
        costMessages: [] as SessionMessageInfo[],
        cacheMisses: [] as CacheMiss[],
      };
    }
  });
  const messages = histories.flatMap((history) => history.messages);
  const costMessages = histories.flatMap((history) => history.costMessages);
  const turns = computeTotals(messages).turns;

  return {
    sessions: out,
    messages,
    costMessages,
    turns,
    cacheMisses: histories.flatMap((history) => history.cacheMisses),
    partial: histories.some((history) => !history.ok),
  };
}
