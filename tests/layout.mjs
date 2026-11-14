#!/usr/bin/env node
import { deepEqual, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import("../index.ts");
const customFooter = loaded.default ?? loaded;
const handlers = new Map();
const executedCommands = [];
let branchName = "main";
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
	exec: async (command, args) => {
		executedCommands.push(command);
		return { stdout: args[0] === "branch" ? `${branchName}\n` : " M index.ts\n" };
	},
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
	["  main* ·  workspace/  · context ▇75%  150k / 200k tokens · $3.00  $1.50/turn · cache 75.0% session · miss 30k re-billed · 150k reused / 50k new"],
	"A wide terminal must pack every footer row onto one line, every fact in its full form",
);
deepEqual(
	footerAt(120),
	["  main* ·  workspace/  · ▇75%  150k / 200k · $3.00  $1.50/turn · 75.0% session · miss 30k · 150k reused / 50k new"],
	"To save a line, the footer must first drop the labels and shorten the last message's cache reading",
);
deepEqual(
	footerAt(100),
	["  main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new"],
	"Rounding the cost and removing whitespace must come before dropping the branch icon and before hiding any fact",
);
deepEqual(
	footerAt(80),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k"],
	"The first fact to hide must be the reused/new split, and only after the branch icon is gone",
);
deepEqual(
	footerAt(60),
	[" main* workspace/ ▇75% $3 $1.50/turn 75.0% session miss 30k"],
	"The token counts must hide second, before the session cache hit rate",
);
deepEqual(
	footerAt(50),
	[" main* workspace/ ▇75% $3 $1.50/turn miss 30k"],
	"The session cache hit rate must hide third",
);
deepEqual(
	footerAt(40),
	[" main* workspace/ ▇75% $3 miss 30k"],
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
	["  main* ·  workspace/  · context ▇75%  150k / 200k tokens · $0.90  $0.45/turn · cache 30.0% session · miss after 6m idle: 100k re-billed $0.36 · 90k reused / 210k new"],
	"A wide footer must show the miss cause, re-billed tokens and cost, as pi's notice does",
);
deepEqual(
	footerAt(140),
	["  main* ·  workspace/  · ▇75%  150k / 200k · $0.90  $0.45/turn · 30.0% session · miss 6m idle $0.36 · 90k reused / 210k new"],
	"With the labels gone, the miss must keep its two most important facts: cause and cost",
);
deepEqual(
	footerAt(90),
	[" main* workspace/ ▇75% 150k / 200k $1 $0.45/turn 30.0% session miss 6m idle $0.36"],
	"The miss cause must outlast the reused/new split",
);
deepEqual(
	footerAt(72),
	[" main* workspace/ ▇75% $1 $0.45/turn 30.0% session miss 6m idle $0.36"],
	"The miss cause must outlast the token counts",
);
deepEqual(
	footerAt(60),
	[" main* workspace/ ▇75% $1 $0.45/turn miss 6m idle $0.36"],
	"The miss cause must outlast the session hit rate",
);
deepEqual(
	footerAt(50),
	[" main* workspace/ ▇75% $1 miss 6m idle $0.36"],
	"The miss cause must outlast the cost per turn",
);
deepEqual(
	footerAt(40),
	[" main* workspace/ ▇75% $1 miss $0.36"],
	"Last, the miss must drop its cause and keep what it cost",
);

showMiss("unpriced", [cachedTurn, turn(6 * minute, missUsage(false))], false);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇75%  150k / 200k tokens · $0.08  $0.04/turn · cache 30.0% session · miss after 6m idle: 100k re-billed · 90k reused / 210k new"],
	"Without a cost, the wide miss must leave the cost out",
);
deepEqual(
	footerAt(140),
	["  main* ·  workspace/  · ▇75%  150k / 200k · $0.08  $0.04/turn · 30.0% session · miss 6m idle 100k · 90k reused / 210k new"],
	"Without a cost, the re-billed tokens must take its place",
);
deepEqual(
	footerAt(40),
	[" main* workspace/ ▇75% $0 miss 100k"],
	"Without a cost, the shortest miss must show the re-billed tokens",
);

