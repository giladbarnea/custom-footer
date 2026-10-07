#!/usr/bin/env node
import { deepEqual } from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import("../index.ts");
const customFooter = loaded.default ?? loaded;
const handlers = new Map();
let headerFactory;
let footerFactory;
const assistant = (input, cacheRead, totalCost) => ({
	role: "assistant", stopReason: "stop", content: [], timestamp: 100,
	usage: { input, cacheRead, output: 10_000, cacheWrite: 0, cost: { total: totalCost } },
});
const context = {
	cwd: "/workspace",
	model: { name: "model-1", contextWindow: 200_000 },
	getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
	sessionManager: {
		getSessionId: () => "01a0a3c0-52f2-7249-9ec9-90e0f7a0a142",
		getLeafId: () => "leaf-1",
		getBranch: () => [{ type: "message", message: assistant(20_000, 80_000, 1) }, { type: "message", message: assistant(30_000, 70_000, 2) }],
		buildSessionContext: () => ({ messages: [] }),
	},
	ui: {
		setFooter(factory) { footerFactory = factory; },
		setWidget(_identifier, factory) { headerFactory = factory; },
	},
};
customFooter({
	on: (event, handler) => handlers.set(event, handler),
	events: { on() {} },
	exec: async (_command, args) => ({ stdout: args[0] === "branch" ? "main\n" : " M index.ts\n" }),
	getThinkingLevel: () => "high",
	getSessionName: () => "workspace Original",
	getCommands: () => [],
});
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const tui = { terminal: { rows: 60 }, requestRender() {} };
const header = headerFactory(tui, theme);
const footer = footerFactory(tui, theme, { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() });
const headerAt = (width) => header.render(width).map(stripVTControlCharacters);
const footerAt = (width) => footer.render(width).map(stripVTControlCharacters);

deepEqual(
	footerAt(160),
	["  main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $3.00  $1.50/turn · cache 75.0% session · latest miss 30k re-billed · 150k reused / 50k new"],
	"A wide terminal must pack every footer row onto one line, every fact in its full form",
);
deepEqual(
	footerAt(120),
	["  main* ·  workspace/  · ▇ 75%  150k / 200k · $3.00  $1.50/turn · 75.0% session · miss 30k · 150k reused / 50k new"],
	"To save a line, the footer must first drop the labels and shorten the latest cache reading",
);
deepEqual(
	footerAt(100),
	["  main* workspace/ ▇ 75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new"],
	"Rounding the cost and removing whitespace must come before dropping the branch icon and before hiding any fact",
);
deepEqual(
	footerAt(80),
	[" main* workspace/ ▇ 75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k"],
	"The first fact to hide must be the reused/new split, and only after the branch icon is gone",
);
deepEqual(
	footerAt(60),
	[" main* workspace/ ▇ 75% 150k / 200k $3 $1.50/turn miss 30k"],
	"The session cache hit rate must hide second",
);
deepEqual(
	footerAt(50),
	[" main* workspace/ ▇ 75% $3 $1.50/turn miss 30k"],
	"The token counts must hide third",
);
deepEqual(
	footerAt(40),
	[" main* workspace/ ▇ 75% $3 miss 30k"],
	"The cost per turn must hide last",
);

deepEqual(
	headerAt(160),
	[" model-1 · high · Original · 01a0a3c0-52f2-7249-9ec9-90e0f7a0a142"],
	"A wide header must show every fact in its full form",
);
deepEqual(
	headerAt(60),
	[" model-1 high Original 01a0a3c0-52f2-7249-9ec9-90e0f7a0a142"],
	"To save a line, the header must narrow its separators before it shortens the thinking level",
);
deepEqual(
	headerAt(50),
	[" model-1 h Original 01a0a3c0-52f2"],
	"The header must keep the full session id until every other step is taken",
);
deepEqual(
	headerAt(30)[0],
	" model-1 · high · Original",
	"When even the shortest forms need two lines, the header must use two lines with its full forms",
);

console.log("custom-footer layout regression ok");
