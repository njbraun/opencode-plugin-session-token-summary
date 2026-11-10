/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { ModelInfo, SessionMessageInfo } from "@opencode/client";
import { For, Show, createEffect, createSignal, on } from "solid-js";
import { version } from "./package.json";
import {
  EMPTY as EMPTY_TOTALS,
  type CacheMiss,
  type CostMode,
  type DescendantData,
  type SessionMessageCache,
  type TokenTotals,
  combineCosts,
  detectCacheMisses,
  fetchSessionMessages,
  fetchDescendants,
  isAssistant,
  needsCostEstimate,
  sumSessions,
} from "./usage";

const id = "opencode-session-tokens-sidebar";
const REFRESH_DELAY_MS = 200;
const INITIAL_RETRY_DELAY_MS = 250;
const INITIAL_RETRY_LIMIT = 5;
const PRICING_TTL_MS = 5 * 60_000;
const CACHE_MISS_TOAST_TOKENS = 20_000;
const CACHE_MISS_IDLE_MS = 5 * 60_000;
const COST_WARNING_USD = 5;
const COST_ERROR_USD = 25;
const METRICS = [
  ["input", "Input tokens"],
  ["output", "Output tokens"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
  ["cacheRatio", "Cache hit"],
  ["reasoning", "Thinking tokens"],
  ["total", "Total tokens"],
  ["cost", "Cost"],
  ["turns", "Turn count"],
] as const;
type Metric = (typeof METRICS)[number][0];
const OPTIONS = [
  ["hideEmpty", "Hide empty rows"],
  ["cachePercentage", "Cache hit as percentage"],
  ["cacheMissNotices", "Show cache-miss notices"],
] as const;
const SETTINGS = [...METRICS, ...OPTIONS];
type Option = (typeof OPTIONS)[number][0];
interface Settings {
  hidden: Metric[];
  hideEmpty: boolean;
  cachePercentage: boolean;
  cacheMissNotices: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  hidden: ["reasoning"],
  hideEmpty: false,
  cachePercentage: false,
  cacheMissNotices: false,
};

interface UsageState extends TokenTotals {
  status: "loading" | "ready" | "error";
  costMode: CostMode;
  error?: string;
  stale?: boolean;
}

const EMPTY: UsageState = {
  ...EMPTY_TOTALS,
  status: "loading",
  costMode: "reported",
  stale: false,
};

const EMPTY_DESCENDANTS: DescendantData = {
  sessions: [],
  messages: [],
  costMessages: [],
  turns: 0,
  cacheMisses: [],
  partial: false,
};

export function fmt(n: number): string {
  if (n >= 1_000) {
    const thousands = Math.round(n / 100) / 10;
    if (thousands < 1_000) return `${thousands}K`;
    return `${Math.round(n / 100_000) / 10}M`;
  }
  return String(Math.round(n));
}

export function fmtCost(c: number): string {
  if (c > 0 && c < 0.01) return "<$0.01";
  return "$" + c.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Failed to load session usage";
}

export default Plugin.define({
  id,
  setup(context) {
    let disposed = false;
    let loadID = 0;
    let lastSessionID = "";
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let initialFailures = 0;
    let refreshing: Promise<void> | undefined;
    let refreshingSessionID = "";
    let refreshQueued = false;
    let knownSessionIDs = new Set<string>();
    let pricingCache: { at: number; models: ModelInfo[] } | undefined;
    const seenMisses = new Map<string, Set<string>>();
    const messageCache: SessionMessageCache = new Map();
    const [state, setState] = createSignal<UsageState>({ ...EMPTY });
    const [settings, updateSettings] = context.storage.store<Settings>("settings", {
      initial: { ...DEFAULT_SETTINGS, hidden: [...DEFAULT_SETTINGS.hidden] },
    });
    const hiddenMetrics = (): Metric[] =>
      Array.isArray(settings.hidden) ? settings.hidden : DEFAULT_SETTINGS.hidden;
    const visible = (metric: Metric, value?: number) =>
      !hiddenMetrics().includes(metric) && (!settings.hideEmpty || value !== 0);
    const toggleSetting = (key: Metric | Option) => {
      void updateSettings((draft) => {
        if (key === "hideEmpty" || key === "cachePercentage" || key === "cacheMissNotices") {
          draft[key] = !draft[key];
        } else {
          const hidden = Array.isArray(draft.hidden) ? draft.hidden : [...DEFAULT_SETTINGS.hidden];
          draft.hidden = hidden.includes(key)
            ? hidden.filter((metric) => metric !== key)
            : [...hidden, key];
        }
      }).catch(() => {
        context.ui.toast.show({ message: "Could not save sidebar preferences", variant: "error" });
      });
    };
    const openSettings = () => {
      context.ui.dialog.show(() => {
        const [selected, setSelected] = createSignal(0);
        const dimensions = useTerminalDimensions();
        let scroll: ScrollBoxRenderable | undefined;
        const scrollSelectedIntoView = () => {
          if (!scroll || scroll.isDestroyed) return;
          const setting = SETTINGS[selected()];
          if (selected() === 0) scroll.scrollTo(0);
          else if (setting) scroll.scrollChildIntoView(`${id}.setting.${setting[0]}`);
        };
        return (
          <box
            gap={1} padding={1} maxHeight="100%" focusable focused
            onKeyDown={(event) => {
              if (event.name === "down" || (event.name === "tab" && !event.shift)) {
                setSelected((index) => (index + 1) % (SETTINGS.length + 1));
              } else if (event.name === "up" || (event.name === "tab" && event.shift)) {
                setSelected((index) => (index + SETTINGS.length) % (SETTINGS.length + 1));
              } else if (event.name === "return" || event.name === "space") {
                const setting = SETTINGS[selected()];
                if (setting) toggleSetting(setting[0]);
                else context.ui.dialog.clear();
              } else if (event.name === "escape") {
                context.ui.dialog.clear();
              } else return;
              scrollSelectedIntoView();
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <text flexShrink={0} fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
              {`Session Token Summary · v${version}`}
            </text>
            <scrollbox
              ref={(value) => { scroll = value; }}
              // Leave space for the dialog chrome, title, and footer.
              height={Math.min(SETTINGS.length + 3, Math.max(2, dimensions().height - 12))}
              flexShrink={0} focusable={false}
              contentOptions={{ gap: 1 }}
              onSizeChange={() => queueMicrotask(scrollSelectedIntoView)}
            >
              <box flexShrink={0}>
                <text fg={context.theme.text.muted} attributes={TextAttributes.BOLD}>Show/hide</text>
                <For each={METRICS}>{([key, label], index) => (
                  <text
                    id={`${id}.setting.${key}`} flexShrink={0}
                    selectable={false}
                    fg={context.theme.text.base}
                    attributes={selected() === index() ? TextAttributes.BOLD : 0}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return;
                      setSelected(index());
                      toggleSetting(key);
                    }}
                  >
                    {`${visible(key) ? "[x]" : "[ ]"} ${label}`}
                  </text>
                )}</For>
              </box>
              <box flexShrink={0}>
                <text fg={context.theme.text.muted} attributes={TextAttributes.BOLD}>Options</text>
                <For each={OPTIONS}>{([key, label], index) => (
                  <text
                    id={`${id}.setting.${key}`} flexShrink={0}
                    selectable={false}
                    fg={context.theme.text.base}
                    attributes={selected() === METRICS.length + index() ? TextAttributes.BOLD : 0}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return;
                      setSelected(METRICS.length + index());
                      toggleSetting(key);
                    }}
                  >
                    {`${settings[key] ? "[x]" : "[ ]"} ${label}`}
                  </text>
                )}</For>
              </box>
            </scrollbox>
            <text
              flexShrink={0}
              selectable={false}
              fg={context.theme.text.base}
              attributes={selected() === SETTINGS.length ? TextAttributes.BOLD : 0}
              onMouseUp={(event) => { if (event.button === 0) context.ui.dialog.clear(); }}
            >Close</text>
            <text flexShrink={0} fg={context.theme.text.muted}>↑/↓ select · Space toggle · Esc close</text>
          </box>
        );
      });
      context.ui.dialog.set({ size: "medium", centered: true });
    };
    context.keymap.layer(() => ({
      commands: [{
        id: `${id}.settings`,
        title: "Customize Session Token Summary",
        palette: true,
        run: openSettings,
      }],
    }));

    const scheduleRefresh = () => {
      if (disposed || !lastSessionID) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh(lastSessionID);
      }, REFRESH_DELAY_MS);
    };

    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const loadModels = async (): Promise<ModelInfo[]> => {
      if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) {
        return pricingCache.models;
      }
      const result = await context.client.model.list({ location: context.location });
      pricingCache = { at: Date.now(), models: result.data };
      return result.data;
    };

    const runRefresh = async (sessionID: string) => {
      const currentLoadID = ++loadID;
      const showCacheMisses = settings.cacheMissNotices === true;
      const rootMessagesPromise = fetchSessionMessages(context.client, sessionID, true, messageCache)
        .then((messages) => ({ ok: true as const, messages }))
        .catch(() => ({ ok: false as const, messages: [] as SessionMessageInfo[] }));

      try {
        const [root, descendants, rootResult] = await Promise.all([
          context.client.session.get({ sessionID }),
          fetchDescendants(context.client, sessionID, true, messageCache).catch(() => ({
            ...EMPTY_DESCENDANTS,
            partial: true,
          })),
          rootMessagesPromise,
        ]);
        if (disposed || currentLoadID !== loadID) return;

        knownSessionIDs = new Set([sessionID, ...descendants.sessions.map((session) => session.id)]);
        const rootMessages = rootResult.messages;
        const rootAssistantMessages = rootMessages.filter(isAssistant);
        const costMessages = [
          ...rootMessages.filter((message) => isAssistant(message) || message.type === "compaction"),
          ...descendants.costMessages,
        ];
        const turns = rootAssistantMessages.length + descendants.turns;
        const totals: UsageState = {
          ...sumSessions([root, ...descendants.sessions], turns),
          status: "ready",
          costMode: "reported",
          stale: descendants.partial || !rootResult.ok,
        };

        // Show token totals immediately; pricing is optional and may arrive later.
        setState(totals);
        initialFailures = 0;
        clearRetry();

        if (costMessages.some(needsCostEstimate)) {
          try {
            const models = await loadModels();
            const combined = combineCosts(totals.cost, costMessages, models);
            if (disposed || currentLoadID !== loadID) return;
            setState({ ...totals, cost: combined.cost, costMode: combined.mode });
          } catch {
            // Pricing is optional; session totals remain available when it cannot load.
          }
        }

        if (showCacheMisses) {
          const misses = [...detectCacheMisses(rootMessages, sessionID), ...descendants.cacheMisses];
          const bySession = new Map<string, CacheMiss[]>();
          for (const miss of misses) {
            const current = bySession.get(miss.sessionID);
            if (current) current.push(miss);
            else bySession.set(miss.sessionID, [miss]);
          }
          for (const [id, sessionMisses] of bySession) {
            const seen = seenMisses.get(id);
            const baseline = seen ?? new Set<string>();
            const fresh: CacheMiss[] = [];
            for (const miss of sessionMisses) {
              if (miss.missedTokens >= CACHE_MISS_TOAST_TOKENS) {
                if (seen && !seen.has(miss.messageID)) fresh.push(miss);
                baseline.add(miss.messageID);
              }
            }
            seenMisses.set(id, baseline);
            if (fresh.length === 1) {
              const miss = fresh[0]!;
              const reason = miss.modelChanged ? " after model switch"
                : miss.idleMs >= CACHE_MISS_IDLE_MS ? ` after ${Math.round(miss.idleMs / 60_000)}m idle` : "";
              context.ui.toast.show({
                title: `Possible cache miss${reason}`,
                message: `${fmt(miss.missedTokens)} previously processed tokens weren’t read from cache.`,
                variant: "warning",
                sessionID: miss.sessionID,
              });
            } else if (fresh.length > 1) {
              const missedTokens = fresh.reduce((sum, miss) => sum + miss.missedTokens, 0);
              context.ui.toast.show({
                title: "Possible cache misses",
                message: `${fmt(missedTokens)} previously processed tokens across ${fresh.length} messages weren’t read from cache.`,
                variant: "warning",
                sessionID: id,
              });
            }
          }
          for (const id of knownSessionIDs) {
            if (!seenMisses.has(id)) seenMisses.set(id, new Set());
          }
          if (!descendants.partial) {
            for (const id of seenMisses.keys()) {
              if (!knownSessionIDs.has(id)) seenMisses.delete(id);
            }
          }
        }

        if (!descendants.partial) {
          for (const id of messageCache.keys()) {
            if (!knownSessionIDs.has(id)) messageCache.delete(id);
          }
        }
      } catch (error) {
        if (disposed || currentLoadID !== loadID) return;
        if (state().status === "ready") {
          setState({ ...state(), stale: true });
          return;
        }
        // The slot can receive a session ID before the server has loaded it.
        // Retry briefly instead of flashing a red "session not found" error.
        if (initialFailures < INITIAL_RETRY_LIMIT) {
          initialFailures += 1;
          clearRetry();
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (!disposed) void refresh(lastSessionID);
          }, INITIAL_RETRY_DELAY_MS);
          return;
        }
        setState({ ...EMPTY, status: "error", error: errorMessage(error) });
      }
    };

    const refresh = (sessionID: string): Promise<void> => {
      if (disposed || !sessionID) return Promise.resolve();
      clearRetry();
      if (refreshing && refreshingSessionID === sessionID) {
        refreshQueued = true;
        return refreshing;
      }
      if (refreshing) refreshQueued = false;

      const run = runRefresh(sessionID).finally(() => {
        if (refreshing !== run) return;
        refreshing = undefined;
        refreshingSessionID = "";
        if (!disposed && refreshQueued) {
          refreshQueued = false;
          void refresh(lastSessionID);
        }
      });
      refreshing = run;
      refreshingSessionID = sessionID;
      return run;
    };

    const refreshForKnownSession = (sessionID: string) => {
      if (knownSessionIDs.has(sessionID)) scheduleRefresh();
    };

    createEffect(on(() => settings.cacheMissNotices, () => {
      seenMisses.clear();
      ++loadID;
      scheduleRefresh();
    }, { defer: true }));

    const stopStepEnded = context.data.on("session.step.ended", (event) => {
      if (settings.cacheMissNotices) refreshForKnownSession(event.data.sessionID);
    });
    const stopUsageUpdate = context.data.on("session.usage.updated", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });
    const stopExecution = context.data.on("session.execution.succeeded", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });
    const stopSessionCreated = context.data.on("session.created", (event) => {
      if (event.data.parentID && knownSessionIDs.has(event.data.parentID)) {
        if (!knownSessionIDs.has(event.data.sessionID) && settings.cacheMissNotices) {
          seenMisses.set(event.data.sessionID, new Set());
        }
        knownSessionIDs.add(event.data.sessionID);
        ++loadID;
        scheduleRefresh();
      }
    });
    const stopSessionDeleted = context.data.on("session.deleted", (event) => {
      messageCache.delete(event.data.sessionID);
      seenMisses.delete(event.data.sessionID);
      refreshForKnownSession(event.data.sessionID);
    });
    const stopCompaction = context.data.on("session.compaction.ended", (event) => {
      messageCache.delete(event.data.sessionID);
      seenMisses.delete(event.data.sessionID);
      ++loadID;
      refreshForKnownSession(event.data.sessionID);
    });
    const stopRevert = context.data.on("session.revert.committed", (event) => {
      messageCache.delete(event.data.sessionID);
      seenMisses.delete(event.data.sessionID);
      ++loadID;
      refreshForKnownSession(event.data.sessionID);
    });
    const stopFork = context.data.on("session.forked", (event) => {
      messageCache.delete(event.data.sessionID);
      messageCache.delete(event.data.parentID);
      seenMisses.delete(event.data.sessionID);
      ++loadID;
      refreshForKnownSession(event.data.parentID);
    });

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        createEffect(() => {
          const sessionID = props.sessionID;
          if (!sessionID) {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = undefined;
            clearRetry();
            initialFailures = 0;
            ++loadID;
            refreshQueued = false;
            lastSessionID = "";
            knownSessionIDs = new Set();
            seenMisses.clear();
            setState({ ...EMPTY, status: "error", error: "No session selected" });
            return;
          }
          if (sessionID !== lastSessionID) {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = undefined;
            clearRetry();
            initialFailures = 0;
            ++loadID;
            refreshQueued = false;
            lastSessionID = sessionID;
            knownSessionIDs = new Set([sessionID]);
            seenMisses.clear();
            setState({ ...EMPTY });
            void refresh(sessionID);
          }
        });

        const totalTokens = () => {
          const usage = state();
          return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
        };
        const cacheHit = () => {
          const usage = state();
          const base = usage.input + usage.cacheWrite;
          if (settings.cachePercentage) {
            const total = base + usage.cacheRead;
            return total === 0 ? "—" : `${(usage.cacheRead / total * 100).toFixed(1)}%`;
          }
          if (base === 0) return usage.cacheRead > 0 ? "∞" : "—";
          return `${(usage.cacheRead / base).toFixed(1)}×`;
        };
        const costColor = () => {
          if (state().cost < COST_WARNING_USD) return context.theme.text.feedback.info.base;
          if (state().cost < COST_ERROR_USD) return context.theme.text.feedback.warning.base;
          return context.theme.text.feedback.error.base;
        };

        return (
          <box gap={0}>
            <box flexDirection="row" justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <text
                  selectable={false}
                  fg={context.theme.text.base} attributes={TextAttributes.BOLD}
                  onMouseUp={(event) => { if (event.button === 0) openSettings(); }}
                >Session Token Summary</text>
                <Show when={state().stale}>
                  <text fg={context.theme.text.muted}>{"⚠ stale"}</text>
                </Show>
              </box>
              <Show when={visible("turns", state().turns)}>
                <text fg={context.theme.text.muted}>{"↻ " + state().turns + " turn" + (state().turns === 1 ? "" : "s")}</text>
              </Show>
            </box>
            <Show when={state().status === "loading"}>
              <text fg={context.theme.text.muted}>Loading…</text>
            </Show>
            <Show when={state().status === "error"}>
              <text fg={context.theme.text.feedback.error.base}>{state().error || "Unknown error"}</text>
            </Show>
            <Show when={state().status === "ready"}>
              <box gap={0}>
                <Show when={visible("input", state().input)}>
                  <UsageRow label="↑ input" value={fmt(state().input)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("output", state().output)}>
                  <UsageRow label="↓ output" value={fmt(state().output)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("cacheWrite", state().cacheWrite)}>
                  <UsageRow label="▤ cache write" value={fmt(state().cacheWrite)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("cacheRead", state().cacheRead)}>
                  <UsageRow label="▤ cache read" value={fmt(state().cacheRead)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("cacheRatio", state().cacheRead)}>
                  <UsageRow label="ø cache hit" value={cacheHit()} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("reasoning", state().reasoning)}>
                  <UsageRow label="✦ think" value={fmt(state().reasoning)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("total", totalTokens())}>
                  <box height={1} border={["top"]} borderColor={context.theme.border.base} />
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.muted}>Σ total</text>
                    <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>{fmt(totalTokens())}</text>
                  </box>
                </Show>
                <Show when={visible("cost", state().cost)}>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.muted}>
                      {state().costMode === "estimated"
                        ? "$ est. cost"
                        : state().costMode === "mixed"
                          ? "$ cost incl. est."
                          : "$ cost"}
                    </text>
                    <text fg={costColor()}>{fmtCost(state().cost)}</text>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        );
      },
    });

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      clearRetry();
      stopUsageUpdate();
      stopStepEnded();
      stopExecution();
      stopSessionCreated();
      stopSessionDeleted();
      stopCompaction();
      stopRevert();
      stopFork();
      stopSlot();
    };
  },
});

function UsageRow(props: { label: string; value: string; labelColor: RGBA; valueColor: RGBA }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.labelColor}>{props.label}</text>
      <text fg={props.valueColor}>{props.value}</text>
    </box>
  );
}
