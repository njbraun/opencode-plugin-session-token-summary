import { expect, test } from "bun:test";
import type { Context, KeymapCommand, SlotClaim, ToastOptions } from "@opencode/plugin/tui/context";
import type { ModelInfo as Model, OpenCodeClient, SessionInfo as Session, SessionMessageInfo } from "@opencode/client";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender, type JSX } from "@opentui/solid";
import { Show, createComponent, createSignal } from "solid-js";
import { version } from "../package.json";
import plugin from "../tui";
import { assistant, cacheRequest, clientFor, session, storageFor } from "./helpers";

test("V2 plugin renders, switches sessions, retains totals on failure, and cleans up", async () => {
  expect(plugin.id).toBe("opencode-session-tokens-sidebar");
  expect(typeof plugin.setup).toBe("function");
  const client = clientFor({ root: [session("child")] }, {
    root: [assistant("root-turn")], child: [assistant("child-turn")],
    other: [assistant("other-turn")],
  });
  const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>();
  const color = RGBA.fromHex("#c6d0f5");
  const muted = RGBA.fromHex("#949cbb");
  const accent = RGBA.fromHex("#8caaee");
  const border = RGBA.fromHex("#51576d");
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let select: (id: string) => void;
  let slotRemoved = false;
  const context = {
    client,
    storage: storageFor({}),
    keymap: { layer() {} },
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) {
        claim = value;
        return () => { slotRemoved = true; };
      },
    },
    theme: {
      text: {
        base: color, muted,
        feedback: { info: { base: accent }, warning: { base: color }, error: { base: color } },
      },
      border: { base: border },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    const [selected, setSelected] = createSignal("root");
    select = setSelected;
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ get sessionID() { return selected(); } });
  }, { width: 60, height: 20 });
  try {
    await view.waitForFrame((frame) => frame.includes("2 turns"));
    expect(view.captureCharFrame()).toContain("Session Token Summary");
    expect(view.captureCharFrame()).toContain("$2.00");
    const spans = view.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.find((span) => span.text.includes("Session Token Summary"))?.fg.equals(color)).toBe(true);
    expect(spans.find((span) => span.text.includes("2 turns"))?.fg.equals(muted)).toBe(true);
    expect(spans.find((span) => span.text.includes("↑ input"))?.fg.equals(muted)).toBe(true);
    expect(spans.find((span) => span.text.trim() === "100")?.fg.equals(color)).toBe(true);
    expect(spans.find((span) => span.text.includes("─"))?.fg.equals(border)).toBe(true);
    const total = spans.find((span) => span.text.trim() === "132");
    expect(total?.fg.equals(color)).toBe(true);
    expect((total?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(spans.find((span) => span.text.includes("$2.00"))?.fg.equals(accent)).toBe(true);

    const quota = assistant("quota");
    quota.cost = 0;
    client.message.list = async ({ sessionID }) => ({
      data: sessionID === "root" ? [quota] : [assistant("other-turn")], cursor: {},
    });
    const pricing = Promise.withResolvers<{ data: Model[]; location: { directory: string } }>();
    let pricingStarted = false;
    client.model = {
      list: async () => { pricingStarted = true; return pricing.promise; },
    } as OpenCodeClient["model"];
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    expect(pricingStarted).toBe(true);
    select!("other");
    await view.waitForFrame((frame) => frame.includes("1 turn"));
    expect(view.captureCharFrame()).toContain("$1.00");
    pricing.resolve({ data: [], location: { directory: "/" } });
    await view.flush();
    expect(view.captureCharFrame()).toContain("1 turn");
    expect(view.captureCharFrame()).not.toContain("2 turns");

    client.session.get = async () => { throw new Error("unavailable"); };
    handlers.get("session.usage.updated")!({ data: { sessionID: "other" } });
    await Bun.sleep(250);
    await view.flush();
    expect(view.captureCharFrame()).toContain("$1.00");
    expect(view.captureCharFrame()).not.toContain("unavailable");
    expect(view.captureCharFrame()).toContain("stale");
    handlers.get("session.usage.updated")!({ data: { sessionID: "other" } });
    cleanup!();
    expect(handlers.size).toBe(0);
    expect(slotRemoved).toBe(true);
  } finally {
    if (!slotRemoved) cleanup?.();
    await view.dispose();
  }
});

