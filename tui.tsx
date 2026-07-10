/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import {
  EMPTY,
  EMPTY_DESCENDANTS,
  computeTotals,
  fetchDescendants,
  sumSessions,
  type DescendantData,
  type TokenTotals,
} from "./usage";

const ID = "opencode-session-tokens-sidebar";
const SIDEBAR_ORDER = 150;

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

type ThemeColor = TuiPluginApi["theme"]["current"]["text"];

function StatRow(props: {
  label: string;
  emoji?: string;
  value: string;
  api: TuiPluginApi;
  emojiColor?: ThemeColor;
  valueColor?: ThemeColor;
}) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row">
        <Show when={props.emoji}>
          <text fg={props.emojiColor ?? props.api.theme.current.textMuted}>
            {props.emoji}{" "}
          </text>
        </Show>
        <text fg={props.api.theme.current.textMuted}>{props.label}</text>
      </box>
      <text fg={props.valueColor ?? props.api.theme.current.text}>
        {props.value}
      </text>
    </box>
  );
}

function Divider(props: { api: TuiPluginApi }) {
  return (
    <box
      height={1}
      border={["top"]}
      borderColor={props.api.theme.current.border}
    />
  );
}

function SessionTokensPanel(props: { api: TuiPluginApi; sessionID: string }) {
  const api = props.api;

  const [tick, setTick] = createSignal(0);
  const [descendants, setDescendants] = createSignal<DescendantData>(
    EMPTY_DESCENDANTS,
  );
  const bump = () => setTick((n) => n + 1);

  let cancelled = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshVersion = 0;
  const scheduleRefresh = () => {
    if (cancelled) return;
    const version = ++refreshVersion;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = undefined;
      if (cancelled) return;
      try {
        const d = await fetchDescendants(api.client, props.sessionID);
        if (cancelled || version !== refreshVersion) return;
        setDescendants(d);
      } catch {
        // Retain the last complete snapshot instead of showing partial totals.
      }
    }, 200);
  };

  const knownIDs = createMemo<Set<string>>(() => {
    const set = new Set<string>();
    for (const d of descendants().sessions) set.add(d.id);
    return set;
  });

  const offUpdated = api.event.on("message.updated", (e) => {
    if (e.properties.info.sessionID === props.sessionID) bump();
    else if (knownIDs().has(e.properties.info.sessionID)) scheduleRefresh();
  });
  const offRemoved = api.event.on("message.removed", (e) => {
    if (e.properties.sessionID === props.sessionID) bump();
    else if (knownIDs().has(e.properties.sessionID)) scheduleRefresh();
  });
  const offSessionCreated = api.event.on("session.created", (e) => {
    const parent = e.properties.info.parentID;
    if (parent === props.sessionID || knownIDs().has(parent ?? "")) {
      scheduleRefresh();
    }
  });
  const offSessionUpdated = api.event.on("session.updated", (e) => {
    const sessionID = e.properties.info.id || e.properties.sessionID;
    const parent = e.properties.info.parentID;
    if (
      sessionID === props.sessionID ||
      parent === props.sessionID ||
      knownIDs().has(sessionID) ||
      knownIDs().has(parent ?? "")
    ) {
      scheduleRefresh();
    }
  });
  const offSessionDeleted = api.event.on("session.deleted", (e) => {
    if (knownIDs().has(e.properties.sessionID)) scheduleRefresh();
  });
  onCleanup(offUpdated);
  onCleanup(offRemoved);
  onCleanup(offSessionCreated);
  onCleanup(offSessionUpdated);
  onCleanup(offSessionDeleted);
  onCleanup(() => {
    cancelled = true;
    if (refreshTimer) clearTimeout(refreshTimer);
  });

  scheduleRefresh();

  const totals = createMemo<TokenTotals>(() => {
    tick();
    const descendantData = descendants();
    const descs = descendantData.sessions;
    if (!api.state.ready) return EMPTY;
    try {
      const base = computeTotals(api.state.session.messages(props.sessionID));
      if (descs.length === 0) return base;
      const sub = sumSessions(descs, descendantData.turns);
      return {
        input: base.input + sub.input,
        output: base.output + sub.output,
        reasoning: base.reasoning + sub.reasoning,
        cacheRead: base.cacheRead + sub.cacheRead,
        cacheWrite: base.cacheWrite + sub.cacheWrite,
        turns: base.turns + sub.turns,
        cost: base.cost + sub.cost,
      };
    } catch {
      return EMPTY;
    }
  });

  const totalTokens = () =>
    totals().input +
    totals().output +
    totals().reasoning +
    totals().cacheRead +
    totals().cacheWrite;
  const fmtCacheX = (): string => {
    const t = totals();
    const base = t.input + t.cacheWrite;
    if (base === 0) return t.cacheRead > 0 ? "∞" : "—";
    return `${(t.cacheRead / base).toFixed(1)}×`;
  };
  const fmtCost = (c: number): string => {
    if (c > 0 && c < 0.01) return "<$0.01";
    return `$${c.toFixed(2)}`;
  };
  const costColor = (c: number): ThemeColor => {
    if (c < 5) return api.theme.current.info;
    if (c < 25) return api.theme.current.warning;
    return api.theme.current.error;
  };

  return (
    <Show when={totals().turns > 0 || totalTokens() > 0 || totals().cost > 0}>
      <box gap={0}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={api.theme.current.text}>
            <b>Session Token Totals</b>
          </text>
          <text fg={api.theme.current.textMuted}>
            ↻ {totals().turns} turn{totals().turns === 1 ? "" : "s"}
          </text>
        </box>
        <box gap={0}>
          <StatRow emoji="↑" label="in" value={fmt(totals().input)} api={api} />
          <StatRow
            emoji="↓"
            label="out"
            value={fmt(totals().output)}
            api={api}
          />
          <StatRow
            emoji="▤"
            label="cache write"
            value={fmt(totals().cacheWrite)}
            api={api}
          />
          <StatRow
            emoji="▤"
            label="cache read"
            value={fmt(totals().cacheRead)}
            api={api}
          />
          <StatRow
            emoji="ø"
            label="cache hit ratio"
            value={fmtCacheX()}
            api={api}
          />
          <Show when={totals().reasoning > 0}>
            <StatRow
              emoji="✦"
              label="think"
              value={fmt(totals().reasoning)}
              api={api}
            />
          </Show>
          <Divider api={api} />
          <StatRow
            emoji="Σ"
            label="total"
            value={fmt(totalTokens())}
            api={api}
            valueColor={api.theme.current.primary}
          />
          <Show when={totals().cost > 0}>
            <StatRow
              emoji="$"
              label="cost"
              value={fmtCost(totals().cost)}
              api={api}
              valueColor={costColor(totals().cost)}
            />
          </Show>
        </box>
      </box>
    </Show>
  );
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        if (!props?.session_id) return null;
        return <SessionTokensPanel api={api} sessionID={props.session_id} />;
      },
    },
  });
};

const pluginModule: TuiPluginModule = {
  id: ID,
  tui,
};

export default pluginModule;