showMiss("recent", [cachedTurn, turn(4 * minute, missUsage(true))]);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇75%  150k / 200k tokens · $0.90  $0.45/turn · cache 30.0% session · miss 100k re-billed $0.36 · 90k reused / 210k new"],
	"A miss within the cache TTL and on the same model must name no cause",
);
deepEqual(
	footerAt(120),
	["  main* ·  workspace/  · ▇75%  150k / 200k · $0.90  $0.45/turn · 30.0% session · miss $0.36 · 90k reused / 210k new"],
	"Without a cause, the short miss must show only its cost",
);

showMiss("switch", [cachedTurn, turn(6 * minute, missUsage(true), "model-2")]);
deepEqual(
	footerAt(200),
	["  main* ·  workspace/  · context ▇75%  150k / 200k tokens · $0.90  $0.45/turn · cache 30.0% session · miss after model switch: 100k re-billed $0.36 · 90k reused / 210k new"],
	"A model switch must outrank the idle gap as the cause, as in pi's notice",
);
deepEqual(
	footerAt(140),
	["  main* ·  workspace/  · ▇75%  150k / 200k · $0.90  $0.45/turn · 30.0% session · miss model switch $0.36 · 90k reused / 210k new"],
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
	[" \uf126 main* ·  workspace/  · context ▇75%  150k / 200k tokens · $0.75  $0.38/turn · cache 43.3% session · miss 60k re-billed $0.22 · 130k reused / 170k new"],
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
	["  main* ·  workspace/  · context ▇75%  150k / 200k tokens · $0.94  $0.45/turn · cache 47.5% session · miss 100k re-billed $0.36 · 190k reused / 210k new"],
	"A cache warm two minutes before the miss must leave no idle cause",
);

// ── Quota pace ──────────────────────────────────────────────────────────────
// The footer reads the quota tool's cache file and shows the weekly pace of the
// session model's pool. Worked example: a 168-hour week with 12.5 hours left is
// 92.56% elapsed. At 80% used, burn is 80 / 92.56 = 0.86× and the target rate
// is 20 / 7.44 = 2.69×. On the nine-cell bar the dot sits at round(0.80 × 7) = 6
// and the time marker at round(0.9256 × 8) = 7.
const hour = 3_600_000;
const week = 168 * hour;
const cacheHome = mkdtempSync(join(tmpdir(), "pi-custom-footer-quota-"));
const quotaCacheFile = join(cacheHome, "quota", "provider-usage.json");
process.env.XDG_CACHE_HOME = cacheHome;
mkdirSync(join(cacheHome, "quota"));
const weekly = (usedPercent, hoursLeft = 12.5) => ({
	used_pct: usedPercent, window_start: new Date(Date.now() - (week - hoursLeft * hour)).toISOString(), window_duration_seconds: week / 1000,
});
const pool = (name, ...window) => ({ name, session: null, weekly: weekly(...window) });
const opus = { provider: "anthropic", id: "claude-opus-5-5" };
const fable = { provider: "anthropic", id: "claude-fable-5-2" };
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
// Each provider entry in the quota cache carries its own written_at. A fixture without one is stamped as just written.
const showPace = (scenario, model, quotaCache) => {
	leafId = scenario;
	context.model = { name: "model-1", contextWindow: 200_000, ...model };
	rmSync(quotaCacheFile, { force: true });
	const stamped = typeof quotaCache === "object" && quotaCache !== null
		? Object.fromEntries(Object.entries(quotaCache).map(([name, provider]) => [name, { written_at: minutesAgo(0), ...provider }]))
		: quotaCache;
	if (stamped) writeFileSync(quotaCacheFile, JSON.stringify(stamped));
};
branch = [{ type: "message", message: assistant(20_000, 80_000, 1) }, { type: "message", message: assistant(30_000, 70_000, 2) }];
cacheReadPricePerMillion = 0;
const fullFacts = " \uf126 main* ·  workspace/  · context ▇75%  150k / 200k tokens · $3.00  $1.50/turn · cache 75.0% session · miss 30k re-billed · 150k reused / 50k new";

