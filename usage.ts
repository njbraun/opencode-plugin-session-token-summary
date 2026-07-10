import type {
  AssistantMessage,
  Message,
  OpencodeClient,
  Session,
} from "@opencode-ai/sdk/v2";

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
  sessions: ReadonlyArray<Session>;
  turns: number;
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

export const EMPTY_DESCENDANTS: DescendantData = { sessions: [], turns: 0 };
const FETCH_CONCURRENCY = 4;

export function isAssistant(m: Message): m is AssistantMessage {
  return m.role === "assistant";
}

export function computeTotals(messages: ReadonlyArray<Message>): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const m of messages) {
    if (!isAssistant(m)) continue;
    t.input += m.tokens.input;
    t.output += m.tokens.output;
    t.reasoning += m.tokens.reasoning;
    t.cacheRead += m.tokens.cache.read;
    t.cacheWrite += m.tokens.cache.write;
    t.cost += m.cost ?? 0;
    t.turns += 1;
  }
  return t;
}

export function sumSessions(
  sessions: ReadonlyArray<Session>,
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

export async function fetchDescendants(
  client: OpencodeClient,
  rootID: string,
): Promise<DescendantData> {
  const out: Session[] = [];
  const visited = new Set([rootID]);
  let level = [rootID];

  while (level.length > 0) {
    const childLists = await mapWithConcurrency(level, async (sessionID) => {
      const res = await client.session.children({ sessionID });
      return res.data ?? [];
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

  const messages = await mapWithConcurrency(out, async (session) => {
    const res = await client.session.messages({ sessionID: session.id });
    return res.data ?? [];
  });
  const turns = messages.flat().filter((message) => isAssistant(message.info)).length;

  return { sessions: out, turns };
}