test("shows a selection error instead of loading forever when no session is selected", async () => {
  const color = RGBA.fromHex("#c6d0f5");
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  const context = {
    client: clientFor({}, {}),
    storage: storageFor({}),
    keymap: { layer() {} },
    data: { on: () => () => {} },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) { claim = value; return () => {}; },
    },
    theme: {
      text: { base: color, muted: color, feedback: { info: { base: color }, warning: { base: color }, error: { base: color } } },
      border: { base: color },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ sessionID: "" });
  }, { width: 60, height: 20 });
  try {
    await view.waitForFrame((frame) => frame.includes("No session selected"));
    expect(view.captureCharFrame()).toContain("No session selected");
  } finally {
    cleanup?.();
    await view.dispose();
  }
});

test("retries a transient session lookup instead of flashing an error", async () => {
  const color = RGBA.fromHex("#c6d0f5");
  const client = clientFor({ root: [session("child")] }, {
    root: [assistant("root-turn")], child: [assistant("child-turn")],
  });
  let attempts = 0;
  const getSession = client.session.get;
  client.session.get = async (input) => {
    attempts += 1;
    if (attempts < 3) throw new Error("session not found");
    return getSession(input);
  };
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  const context = {
    client,
    storage: storageFor({}),
    keymap: { layer() {} },
    data: { on: () => () => {} },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) { claim = value; return () => {}; },
    },
    theme: {
      text: { base: color, muted: color, feedback: { info: { base: color }, warning: { base: color }, error: { base: color } } },
      border: { base: color },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ sessionID: "root" });
  }, { width: 60, height: 20 });
  try {
    await Bun.sleep(100);
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("session not found");
    await Bun.sleep(800);
    await view.flush();
    expect(view.captureCharFrame()).toContain("2 turns");
    expect(attempts).toBeGreaterThanOrEqual(3);
  } finally {
    cleanup?.();
    await view.dispose();
  }
});