showPace("under budget", opus, { claude: { usages: [pool("CLAUDE", 80), pool("FABLE", 27)] }, openrouter: { budget: {} } });
deepEqual(
	footerAt(230),
	[`${fullFacts} · burn ━━━━━━●┊─ 0.86× ≤ target 2.69× · resets in 12h`],
	"A wide footer must show the pace in full: the bar, burn ≤ target, and the reset time",
);
deepEqual(
	footerAt(199),
	[`${fullFacts} · burn 0.86× ≤ target 2.69× · 12h`],
	"The first thing to go must be the pace bar and the words 'resets in', before any label",
);
deepEqual(
	footerAt(127),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new burn 0.86× ≤ target 2.69× · 12h"],
	"The burn rate and the reset time must outlast the labels, the rounding, the whitespace and the branch icon",
);
deepEqual(
	footerAt(120),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new ≤ target 2.69×"],
	"The burn rate and the reset time must be the first whole facts to hide, leaving the target rate",
);
deepEqual(
	footerAt(100),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k ≤ target 2.69×"],
	"The reused/new split must hide before the word 'target' goes",
);
deepEqual(
	footerAt(70),
	[" main* workspace/ ▇75% $3 $1.50/turn miss 30k ≤ target 2.69×"],
	"The word 'target' must outlast the session hit rate and the token counts",
);
deepEqual(
	footerAt(56),
	[" main* workspace/ ▇75% $3 $1.50/turn miss 30k ≤ 2.69×"],
	"The word 'target' must go before the cost per turn hides",
);
deepEqual(
	footerAt(50),
	[" main* workspace/ ▇75% $3 miss 30k ≤ 2.69×"],
	"The target rate must stay when every other fact that can hide has hidden",
);
// The phone band. Hiding the target is the ladder's last step, so it fires only
// where the target alone would add a line: from 42 down to 35 columns with these
// short names. At 34 and below the footer needs a second line anyway, and the
// target rides on it.
deepEqual(footerAt(46), [" main* workspace/ ▇75% $3 miss 30k ≤ 2.69×"], "At 46 columns the target rate must still fit on the one line");
deepEqual(footerAt(43), [" main* workspace/ ▇75% $3 miss 30k ≤ 2.69×"], "At 43 columns, the narrowest that holds it, the target rate must still show");
deepEqual(footerAt(42), [" main* workspace/ ▇75% $3 miss 30k"], "At 42 columns the target rate must hide rather than add a line");
deepEqual(footerAt(40), [" main* workspace/ ▇75% $3 miss 30k"], "At 40 columns the footer must keep its one line without the target rate");
deepEqual(footerAt(38), [" main* workspace/ ▇75% $3 miss 30k"], "At 38 columns the footer must keep its one line without the target rate");
deepEqual(
	footerAt(30),
	[" main* workspace/ ▇75% $3", " miss 30k ≤ 2.69×"],
	"Where the footer needs a second line anyway, the target rate must ride on it",
);

// The same band moves with name lengths: with a long branch and directory it is
// 60 down to 53 columns, just under a 61-column phone.
branchName = "feature/quota-pace";
context.cwd = "/home/me/custom-footer";
leafId = "long names";
await handlers.get("turn_end")({ type: "turn_end" }, context);
deepEqual(footerAt(64), [" feature/quota-pace* custom-footer/ ▇75% $3 miss 30k ≤ 2.69×"], "With long names, 64 columns must still hold the target rate");
deepEqual(footerAt(61), [" feature/quota-pace* custom-footer/ ▇75% $3 miss 30k ≤ 2.69×"], "On a 61-column phone with long names, the narrowest that holds it, the target rate must still show");
deepEqual(footerAt(60), [" feature/quota-pace* custom-footer/ ▇75% $3 miss 30k"], "With long names, at 60 columns the target rate must hide rather than add a line");
deepEqual(footerAt(56), [" feature/quota-pace* custom-footer/ ▇75% $3 miss 30k"], "With long names, 56 columns must keep one line without the target rate");
branchName = "main";
context.cwd = "/workspace";
leafId = "short names";
await handlers.get("turn_end")({ type: "turn_end" }, context);

