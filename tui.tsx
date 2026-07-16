/** @jsxImportSource @opentui/solid */

// Token-usage sidebar. Usage is loaded via the HTTP client (session.list ->
// subtree -> session.messages) and aggregated from assistant messages, then
// refreshed on session lifecycle events. This client+event model is used
// because reading the reactive `api.state.session` store did not repaint the
// slot reliably in the host TUI.
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";

const id = "opencode-session-tokens-sidebar";
const SIDEBAR_ORDER = 150;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const REFRESH_DELAY_MS = 200;

interface SessionInfo {
  id: string;
  parentID?: string;
  cost?: number;
}

interface AssistantMessageInfo {
  role: "assistant" | string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

interface UsageState {
  status: "loading" | "ready" | "error";
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  error?: string;
}

interface SessionSelectEvent {
  properties?: { sessionID?: string };
}

interface TuiSlotProps {
  session_id?: string;
}

const EMPTY: UsageState = {
  status: "loading",
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.trunc(n));
}

function fmtCost(c: number): string {
  if (c > 0 && c < 0.01) return "<$0.01";
  return "$" + c.toFixed(2);
}

function costColor(c: number, api: Parameters<TuiPlugin>[0]) {
  if (c < 5) return api.theme.current.info;
  if (c < 25) return api.theme.current.warning;
  return api.theme.current.error;
}

function buildSessionIndex(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const index = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const pid = s.parentID || "";
    let list = index.get(pid);
    if (!list) {
      list = [];
      index.set(pid, list);
    }
    list.push(s);
  }
  return index;
}

function gatherSubtree(
  rootId: string,
  index: Map<string, SessionInfo[]>,
): Set<string> {
  const subtree = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const sid = queue.shift()!;
    if (subtree.has(sid)) continue;
    subtree.add(sid);
    const children = index.get(sid) || [];
    for (const child of children) {
      if (!subtree.has(child.id)) queue.push(child.id);
    }
  }
  return subtree;
}

function aggregate(messages: AssistantMessageInfo[]): UsageState {
  const totals: UsageState = { ...EMPTY, status: "ready" };
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    totals.input += m.tokens?.input || 0;
    totals.output += m.tokens?.output || 0;
    totals.reasoning += m.tokens?.reasoning || 0;
    totals.cacheRead += m.tokens?.cache?.read || 0;
    totals.cacheWrite += m.tokens?.cache?.write || 0;
    totals.cost += m.cost || 0;
    totals.turns += 1;
  }
  return totals;
}