test("sidebar settings support mouse, keyboard, version display, persistence, and save errors", async () => {
  const saved: Record<string, object> = {};
  const storage = storageFor(saved);
  let failSave = false;
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let command: KeymapCommand;
  let saveError = "";
  const client = clientFor({}, { root: [assistant("turn")] });
  const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>();
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>();
  const color = RGBA.fromHex("#c6d0f5");
  const context = {
    client,
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    storage: {
      store<Value extends object>(key: string, options: { initial: Value }) {
        const [state, update] = storage.store(key, options);
        return [state, async (mutation: (draft: Value) => void) => {
          if (failSave) throw new Error("disk full");
          await update(mutation);
        }] as const;
      },
    },
    keymap: { layer: (factory: () => { commands: KeymapCommand[] }) => { command = factory().commands[0]; } },
    ui: {
      slot: (value: SlotClaim<"sidebar.content">) => { claim = value; return () => {}; },
      dialog: {
        show: (render: () => JSX.Element) => { setDialog(() => render); },
        set: () => {},
        clear: () => { setDialog(undefined); },
      },
      toast: { show: ({ message }: { message: string }) => { saveError = message; } },
    },
    theme: {
      text: {
        base: color, muted: color,
        feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
      },
      border: { base: color },
    },
  } as unknown as Context;
  const render = () => {
    cleanup = plugin.setup(context) as () => void;
    return [claim.render({ sessionID: "root" }), createComponent(() => Show({
      get when() { return dialog(); },
      keyed: true,
      children: (render: () => JSX.Element) => render(),
    }), {})];
  };
  const view = await testRender(render, { width: 60, height: 40 });
  const clickText = async (text: string, button: 0 | 2 = 0, target = view) => {
    const lines = target.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    expect(y).toBeGreaterThanOrEqual(0);
    await target.mockMouse.click(lines[y].indexOf(text), y, button);
    await target.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("↑ input"));
    await clickText("Session Token Summary", 2);
    expect(dialog()).toBeUndefined();
    await clickText("Session Token Summary");
    await view.waitForFrame((frame) => frame.includes(`Session Token Summary · v${version}`));
    expect(view.captureCharFrame()).toContain("Show/hide");
    expect(view.captureCharFrame()).toContain("Options");
    expect(view.captureCharFrame()).toContain("[ ] Show cache-miss notices");
    await clickText("[ ] Show cache-miss notices");
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    await clickText("[x] Show cache-miss notices");
    expect(view.captureCharFrame()).toContain("[ ] Thinking tokens");
    expect(view.captureCharFrame()).not.toContain("✦ think");
    await clickText("[ ] Thinking tokens");
    expect(view.captureCharFrame()).toContain("✦ think");
    await clickText("[x] Thinking tokens");
    expect(view.captureCharFrame()).not.toContain("✦ think");
    await clickText("[ ] Cache hit as percentage");
    expect(view.captureCharFrame()).toContain("5.6%");
    expect(view.captureCharFrame()).toContain("ø cache hit");
    expect(view.captureCharFrame().toLowerCase()).not.toContain("cache hit ratio");
    await clickText("[x] Cache hit as percentage");
    expect(view.captureCharFrame()).toContain("0.1×");
    await clickText("[ ] Cache hit as percentage");
    await clickText("[ ] Hide empty rows");
    expect(view.captureCharFrame()).toContain("[x] Input tokens");
    await clickText("[x] Input tokens");
    expect(view.captureCharFrame()).toContain("[ ] Input tokens");
    expect(view.captureCharFrame()).not.toContain("↑ input");
    expect(view.captureCharFrame()).toContain("Σ total");

    view.mockInput.pressArrow("down");
    view.mockInput.pressKey(" ");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[ ] Output tokens");
    expect(view.captureCharFrame()).not.toContain("↓ output");
    await clickText("[x] Total tokens");
    expect(view.captureCharFrame()).not.toContain("Σ total");
    expect(view.captureCharFrame()).toContain("$1.00");

    failSave = true;
    await clickText("[x] Cost");
    expect(saveError).toBe("Could not save sidebar preferences");
    expect(view.captureCharFrame()).toContain("[x] Cost");
    failSave = false;
    await clickText("Close");
    expect(dialog()).toBeUndefined();
    expect(command!.palette).toBe(true);
    command!.run();
    await view.waitForFrame((frame) => frame.includes(`v${version}`));
    view.mockInput.pressEscape();
    // A bare Escape waits for the terminal's ambiguous-sequence timeout.
    await Bun.sleep(30);
    await view.flush();
    expect(dialog()).toBeUndefined();
    expect(saved.settings).toEqual({
      hidden: ["reasoning", "input", "output", "total"],
      hideEmpty: true,
      cachePercentage: true,
      cacheMissNotices: false,
    });
  } finally {
    cleanup?.();
    await view.dispose();
  }

  const restarted = await testRender(render, { width: 60, height: 40 });
  try {
    await restarted.waitForFrame((frame) => frame.includes("$1.00"));
    expect(restarted.captureCharFrame()).toContain("5.6%");
    expect(restarted.captureCharFrame()).not.toContain("↑ input");
    expect(restarted.captureCharFrame()).not.toContain("↓ output");
    expect(restarted.captureCharFrame()).not.toContain("Σ total");
    command!.run();
    await restarted.waitForFrame((frame) => frame.includes("[ ] Input tokens"));
    expect(restarted.captureCharFrame()).toContain("[x] Hide empty rows");
    expect(restarted.captureCharFrame()).toContain("[x] Cache hit as percentage");
    restarted.mockInput.pressEnter();
    await restarted.flush();
    expect(restarted.captureCharFrame()).toContain("↑ input");
    expect(restarted.captureCharFrame()).toContain("[x] Input tokens");
    for (const [option, sidebarText] of [
      ["Input tokens", "↑ input"],
      ["Cache write", "▤ cache write"],
      ["Cache read", "▤ cache read"],
      ["Cache hit", "ø cache hit"],
      ["Cost", "$1.00"],
      ["Turn count", "1 turn"],
    ]) {
      const lines = restarted.captureCharFrame().split("\n");
      const text = `[x] ${option}`;
      const y = lines.findIndex((line) => line.includes(text));
      expect(y).toBeGreaterThanOrEqual(0);
      await restarted.mockMouse.click(lines[y].indexOf(text), y);
      await restarted.flush();
      expect(restarted.captureCharFrame()).not.toContain(sidebarText);
    }
    expect(restarted.captureCharFrame()).toContain("Session Token Summary");
    restarted.mockInput.pressTab();
    restarted.mockInput.pressKey(" ");
    restarted.mockInput.pressTab();
    restarted.mockInput.pressKey(" ");
    restarted.mockInput.pressTab();
    restarted.mockInput.pressTab();
    restarted.mockInput.pressEnter();
    await restarted.flush();
    expect(dialog()).toBeUndefined();
  } finally {
    cleanup?.();
    await restarted.dispose();
  }

  // Old saved settings omit the new options and retain their metric choices.
  saved.settings = { hidden: [] };
  const empty = session("root");
  empty.cost = 0;
  empty.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  client.session.get = async () => empty;
  client.message.list = async () => ({ data: [], cursor: {} });
  const legacy = await testRender(render, { width: 60, height: 40 });
  try {
    await legacy.waitForFrame((frame) => frame.includes("$0.00"));
    expect(legacy.captureCharFrame()).toContain("✦ think");
    expect(legacy.captureCharFrame()).toContain("0 turns");
    command!.run();
    await legacy.waitForFrame((frame) => frame.includes("[ ] Hide empty rows"));
    expect(legacy.captureCharFrame()).toContain("[x] Thinking tokens");
    await clickText("[ ] Hide empty rows", 0, legacy);
    for (const label of ["↑ input", "↓ output", "▤ cache write", "▤ cache read", "ø cache hit", "✦ think", "Σ total", "$0.00", "0 turns"]) {
      expect(legacy.captureCharFrame()).not.toContain(label);
    }
    expect(legacy.captureCharFrame().split("Session Token Summary")).toHaveLength(3);
    await clickText("[x] Hide empty rows", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("$0.00");
    await clickText("[ ] Cache hit as percentage", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("—");
    expect(legacy.captureCharFrame()).not.toContain("NaN");

    empty.tokens.cache.read = 10;
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    await legacy.waitForFrame((frame) => frame.includes("100.0%"));
    await clickText("[x] Cache hit as percentage", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("∞");
    await clickText("[ ] Hide empty rows", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("ø cache hit");
    expect(legacy.captureCharFrame()).toContain("Σ total");
    expect(legacy.captureCharFrame()).not.toContain("▤ cache write");
    expect(legacy.captureCharFrame()).not.toContain("$0.00");

    empty.tokens.cache.read = 0;
    empty.tokens.input = 10;
    empty.cost = 0.001;
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    await legacy.waitForFrame((frame) => frame.includes("<$0.01"));
    expect(legacy.captureCharFrame()).toContain("↑ input");
    expect(legacy.captureCharFrame()).not.toContain("ø cache hit");
    await clickText("[x] Hide empty rows", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("0.0×");
    await clickText("[ ] Cache hit as percentage", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("0.0%");
  } finally {
    cleanup?.();
    await legacy.dispose();
  }
});

test("cache-miss notices report new significant misses once, per session, without replaying history", async () => {
  const histories: Record<string, SessionMessageInfo[]> = {
    root: [cacheRequest("first", 0, { write: 100_000 }), cacheRequest("historical-miss", 60_000, { write: 105_000 })],
    child: [cacheRequest("child-first", 0, { write: 100_000 })],
    other: [cacheRequest("other-first", 0, { write: 100_000 }), cacheRequest("other-miss", 60_000, { write: 100_000 })],
  };
  const saved = { settings: { hidden: ["reasoning"], hideEmpty: false, cachePercentage: false, cacheMissNotices: true } };
  const storage = storageFor(saved);
  const notices: ToastOptions[] = [];
  const children: Record<string, Session[]> = { root: [session("child")] };
  const client = clientFor(children, histories);
  const handlers = new Map<string, (event: { data: { sessionID: string; parentID?: string } }) => void>();
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let changeNotices: (enabled: boolean) => Promise<void>;
  let select: (sessionID: string) => void;
  const color = RGBA.fromHex("#c6d0f5");
  const context = {
    client,
    storage: {
      store<Value extends object>(key: string, options: { initial: Value }) {
        const [state, update] = storage.store(key, options);
        changeNotices = (enabled) => update((draft) => { Object.assign(draft, { cacheMissNotices: enabled }); });
        return [state, update] as const;
      },
    },
    keymap: { layer() {} },
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) { claim = value; return () => {}; },
      toast: { show: (options: ToastOptions) => { notices.push(options); } },
    },
    theme: {
      text: { base: color, muted: color, feedback: { info: { base: color }, warning: { base: color }, error: { base: color } } },
      border: { base: color },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    const [selected, setSelected] = createSignal("root");
    select = setSelected;
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ get sessionID() { return selected(); } });
  }, { width: 60, height: 20 });
  const refresh = async (sessionID = "root") => {
    handlers.get("session.step.ended")!({ data: { sessionID } });
    await Bun.sleep(250);
    await view.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("3 turns"));
    expect(notices).toEqual([]);
    histories.root.push(cacheRequest("partial-miss", 600_000, { read: 80_000, write: 30_000 }));
    await refresh();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      title: "Possible cache miss after 9m idle",
      message: "25K previously processed tokens weren’t read from cache.",
      variant: "warning", sessionID: "root",
    });
    await refresh();
    expect(notices).toHaveLength(1);

    const childMiss = cacheRequest("child-miss", 1_000, { write: 110_000 });
    childMiss.model = { providerID: "provider", id: "other-model" };
    histories.child.push(childMiss);
    await refresh("child");
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ title: "Possible cache miss after model switch", sessionID: "child" });
    histories.root.push(cacheRequest("noise", 610_000, { read: 108_500, write: 1_500 }));
    await refresh();
    expect(notices).toHaveLength(2);

    await changeNotices!(false);
    histories.root.push(cacheRequest("disabled-miss", 620_000, { write: 130_000 }));
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    await view.flush();
    expect(notices).toHaveLength(2);
    await changeNotices!(true);
    await Bun.sleep(250);
    await view.flush();
    expect(notices).toHaveLength(2);
    histories.root.push(cacheRequest("enabled-miss", 630_000, { read: 30_000, write: 140_000 }));
    await refresh();
    expect(notices).toHaveLength(3);

    const listMessages = client.message.list;
    const delayed = Promise.withResolvers<{ data: SessionMessageInfo[]; cursor: {} }>();
    const oldSnapshot = [...histories.root];
    let waiting = false;
    client.message.list = async (input) => {
      if (input.sessionID !== "root") return listMessages(input);
      waiting = true;
      return delayed.promise;
    };
    handlers.get("session.step.ended")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    expect(waiting).toBe(true);
    await changeNotices!(false);
    await changeNotices!(true);
    histories.root.push(cacheRequest("toggle-miss", 640_000, { write: 180_000 }));
    client.message.list = listMessages;
    delayed.resolve({ data: oldSnapshot, cursor: {} });
    await Bun.sleep(250);
    await view.flush();
    expect(notices).toHaveLength(3);

    select!("other");
    await view.waitForFrame((frame) => frame.includes("2 turns"));
    expect(notices).toHaveLength(3);
    select!("root");
    await view.waitForFrame((frame) => frame.includes("9 turns"));
    expect(notices).toHaveLength(3);
    histories.root.push({
      id: "compaction", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 645_000 },
    }, cacheRequest("after-compaction", 650_000, { write: 100_000 }));
    await refresh();
    expect(notices).toHaveLength(3);
    expect(view.captureCharFrame()).toContain("10 turns");

    const discovery = Promise.withResolvers<{ data: SessionMessageInfo[]; cursor: {} }>();
    client.message.list = async (input) => input.sessionID === "root" ? discovery.promise : listMessages(input);
    handlers.get("session.step.ended")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    children.root.push(session("fresh-child"));
    children["fresh-child"] = [session("nested-child")];
    for (const [sessionID, parentID] of [["fresh-child", "root"], ["nested-child", "fresh-child"]]) {
      handlers.get("session.created")!({ data: { sessionID, parentID } });
      histories[sessionID] = [
        cacheRequest(`${sessionID}-first`, 660_000, { write: 100_000 }),
        cacheRequest(`${sessionID}-miss`, 670_000, { write: 110_000 }),
      ];
    }
    client.message.list = listMessages;
    discovery.resolve({ data: [...histories.root], cursor: {} });
    await refresh("nested-child");
    expect(notices).toHaveLength(5);
    expect(notices.slice(3).map((notice) => notice.sessionID)).toEqual(["fresh-child", "nested-child"]);
    expect(notices[3].message).toBe("100K previously processed tokens weren’t read from cache.");
    handlers.get("session.created")!({ data: { sessionID: "fresh-child", parentID: "root" } });
    await refresh("fresh-child");
    expect(notices).toHaveLength(5);
  } finally {
    cleanup?.();
    expect(handlers.size).toBe(0);
    await view.dispose();
  }
});