// A stale reading keeps showing, with its age. The quota tool refreshes every 5
// minutes while in use; the age shows only after 30 minutes. Ages use the same
// format as the reset time. The age outlasts the pace bar, the labels, the
// rounding, the whitespace and the branch icon, so laptop widths keep it, and it
// goes before any other part of the pace left.
const staleCache = (minutes) => ({ claude: { written_at: minutesAgo(minutes), usages: [pool("CLAUDE", 80)] } });
showPace("29.5 minutes old", opus, staleCache(29.5));
deepEqual(footerAt(240), [`${fullFacts} · burn ━━━━━━●┊─ 0.86× ≤ target 2.69× · resets in 12h`], "A reading just under 30 minutes old must show no age");
showPace("30.5 minutes old", opus, staleCache(30.5));
deepEqual(footerAt(240), [`${fullFacts} · burn ━━━━━━●┊─ 0.86× ≤ target 2.69× · resets in 12h · 30m old`], "A reading just over 30 minutes old must show its age");
showPace("2.5 hours old", opus, staleCache(150));
deepEqual(footerAt(240), [`${fullFacts} · burn ━━━━━━●┊─ 0.86× ≤ target 2.69× · resets in 12h · 2h old`], "A reading hours old must show its age in whole hours, after the reset time");
deepEqual(
	footerAt(208),
	[`${fullFacts} · burn 0.86× ≤ target 2.69× · 12h · 2h old`],
	"The pace bar must go before the age",
);
deepEqual(
	footerAt(160),
	[" \uf126 main* ·  workspace/  · ▇75%  150k / 200k · $3.00  $1.50/turn · 75.0% session · miss 30k · 150k reused / 50k new · burn 0.86× ≤ target 2.69× · 12h · 2h old"],
	"A laptop-width footer must keep the age, after the labels have gone",
);
deepEqual(
	footerAt(136),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new burn 0.86× ≤ target 2.69× · 12h · 2h old"],
	"The age must outlast the whitespace and the branch icon",
);
deepEqual(
	footerAt(134),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new burn 0.86× ≤ target 2.69× · 12h"],
	"The age must go before the burn rate, the reset time and every other part of the pace left",
);
deepEqual(
	footerAt(120),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new ≤ target 2.69×"],
	"Once the age is gone, the pace narrows as before",
);
deepEqual(footerAt(52), [" main* workspace/ ▇75% $3 miss 30k ≤ 2.69×"], "A stale reading's shortest form is the same as a fresh one's");
showPace("a day old", opus, staleCache(25 * 60));
deepEqual(footerAt(240), [`${fullFacts} · burn ━━━━━━●┊─ 0.86× ≤ target 2.69× · resets in 12h · 1d 1h old`], "A reading a day old must show days and hours");
showPace("no timestamp", opus, { claude: { written_at: null, usages: [pool("CLAUDE", 80)] } });
deepEqual(footerAt(230), [fullFacts], "A reading without a timestamp has no known age and must show no pace");

// Over budget: at 95% used, burn is 95 / 92.56 = 1.03× and the target rate is
// 5 / 7.44 = 0.67×. The marker sits at round(0.9256 × 7) = 6 and the dot passes
// it, at round(0.95 × 8) = 8.
showPace("over budget", opus, { claude: { usages: [pool("CLAUDE", 95)] } });
deepEqual(
	footerAt(230),
	[`${fullFacts} · burn ━━━━━━┊━● 1.03× > target 0.67× · resets in 12h`],
	"Over budget, the sign must turn to > and the dot must pass the time marker",
);
deepEqual(
	footerAt(199),
	[`${fullFacts} · burn 1.03× > target 0.67× · 12h`],
	"Over budget, the medium form must keep the > sign",
);
deepEqual(
	footerAt(50),
	[" main* workspace/ ▇75% $3 miss 30k > 0.67×"],
	"Over budget, the shortest form must keep the > sign",
);

// Fable spends from its own week and, at half weight, from the shared Claude
// week. Like the quota tool's pick score, its target is its own target rate,
// 73 / 7.44 = 9.81×, capped by the Claude week's room: (5 / 7.44) / 0.5 = 1.34×.
// Burn is Fable's own: 27 / 92.56 = 0.29×.
showPace("fable", fable, { claude: { usages: [pool("CLAUDE", 95), pool("FABLE", 27)] } });
deepEqual(
	footerAt(230),
	[`${fullFacts} · burn ━━●────┊─ 0.29× ≤ target 1.34× · resets in 12h`],
	"A Fable session must show Fable's burn against the pick score: its target capped by the shared Claude week",
);
showPace("fable capped out", fable, { claude: { usages: [pool("CLAUDE", 99.9), pool("FABLE", 27)] } });
deepEqual(
	footerAt(120),
	[" main* workspace/ ▇75% 150k / 200k $3 $1.50/turn 75.0% session miss 30k 150k reused / 50k new > target 0.03×"],
	"The sign must compare the two rates shown: a nearly spent Claude week puts a slow Fable over its target",
);
showPace("fable without claude", fable, { claude: { usages: [pool("FABLE", 27)] } });
deepEqual(footerAt(230), [fullFacts], "Without a Claude reading, Fable's pick score is unknown and the pace must not show");

