#!/usr/bin/env node
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import("../index.ts");
const customFooter = loaded.default ?? loaded;
const handlers = new Map();
const events = new Map();
const calls = { branch: 0, context: 0, history: 0, name: 0, commands: 0 };
let headerFactory;
let footerFactory;
let name = "workspace Original";
let sessionId = "session-1";
let leafId = "leaf-1";
let tokens = 120_000;
let contextWindow = 200_000;
let branch = [];
let messages = [];
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const tui = { terminal: { rows: 60 }, requestRender() {} };
const extensionStatuses = new Map();
const footerData = { onBranchChange: () => () => {}, getExtensionStatuses: () => extensionStatuses };
const context = {
  cwd: "/workspace",
  model: { name: "model-1", contextWindow },
  getContextUsage() { calls.context++; return { tokens, contextWindow, percent: tokens === null ? null : tokens / contextWindow * 100 }; },
  sessionManager: {
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
    getBranch() { calls.branch++; return branch; },
    buildSessionContext() { calls.history++; return { messages }; },
  },
  ui: {
    setFooter(factory) { footerFactory = factory; },
    setWidget(_identifier, factory) { headerFactory = factory; },
  },
};
customFooter({
  on: (event, handler) => handlers.set(event, handler),
  events: { on: (event, handler) => events.set(event, handler) },
  exec: async (_command, args) => ({ stdout: args[0] === "branch" ? "main\n" : "" }),
  getThinkingLevel: () => "high",
  getSessionName() { calls.name++; return name; },
  getCommands() { calls.commands++; return [{ name: "skill:tdd", source: "skill", sourceInfo: { path: "/skills/tdd/SKILL.md" } }]; },
});
const emit = async (event, extra = {}) => handlers.get(event)({ type: event, ...extra }, context);
await emit("session_start", { reason: "startup" });
let header = headerFactory(tui, theme);
let footer = footerFactory(tui, theme, footerData);
const render = (width = 200) => [...header.render(width), ...footer.render(width)].join("\n");
assert.match(render(), /Original/);
assert.match(render(), /60%/);
tui.terminal.rows = 40;
const afterFirstRender = { ...calls };
for (const width of [200, 40, 160, 56, 200]) render(width);
assert.deepEqual(calls, afterFirstRender, "Unchanged redraws and resizes must not read history or SDK usage");
extensionStatuses.set("background", "Background\nidle");
assert.match(render(), /Background idle/);
assert.deepEqual(calls, afterFirstRender, "Other extensions' status changes must not rescan history");
extensionStatuses.clear();

assert.deepEqual(afterFirstRender, { branch: 1, context: 1, history: 1, name: 1, commands: 1 }, "Header and footer must share one usage read");

const assistant = (input, cacheRead, totalCost) => ({
  role: "assistant", stopReason: "stop", content: [], timestamp: 100,
  usage: { input, cacheRead, output: 10_000, cacheWrite: 0, cost: { total: totalCost } },
});
const firstAssistant = assistant(20_000, 80_000, 1);
const secondAssistant = assistant(30_000, 70_000, 2);
branch = [{ type: "message", message: firstAssistant }, { type: "message", message: secondAssistant }];
leafId = "leaf-2";
tokens = 150_000;
let output = render();
assert.match(output, /75%/);
assert.match(output, /150k \/ 200k tokens/);
assert.match(output, /\$3\.00/);
assert.match(output, /\$1\.50\/turn/);
assert.match(output, /75\.0% session/);
assert.match(output, /latest miss 30k re-billed/);
assert.match(output, /150k reused \/ 50k new/);
assert.equal(calls.history, 1, "Message appends must not rescan skills before turn_end");

// Pi dispatches message_end before persisting the message.
await emit("message_end");
render();
branch.push({ type: "message", message: assistant(50_000, 50_000, 3) });
leafId = "leaf-3";
tokens = 180_000;
output = render();
assert.match(output, /90%/);
assert.match(output, /\$6\.00/);
assert.match(output, /\$2\.00\/turn/);

messages = [
  { role: "user", content: '<skill name="tdd" location="/skills/tdd/SKILL.md">Test first.</skill>' },
  firstAssistant,
];
await emit("turn_end");
output = render();
assert.match(output, /tdd -80k/);
const afterTurn = { ...calls };
render(40);
render(200);
assert.deepEqual(calls, afterTurn, "Skill refresh must not repeat on resize");

name = "workspace Renamed";
leafId = "name-entry";
assert.match(render(), /Renamed/);
name = "workspace Event rename";
events.get("session:name-changed")();
assert.match(render(), /Event rename/);

contextWindow = 400_000;
context.model = { name: "model-2", contextWindow };
await emit("model_select");
output = render();
assert.match(output, /model-2/);
assert.match(output, /45%/);
assert.match(output, /180k \/ 400k tokens/);
await emit("thinking_level_select", { level: "low" });
assert.match(render(), /model-2 · l/);

messages = [];
branch = [{ type: "compaction" }, { type: "message", message: assistant(40_000, 0, 0.5) }];
leafId = "compacted";
tokens = null;
await emit("session_compact");
output = render();
assert.doesNotMatch(output, /tdd/);
assert.match(output, /50k \/ 400k tokens/);
assert.match(output, /0\.0% session/);
assert.doesNotMatch(output, /latest miss/);

tokens = 40_000;
branch = [];
leafId = "earlier-branch";
await emit("session_tree");
output = render();
assert.match(output, /10%/);
assert.match(output, /\$0\.000/);

// An in-memory fork can keep both the manager object and inherited leaf ID.
sessionId = "fork-session";
name = "workspace Fork";
tokens = 80_000;
await emit("session_start", { reason: "fork" });
header = headerFactory(tui, theme);
footer = footerFactory(tui, theme, footerData);
output = render();
assert.match(output, /Fork/);
assert.match(output, /fork-session/);
assert.match(output, /20%/);

await emit("session_shutdown");
const afterShutdown = { ...calls };
assert.equal(render(), "");
assert.deepEqual(calls, afterShutdown, "Shutdown render must not touch stale context");
sessionId = "resumed-session";
name = "workspace Resumed";
tokens = 120_000;
await emit("session_start", { reason: "resume" });
header = headerFactory(tui, theme);
footer = footerFactory(tui, theme, footerData);
output = render();
assert.match(output, /Resumed/);
assert.match(output, /30%/);
console.log("custom-footer cache regression ok");