test.each([18, 20])("settings popup stays readable and scrolls with mouse and keyboard at %i rows", async (height) => {
  const saved: Record<string, object> = {};
  const color = RGBA.fromHex("#c6d0f5");
  let renderDialog: () => JSX.Element;
  let command: KeymapCommand;
  let cleanup: (() => void) | undefined;
  let closed = false;
  const context = {
    storage: storageFor(saved),
    data: { on: () => () => {} },
    keymap: { layer: (factory: () => { commands: KeymapCommand[] }) => { command = factory().commands[0]; } },
    ui: {
      slot: () => () => {},
      dialog: {
        show: (render: () => JSX.Element) => { renderDialog = render; },
        set: () => {},
        clear: () => { closed = true; },
      },
    },
    theme: { text: { base: color, muted: color }, border: { base: color } },
  } as unknown as Context;
  const view = await testRender(() => {
    cleanup = plugin.setup(context) as () => void;
    command.run();
    return renderDialog();
  }, { width: 60, height });
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain(`Session Token Summary · v${version}`);
    expect(view.captureCharFrame()).toContain("Show/hide");
    expect(view.captureCharFrame()).toContain("[x] Input tokens");
    expect(view.captureCharFrame()).toContain("[x] Cache read");
    expect(view.captureCharFrame()).toContain("[x] Cache hit");
    if (height >= 20) expect(view.captureCharFrame()).toContain("[ ] Thinking tokens");
    expect(view.captureCharFrame()).toContain("Close");

    for (let i = 0; i < 11; i++) view.mockInput.pressArrow("down");
    await view.flush();
    expect(view.captureCharFrame()).toContain("Options");
    expect(view.captureCharFrame()).toContain("[ ] Hide empty rows");
    expect(view.captureCharFrame()).toContain("[ ] Cache hit as percentage");
    expect(view.captureCharFrame()).toContain("[ ] Show cache-miss notices");
    view.mockInput.pressKey(" ");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    expect(saved.settings).toMatchObject({ cacheMissNotices: true });

    view.resize(60, 12);
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    expect(view.captureCharFrame()).toContain("Close");
    for (let i = 0; i < 11; i++) view.mockInput.pressArrow("up");
    await view.flush();
    expect(view.captureCharFrame()).toContain("Show/hide");
    expect(view.captureCharFrame()).toContain("[x] Input tokens");

    view.resize(60, height);
    await view.flush();
    const inputY = view.captureCharFrame().split("\n").findIndex((line) => line.includes("[x] Input tokens"));
    for (let i = 0; i < 15; i++) await view.mockMouse.scroll(5, inputY, "down");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    const lines = view.captureCharFrame().split("\n");
    const optionY = lines.findIndex((line) => line.includes("[x] Show cache-miss notices"));
    await view.mockMouse.click(lines[optionY].indexOf("[x]"), optionY);
    await view.flush();
    expect(view.captureCharFrame()).toContain("[ ] Show cache-miss notices");
    view.mockInput.pressTab();
    view.mockInput.pressEnter();
    await view.flush();
    expect(closed).toBe(true);
  } finally {
    cleanup?.();
    await view.dispose();
  }
});