// Codex has its own week. With 84.5 of 168 hours left it is 49.70% elapsed. At
// 60% used, burn is 60 / 49.70 = 1.21× and the target rate is 40 / 50.30 = 0.80×.
// The marker sits at round(0.497 × 7) = 3 and the dot at round(0.60 × 8) = 5.
showPace("codex", { provider: "openai-codex", id: "gpt-6-astra" }, {
	claude: { usages: [pool("CLAUDE", 95)] }, codex: { usages: [pool("CODEX", 60, 84.5)] },
});
deepEqual(
	footerAt(230),
	[`${fullFacts} · burn ━━━┊━●─── 1.21× > target 0.80× · resets in 3d 12h`],
	"A Codex session must show the Codex week, with days in the reset time",
);

showPace("no cache file", opus, null);
deepEqual(footerAt(230), [fullFacts], "Without the quota cache file, the footer must show no pace");
showPace("unreadable cache", opus, "not the quota tool's shape");
deepEqual(footerAt(230), [fullFacts], "A cache file of another shape must show no pace");
showPace("pool missing", { provider: "openai-codex", id: "gpt-6-astra" }, { claude: { usages: [pool("CLAUDE", 80)] } });
deepEqual(footerAt(230), [fullFacts], "A cache without the session model's pool must show no pace");
showPace("other provider", { provider: "openrouter", id: "claude-opus-5-5" }, { claude: { usages: [pool("CLAUDE", 80)] } });
deepEqual(footerAt(230), [fullFacts], "A model outside the quota pools must show no pace");
showPace("window over", opus, { claude: { usages: [pool("CLAUDE", 80, -1)] } });
deepEqual(footerAt(230), [fullFacts], "A reading from a week that has already reset must show no pace");

// Colours follow the quota tool's heat map, for burn and target separately:
// green within 5% of 1.0×; burn heats to amber at 1.25× and red at 2×, and
// cools to the cool end at 0.25×; the target rate runs the other way.
const rgb = { mdLink: "0;0;255", success: "0;255;0", warning: "255;255;0", error: "255;0;0", dim: "9;9;9" };
const colorTheme = {
	fg: (token, text) => `\x1b[38;2;${rgb[token] ?? "1;1;1"}m${text}\x1b[39m`,
	getFgAnsi: (token) => `\x1b[38;2;${rgb[token] ?? "1;1;1"}m`,
	getColorMode: () => "truecolor",
	bg: (_token, text) => text,
	bold: (text) => text,
};
const colorFooter = footerFactory(tui, colorTheme, { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() });
const paint = (token, text) => colorTheme.fg(token, text);
const paceAt = (width) => colorFooter.render(width)[0].split("new").at(-1);

showPace("on pace", opus, { claude: { usages: [pool("CLAUDE", 50, 84)] } });
ok(paceAt(230).includes(`${paint("success", "1.00×")} ${paint("dim", "≤")} ${paint("dim", "target ")}${paint("success", "1.00×")}`),
	`On pace, burn and target must both be green and the sign dim. Got: ${JSON.stringify(paceAt(230))}`);
showPace("idle week", opus, { claude: { usages: [pool("CLAUDE", 0, 42)] } });
ok(paceAt(230).includes(`${paint("mdLink", "●")}${paint("dim", "─────┊──")} ${paint("mdLink", "0.00×")} ${paint("dim", "≤")} ${paint("dim", "target ")}${paint("mdLink", "4.00×")}`),
	`With allowance going unused, burn, its bar and the target must take the cool colour. Got: ${JSON.stringify(paceAt(230))}`);
