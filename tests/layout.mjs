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
let branch = [{ type: "message", message: assistant(20_000, 80_000, 1) }, { type: "message", message: assistant(30_000, 70_000, 2) }];
let leafId = "leaf-1";
let cacheReadPricePerMillion = 0;
const context = {
	cwd: "/workspace",
	model: { name: "model-1", contextWindow: 200_000 },
	getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
	sessionManager: {
		getSessionId: () => "01a0a3c0-52f2-7249-9ec9-90e0f7a0a142",
		getLeafId: () => leafId,
		getBranch: () => branch,
		buildSessionProjection: () => ({ entries: [] }),
	},
	modelRegistry: { find: () => ({ cost: { cacheRead: cacheReadPricePerMillion } }) },
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

// A cache miss shows what pi's own notice shows ("Cache miss after 6m idle:
// 199k tokens re-billed (~$0.38)"), ranked: the cost, then the cause, then the
// tokens. Worked example: the previous request sent 100k prompt tokens; six
// minutes later the next one wrote all 200k to the cache at $4/M, and cache
// reads cost $0.40/M. The miss re-billed min(100k, 200k) - 0 = 100k tokens at
// $3.60/M more than a read: $0.36.
const minute = 60_000;
const turn = (timestamp, usage, model = "model-1") => ({ type: "message", message: {
	role: "assistant", stopReason: "stop", content: [], provider: "anthropic", model, timestamp, usage,
} });
const cachedTurn = turn(0, {
	input: 10_000, output: 1_000, cacheRead: 90_000, cacheWrite: 0,
	cost: { input: 0.03, output: 0.015, cacheRead: 0.036, cacheWrite: 0, total: 0.081 },
});
const missUsage = (priced) => ({
	input: 0, output: 1_000, cacheRead: 0, cacheWrite: 200_000,
	cost: { input: 0, output: priced ? 0.015 : 0, cacheRead: 0, cacheWrite: priced ? 0.8 : 0, total: priced ? 0.815 : 0 },
});
const showMiss = (scenario, entries, priced = true) => {
	branch = entries;
	leafId = scenario;
	cacheReadPricePerMillion = priced ? 0.4 : 0;
};

showMiss("idle", [cachedTurn, turn(6 * minute, missUsage(true))]);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $0.90  $0.45/turn · cache 30.0% session · latest miss after 6m idle: 100k re-billed $0.36 · 90k reused / 210k new"],
	"A wide footer must show the miss cause, re-billed tokens and cost, as pi's notice does",
);
deepEqual(
	footerAt(140),
	["  main* ·  workspace/  · ▇ 75%  150k / 200k · $0.90  $0.45/turn · 30.0% session · miss 6m idle $0.36 · 90k reused / 210k new"],
	"With the labels gone, the miss must keep its two most important facts: cause and cost",
);
deepEqual(
	footerAt(90),
	[" main* workspace/ ▇ 75% 150k / 200k $1 $0.45/turn 30.0% session miss 6m idle $0.36"],
	"The miss cause must outlast the reused/new split",
);
deepEqual(
	footerAt(80),
	[" main* workspace/ ▇ 75% 150k / 200k $1 $0.45/turn miss 6m idle $0.36"],
	"The miss cause must outlast the session hit rate",
);
deepEqual(
	footerAt(60),
	[" main* workspace/ ▇ 75% $1 $0.45/turn miss 6m idle $0.36"],
	"The miss cause must outlast the token counts",
);
deepEqual(
	footerAt(50),
	[" main* workspace/ ▇ 75% $1 miss 6m idle $0.36"],
	"The miss cause must outlast the cost per turn",
);
deepEqual(
	footerAt(40),
	[" main* workspace/ ▇ 75% $1 miss $0.36"],
	"Last, the miss must drop its cause and keep what it cost",
);

showMiss("unpriced", [cachedTurn, turn(6 * minute, missUsage(false))], false);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $0.081  $0.041/turn · cache 30.0% session · latest miss after 6m idle: 100k re-billed · 90k reused / 210k new"],
	"Without a cost, the wide miss must leave the cost out",
);
deepEqual(
	footerAt(140),
	["  main* ·  workspace/  · ▇ 75%  150k / 200k · $0.081  $0.041/turn · 30.0% session · miss 6m idle 100k · 90k reused / 210k new"],
	"Without a cost, the re-billed tokens must take its place",
);
deepEqual(
	footerAt(40),
	[" main* workspace/ ▇ 75% $0 miss 100k"],
	"Without a cost, the shortest miss must show the re-billed tokens",
);

showMiss("recent", [cachedTurn, turn(4 * minute, missUsage(true))]);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $0.90  $0.45/turn · cache 30.0% session · latest miss 100k re-billed $0.36 · 90k reused / 210k new"],
	"A miss within the cache TTL and on the same model must name no cause",
);
deepEqual(
	footerAt(120),
	["  main* ·  workspace/  · ▇ 75%  150k / 200k · $0.90  $0.45/turn · 30.0% session · miss $0.36 · 90k reused / 210k new"],
	"Without a cause, the short miss must show only its cost",
);

showMiss("switch", [cachedTurn, turn(6 * minute, missUsage(true), "model-2")]);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $0.90  $0.45/turn · cache 30.0% session · latest miss after model switch: 100k re-billed $0.36 · 90k reused / 210k new"],
	"A model switch must outrank the idle gap as the cause, as in pi's notice",
);
deepEqual(
	footerAt(140),
	["  main* ·  workspace/  · ▇ 75%  150k / 200k · $0.90  $0.45/turn · 30.0% session · miss model switch $0.36 · 90k reused / 210k new"],
	"The short miss must name the model switch",
);

// A partial miss prices the re-billed tokens by this turn's own cache-read rate,
// not the model's list price. Worked example: 40k of the previous 100k prompt
// tokens were read at $0.40/M and 160k written at $4/M, so 60k were re-billed at
// $3.60/M more than a read: $0.216. The registry's $2/M would give $0.12.
showMiss("partial", [cachedTurn, turn(4 * minute, {
	input: 0, output: 1_000, cacheRead: 40_000, cacheWrite: 160_000,
	cost: { input: 0, output: 0.015, cacheRead: 0.016, cacheWrite: 0.64, total: 0.671 },
})]);
cacheReadPricePerMillion = 2;
deepEqual(
	footerAt(200),
	[" \uf126 main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $0.75  $0.38/turn · cache 43.3% session · latest miss 60k re-billed $0.22 · 130k reused / 170k new"],
	"A partial miss must price its re-billed tokens at the turn's own cache-read rate",
);

// Like pi, the idle gap counts from the last cache warm: four minutes after the
// turn, a warm reread the 100k prompt, two minutes before the miss.
showMiss("warm", [
	cachedTurn,
	{
		type: "usage", kind: "cache_warm", provider: "anthropic", model: "model-1", timestamp: new Date(4 * minute).toISOString(),
		usage: { input: 0, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0.04, cacheWrite: 0, total: 0.04 } },
	},
	turn(6 * minute, missUsage(true)),
]);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇ 75%  150k / 200k tokens · $0.94  $0.45/turn · cache 47.5% session · latest miss 100k re-billed $0.36 · 190k reused / 210k new"],
	"A cache warm two minutes before the miss must leave no idle cause",
);

console.log("custom-footer layout regression ok");