test("compiled ./tui export stays reactive when loaded from a node_modules path", async () => {
  const { copyFileSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const pkgDir = resolve(import.meta.dir, "../node_modules/.opencode-plugin-session-token-summary-test");
  const distDir = resolve(pkgDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(resolve(pkgDir, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(resolve(import.meta.dir, "../dist/tui.js"), resolve(distDir, "tui.js"));

  const saved: Record<string, object> = {};
  const color = RGBA.fromHex("#c6d0f5");
  let renderDialog: () => JSX.Element;
  let command: KeymapCommand;
  let cleanup: (() => void) | undefined;
  const context = {
    storage: storageFor(saved),
    data: { on: () => () => {} },
    keymap: { layer: (factory: () => { commands: KeymapCommand[] }) => { command = factory().commands[0]; } },
    ui: {
      slot: () => () => {},
      dialog: {
        show: (render: () => JSX.Element) => { renderDialog = render; },
        set: () => {},
        clear: () => {},
      },
    },
    theme: { text: { base: color, muted: color }, border: { base: color } },
  } as unknown as Context;

  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    const { default: compiledPlugin } = await import(pathToFileURL(resolve(distDir, "tui.js")).href);
    view = await testRender(() => {
      cleanup = compiledPlugin.setup(context) as () => void;
      command.run();
      return renderDialog();
    }, { width: 60, height: 24 });
    await view.flush();

    const isBold = (label: string) => {
      const spans = view!.captureSpans().lines.flatMap((line) => line.spans);
      const span = spans.find((s) => s.text.includes(label));
      return ((span?.attributes ?? 0) & TextAttributes.BOLD) === TextAttributes.BOLD;
    };

    expect(isBold("Input tokens")).toBe(true);
    expect(isBold("Output tokens")).toBe(false);

    view.mockInput.pressArrow("down");
    await view.flush();
    expect(isBold("Input tokens")).toBe(false);
    expect(isBold("Output tokens")).toBe(true);

    view.mockInput.pressKey(" ");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Input tokens");
    expect(view.captureCharFrame()).toContain("[ ] Output tokens");
    expect(isBold("Output tokens")).toBe(true);
    expect(saved.settings).toMatchObject({ hidden: ["reasoning", "output"] });
  } finally {
    cleanup?.();
    await view?.dispose();
    rmSync(pkgDir, { recursive: true, force: true });
  }
});