showPace("spent early", opus, { claude: { usages: [pool("CLAUDE", 100, 84)] } });
ok(paceAt(230).includes(`${paint("error", "━━━━")}${paint("dim", "┊")}${paint("error", "━━━●")}${paint("dim", "")} ${paint("error", "2.00×")} ${paint("error", ">")} ${paint("dim", "target ")}${paint("error", "0.00×")}`),
	`With the week spent at twice the pace, burn, its bar, the sign and the target must be red. Got: ${JSON.stringify(paceAt(230))}`);
showPace("fable cool burn, hot target", fable, { claude: { usages: [pool("CLAUDE", 100, 84), pool("FABLE", 10, 84)] } });
ok(paceAt(230).includes(`${paint("mdLink", "0.20×")} ${paint("error", ">")} ${paint("dim", "target ")}${paint("error", "0.00×")}`),
	`Burn and target must be coloured separately: a cool burn beside a red target. Got: ${JSON.stringify(paceAt(230))}`);

// ── The collapsed footer of custom-footer #9 ────────────────────────────────
// The issue's phone screenshot read " main wa/ ▁ 16% $5 sub $0.099/turn latest 100% > target 0.82×".
// The same session: a subscription, 51 turns at $0.099 ($5.049 in all), the last one read whole from
// the cache (100%), the session at 5.0M of 5.1M prompt tokens (98.0%), and a week at 59% used with
// 84.5 of its 168 hours left (49.70% elapsed): burn 59 / 49.70 = 1.19× over a target of
// 41 / 50.30 = 0.82×.
const paidTurn = (timestamp, input, cacheRead, total = 0.099) => turn(timestamp, {
	input, output: 1_000, cacheRead, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: total, cacheWrite: 0, total },
});
const showSession = async (scenario, entries, usage = { tokens: 160_000, contextWindow: 1_000_000, percent: 16 }) => {
	branch = entries;
	context.getContextUsage = () => usage;
	showPace(scenario, opus, { claude: { usages: [pool("CLAUDE", 59, 84.5)] } });
	await handlers.get("turn_end")({ type: "turn_end" }, context);
};
branchName = "main";
context.cwd = "/home/me/wa";
context.modelRegistry.isUsingOAuth = () => true;
await showSession("issue 9", [...Array.from({ length: 50 }, (_, index) => paidTurn(index, 2_000, 98_000)), paidTurn(60, 0, 100_000)]);
deepEqual(
	footerAt(240),
	[" \uf126 main* ·  wa/  · context ▂16%  160k / 1.0M tokens · $5.05 sub  $0.10/turn · cache 98.0% session · hit 100% · 5.0M reused / 100k new · burn ━━━┊━●─── 1.19× > target 0.82× · resets in 3d 12h"],
	"A wide footer must show the bar against its value, costs at two places, the subscription mark and the last message as a hit",
);
deepEqual(
	footerAt(152),
	[" \uf126 main* ·  wa/  · ▂16%  160k / 1.0M · $5.05 sub  $0.10/turn · 98.0% session · hit 100% · 5.0M reused / 100k new · burn 1.19× > target 0.82× · 3d 12h"],
	"The hit must keep its percentage until the labels have gone",
);
deepEqual(
	footerAt(147),
	[" \uf126 main* ·  wa/  · ▂16%  160k / 1.0M · $5.05 sub  $0.10/turn · 98.0% session · hit · 5.0M reused / 100k new · burn 1.19× > target 0.82× · 3d 12h"],
	"The hit's percentage must be the first part of it to go, before the cost is rounded",
);
deepEqual(
	footerAt(122),
	[" main* wa/ ▂16% 160k / 1.0M $5 sub $0.10/turn 98.0% session hit 5.0M reused / 100k new burn 1.19× > target 0.82× · 3d 12h"],
	"The subscription mark must outlast all the formatting: the labels, the rounding, the whitespace and the branch icon",
);
deepEqual(
	footerAt(120),
	[" main* wa/ ▂16% 160k / 1.0M $5 $0.10/turn 98.0% session hit 5.0M reused / 100k new burn 1.19× > target 0.82× · 3d 12h"],
	"The subscription mark must be the first whole fact to hide, before any part of the pace",
);
deepEqual(
	footerAt(90),
	[" main* wa/ ▂16% 160k / 1.0M $5 $0.10/turn 98.0% session hit > target 0.82×"],
	"The hit must outlast the reused/new split",
);
deepEqual(
	footerAt(72),
	[" main* wa/ ▂16% 160k / 1.0M $5 $0.10/turn 98.0% session > target 0.82×"],
	"The last message's hit must hide before the session hit rate and the token counts",
);
deepEqual(
	footerAt(61),
	[" main* wa/ ▂16% $5 $0.10/turn 98.0% session > target 0.82×"],
	"At the screenshot's 61 columns, the session hit rate must outlast the token counts, with no subscription mark and no last-message fact",
);
deepEqual(
	footerAt(50),
	[" main* wa/ ▂16% $5 $0.10/turn > target 0.82×"],
	"The session hit rate must hide before the word 'target'",
);