const tui: TuiPlugin = async (api) => {
  let disposed = false;
  let loadId = 0;
  let lastSessionId = "";
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let knownSessionIds = new Set<string>();

  const [state, setState] = createSignal<UsageState>({ ...EMPTY });

  function scheduleRefresh() {
    if (disposed || !lastSessionId) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      load(lastSessionId);
    }, REFRESH_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // load() — mirrors opencode-costs exactly (session.list + subtree + messages)
  // ---------------------------------------------------------------------------
  async function load(sessionId: string) {
    if (disposed || !sessionId) return;
    const myLoadId = ++loadId;

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const dir = api.state.path.directory;
        const sessionsRes = await api.client.session.list({ directory: dir });
        if (disposed || myLoadId !== loadId) return;

        const sessions: SessionInfo[] = sessionsRes.data || [];
        const index = buildSessionIndex(sessions);
        const subtree = gatherSubtree(sessionId, index);
        knownSessionIds = subtree;

        const totals: UsageState = { ...EMPTY, status: "ready" };
        for (const sid of subtree) {
          const msgRes = await api.client.session.messages({
            sessionID: sid,
            directory: dir,
          });
          if (disposed || myLoadId !== loadId) return;
          const messages: AssistantMessageInfo[] = [];
          for (const entry of msgRes.data || []) {
            const info = entry?.info as AssistantMessageInfo | undefined;
            if (info && info.role === "assistant") messages.push(info);
          }

          const sessionTotals = aggregate(messages);
          totals.input += sessionTotals.input;
          totals.output += sessionTotals.output;
          totals.reasoning += sessionTotals.reasoning;
          totals.cacheRead += sessionTotals.cacheRead;
          totals.cacheWrite += sessionTotals.cacheWrite;
          totals.turns += sessionTotals.turns;

          // Session totals include costs even when message payloads do not.
          const session = sessions.find((entry) => entry.id === sid);
          totals.cost += session?.cost ?? sessionTotals.cost;
        }

        if (disposed || myLoadId !== loadId) return;
        setState(totals);
        return;
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e);

        try {
          await api.client.app.log({
            service: id,
            level: "error",
            message: `Failed to load usage (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError}`,
          });
        } catch {
          // Logging must not interrupt retries.
        }

        if (attempt < MAX_RETRIES) {
          await new Promise((r) =>
            setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)),
          );
          if (disposed || myLoadId !== loadId) return;
        }
      }
    }

    // Keep a complete snapshot visible when a background refresh fails.
    if (state().status !== "ready") {
      setState({ ...EMPTY, status: "error", error: lastError || "Failed" });
    }
  }

  // ---------------------------------------------------------------------------
  // Reactive effect — event subscriptions (identical to opencode-costs)
  // ---------------------------------------------------------------------------
  createEffect(() => {
    const u1 = api.event.on("message.updated", (event) => {
      if (knownSessionIds.has(event.properties.info.sessionID)) scheduleRefresh();
    });
    const u2 = api.event.on("message.removed", (event) => {
      if (knownSessionIds.has(event.properties.sessionID)) scheduleRefresh();
    });
    const u3 = api.event.on("session.created", (event) => {
      const parentId = event.properties.info.parentID;
      if (parentId && knownSessionIds.has(parentId)) scheduleRefresh();
    });
    const u4 = api.event.on("session.updated", (event) => {
      const info = event.properties.info;
      if (
        knownSessionIds.has(info.id) ||
        (info.parentID && knownSessionIds.has(info.parentID))
      ) {
        scheduleRefresh();
      }
    });
    const u5 = api.event.on("session.deleted", (event) => {
      if (knownSessionIds.has(event.properties.info.id)) scheduleRefresh();
    });
    const u6 = api.event.on("tui.session.select", (e: SessionSelectEvent) => {
      const newSid = e?.properties?.sessionID;
      if (newSid) {
        lastSessionId = newSid;
        knownSessionIds = new Set([newSid]);
        setState({ ...EMPTY });
        load(newSid);
      }
    });

    onCleanup(() => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
    });
  });

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx: unknown, props: TuiSlotProps) {
        const sid = props?.session_id;
        if (!sid) return null;
        if (sid && sid !== lastSessionId) {
          lastSessionId = sid;
          knownSessionIds = new Set([sid]);
          setState({ ...EMPTY });
          load(sid);
        }

        const totalTokens = () => {
          const s = state();
          return (
            s.input + s.output + s.reasoning + s.cacheRead + s.cacheWrite
          );
        };
        const cacheRatio = () => {
          const s = state();
          const base = s.input + s.cacheWrite;
          if (base === 0) return s.cacheRead > 0 ? "∞" : "—";
          return `${(s.cacheRead / base).toFixed(1)}×`;
        };

        return (
          <Show
            when={
              state().status !== "ready" ||
              state().turns > 0 ||
              totalTokens() > 0 ||
              state().cost > 0
            }
          >
            <box gap={0}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={api.theme.current.text}>
                <b>Session Token Summary</b>
              </text>
              <text fg={api.theme.current.textMuted}>
                {"↻ " + state().turns + " turn" + (state().turns === 1 ? "" : "s")}
              </text>
            </box>
            <Show when={state().status === "loading"}>
              <text fg={api.theme.current.textMuted}>Loading…</text>
            </Show>
            <Show when={state().status === "error"}>
              <text fg={api.theme.current.error}>
                {state().error || "Unknown error"}
              </text>
            </Show>
            <Show when={state().status === "ready"}>
              <box gap={0}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={api.theme.current.textMuted}>↑ in</text>
                  <text fg={api.theme.current.text}>{fmt(state().input)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={api.theme.current.textMuted}>↓ out</text>
                  <text fg={api.theme.current.text}>{fmt(state().output)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={api.theme.current.textMuted}>▤ cache write</text>
                  <text fg={api.theme.current.text}>
                    {fmt(state().cacheWrite)}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={api.theme.current.textMuted}>▤ cache read</text>
                  <text fg={api.theme.current.text}>
                    {fmt(state().cacheRead)}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={api.theme.current.textMuted}>ø cache hit ratio</text>
                  <text fg={api.theme.current.text}>{cacheRatio()}</text>
                </box>
                <Show when={state().reasoning > 0}>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={api.theme.current.textMuted}>✦ think</text>
                    <text fg={api.theme.current.text}>
                      {fmt(state().reasoning)}
                    </text>
                  </box>
                </Show>
                <box
                  height={1}
                  border={["top"]}
                  borderColor={api.theme.current.border}
                />
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={api.theme.current.textMuted}>Σ total</text>
                  <text fg={api.theme.current.primary}>
                    {fmt(totalTokens())}
                  </text>
                </box>
                <Show when={state().cost > 0}>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={api.theme.current.textMuted}>$ cost</text>
                    <text fg={costColor(state().cost, api)}>
                      {fmtCost(state().cost)}
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
            </box>
          </Show>
        );
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