// Numbers earn decimal places by size: two below 10, one from 10, none from 100.
const wide = () => footerAt(240)[0];
await showSession("ten dollars", [paidTurn(0, 2_000, 98_000, 6.17), paidTurn(1, 0, 100_000, 6.17)]);
ok(wide().includes(" · $12.3 sub  $6.17/turn · "), `From $10, a cost must show one decimal place. Got: ${wide()}`);
await showSession("a hundred dollars", [paidTurn(0, 2_000, 98_000, 61.7), paidTurn(1, 0, 100_000, 61.7)]);
ok(wide().includes(" · $123 sub  $61.7/turn · "), `From $100, a cost must show whole dollars. Got: ${wide()}`);
await showSession("under a cent", [paidTurn(0, 2_000, 98_000, 0.004)]);
ok(wide().includes(" · $0.00 sub  $0.00/turn · "), `Below $10, a cost must show two decimal places, even under a cent. Got: ${wide()}`);
await showSession("whole session cached", [paidTurn(0, 0, 100_000), paidTurn(1, 0, 100_000)]);
ok(wide().includes(" · cache 100% session · "), `A full session hit rate must show no decimal place. Got: ${wide()}`);
// A week at 5% used with 8.5 of 168 hours left: target 95 / 5.06 = 18.8×, burn 5 / 94.94 = 0.05×.
showPace("high target", opus, { claude: { usages: [pool("CLAUDE", 5, 8.5)] } });
ok(wide().includes(" 0.05× ≤ target 18.8× · "), `From 10×, a rate must show one decimal place. Got: ${wide()}`);

// The last message is a hit when more than 90% of its prompt was read from the cache, and a miss otherwise.
// Exactly 90%: 90k of 100k read, after a 90k prompt, so nothing cached was re-billed.
await showSession("90 percent", [paidTurn(0, 0, 90_000), paidTurn(1, 10_000, 90_000)]);
ok(wide().includes(" · miss 90% · "), `At exactly 90% read from the cache, the last message must be a miss. Got: ${wide()}`);
await showSession("just over 90 percent", [paidTurn(0, 0, 90_100), paidTurn(1, 9_900, 90_100)]);
ok(wide().includes(" · hit 90% · "), `Just over 90% read from the cache, the last message must be a hit. Got: ${wide()}`);
// New content, not a re-billing: after a 10k prompt, a 40k prompt read those 10k from the cache (25%).
await showSession("new content", [paidTurn(0, 2_000, 8_000), paidTurn(1, 30_000, 10_000)]);
ok(wide().includes(" · miss 25% · "), `A last message under 90% must be a miss with its share, also when nothing cached was re-billed. Got: ${wide()}`);
// The session read 18k of its 50k prompt tokens (36.0%), and two turns cost $0.198.
deepEqual(footerAt(72), [" main* wa/ ▂16% 160k / 1.0M $0 $0.10/turn 36.0% session > target 0.82×"], "A plain miss must hide before the session hit rate, like a hit");
// A partial miss above 90%: after a 200k prompt, 195k of 210k were read (92.9%) and 5k re-billed.
await showSession("partial miss", [paidTurn(0, 0, 200_000), paidTurn(1, 15_000, 195_000)]);
ok(wide().includes(" · hit 93% · "), `Above 90%, the last message must be a hit even when pi's accounting detects a small miss. Got: ${wide()}`);
context.modelRegistry.isUsingOAuth = () => false;

deepEqual(executedCommands.filter((command) => command !== "git"), [], "The footer must read the quota cache file and never run a command for it");
rmSync(cacheHome, { recursive: true, force: true });

console.log("custom-footer layout regression ok");
