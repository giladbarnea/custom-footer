#!/usr/bin/env node
// When the prompt cache is really gone: the latest of last touch + lifetime, Pi's own idle-warming
// horizon, and an armed pi-keep-cache-warm deadline in this process. Models and prices come from
// Pi's own catalog; the worked numbers below come from Pi's exported lifetime and warming policy.
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti";
import * as piAi from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";

process.env.TZ = "UTC";
const cacheHome = mkdtempSync(join(tmpdir(), "pi-custom-footer-expiry-"));
process.env.XDG_CACHE_HOME = cacheHome;
delete process.env.PI_CACHE_RETENTION;

const [major, minor, patch] = piVersion.split(".").map(Number);
const policyExported = typeof piAi.evaluateCacheWarming === "function";
equal(policyExported, major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 1))), `Pi ${piVersion}: evaluateCacheWarming must be exported from Pi 1.5.1 on, and only there`);
console.log(`Pi ${piVersion}: evaluateCacheWarming ${policyExported ? "exported: Pi's idle horizon applies" : "not exported: the footer falls back to last touch + lifetime"}`);

const minute = 60_000;
const start = Date.UTC(2026, 0, 1, 17, 0);
let now = start - 10 * minute;
Date.now = () => now;

// The first Anthropic model Pi would keep warm at full context, or on Pi without the policy the first with a lifetime.
const warmable = (model) => !policyExported || piAi.evaluateCacheWarming(model, model.contextWindow, "idle").action === "warm";
const model = getModels("anthropic").find((candidate) => candidate.promptCache?.short && warmable(candidate));
ok(model, `Pi ${piVersion} must ship an Anthropic model with a cache lifetime`);
const lifetimeMs = model.promptCache.short * 1000;
equal(lifetimeMs, 5 * minute, "The worked times below assume Pi's 5-minute lifetime");
if (policyExported) {
	equal(piAi.getCacheWarmingDelayMs(lifetimeMs), 4.5 * minute, "The worked times below assume Pi refreshes every 4.5 minutes");
	equal(piAi.CACHE_WARMING_MAX_IDLE_AGE_MS, 30 * minute, "The worked times below assume Pi's 30-minute idle limit");
}
// Pi's cost rule decides by prompt size: the smallest size it warms, found with Pi's own function.
let warmFrom = model.contextWindow;
if (policyExported) {
	let low = 1;
	while (low < warmFrom) {
		const middle = Math.floor((low + warmFrom) / 2);
		if (piAi.evaluateCacheWarming(model, middle, "idle").action === "warm") warmFrom = middle;
		else low = middle + 1;
	}
}
const below = warmFrom - 1;
const codex = getModels("openai-codex")[0];
equal(codex.promptCache, undefined, "Pi declares no cache lifetime for Codex");

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import("../index.ts");
const customFooter = loaded.default ?? loaded;
const handlers = new Map();
let settings = {};
let tools = [];
let branch = [];
let leafId = "leaf-0";
const context = {
	cwd: "/workspace",
	model,
	getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
	sessionManager: {
		getSessionId: () => "01a0a3c0-52f2-7249-9ec9-90e0f7a0a142",
		getLeafId: () => leafId,
		getBranch: () => branch,
		buildSessionProjection: () => ({ entries: [] }),
	},
	modelRegistry: { find: () => model },
	ui: { setFooter(factory) { footerFactory = factory; }, setWidget() {} },
};
let footerFactory;
customFooter({
	on: (event, handler) => handlers.set(event, handler),
	events: { on() {} },
	exec: async () => ({ stdout: "" }),
	getThinkingLevel: () => "off",
	getSessionName: () => undefined,
	getCommands: () => [],
	getSettings: () => structuredClone(settings),
	getAllTools: () => tools,
});
// Record the footer's timers instead of running them.
const timers = [];
const clearedTimers = [];
globalThis.setInterval = (callback, milliseconds) => {
	const timer = { callback, milliseconds, unrefed: false, unref() { this.unrefed = true; return this; } };
	timers.push(timer);
	return timer;
};
globalThis.clearInterval = (timer) => { if (timer) clearedTimers.push(timer); };
const activeTimers = () => timers.filter((timer) => !clearedTimers.includes(timer));
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
let renderRequests = 0;
const tui = { terminal: { rows: 60 }, requestRender() { renderRequests += 1; } };
const footerData = { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() };
let footer = footerFactory(tui, theme, footerData);
const footerAt = (width) => footer.render(width).map(stripVTControlCharacters);

const usage = (promptTokens, cacheWrite = 0) => ({
	input: 0, output: 1, cacheRead: promptTokens - cacheWrite, cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
});
const turn = (at, promptTokens, turnModel = model) => ({
	type: "message", message: { role: "assistant", stopReason: "stop", content: [], provider: turnModel.provider, model: turnModel.id, timestamp: at, usage: usage(promptTokens) },
});
const piWarm = (at, promptTokens) => ({ type: "usage", kind: "cache_warm", provider: model.provider, model: model.id, timestamp: new Date(at).toISOString(), usage: usage(promptTokens) });
const keepWarm = (at, data) => ({ type: "custom", customType: "keep-cache-warm", timestamp: new Date(at).toISOString(), data });
const keepWarmTool = [{ name: "keep_cache_warm" }];
const show = (scenario, state) => {
	({ settings = {}, tools = [], branch, now } = state);
	context.model = state.model ?? model;
	leafId = scenario;
};
/** The expiry fact in the widest footer, or "none". */
const expiry = () => (footerAt(200).join("\n").match(/warm for \S+/) ?? ["none"])[0];
const piHorizon = policyExported;

const piOr = (withPolicy, without) => (piHorizon ? withPolicy : without);

// Last touch + lifetime: streaming mode never warms an idle cache. The full line, at every width of the ladder.
show("streaming", { settings: { cacheWarming: "streaming" }, branch: [turn(start, 100_000)], now: start + minute });
deepEqual(footerAt(200), [`  workspace/  · context ▅50%  100k / 200k tokens · $0.50  $0.50/turn · cache 100% session · hit 100% · warm for 4m · 100k reused / 0 new`],
	"Without idle warming, the cache must stay warm one lifetime after the last request");
// The label goes with the other labels, and the whole fact hides just before the cost per turn.
deepEqual(footerAt(112), ["  workspace/  · ▅50%  100k / 200k · $0.50  $0.50/turn · 100% session · hit 100% · 4m · 100k reused / 0 new"], "First the label goes with the other labels: the time left alone");
deepEqual(footerAt(90), [" workspace/ ▅50% 100k / 200k $1 $0.50/turn 100% session hit 4m 100k reused / 0 new"], "The time left keeps its short form through the shorter readings and whitespace");
deepEqual(footerAt(60), [" workspace/ ▅50% 100k / 200k $1 $0.50/turn 100% session 4m"], "The time left outlasts the reused/new split and the last message's hit");
deepEqual(footerAt(50), [" workspace/ ▅50% $1 $0.50/turn 100% session 4m"], "The time left outlasts the token counts");
deepEqual(footerAt(40), [" workspace/ ▅50% $1 $0.50/turn 4m"], "The time left outlasts the session hit rate");
deepEqual(footerAt(32), [" workspace/ ▅50% $1 $0.50/turn"], "The time left hides before the cost per turn");
deepEqual(footerAt(28), [" workspace/ ▅50% $1"], "The cost per turn hides after it");

// Pi's idle horizon: Pi refreshes every 4.5 minutes within 30 idle minutes (6 refreshes, the last at 27m), then the lifetime: 32m.
show("idle above", { settings: {}, branch: [turn(start, warmFrom)], now: start + minute });
equal(expiry(), piOr("warm for 31m", "warm for 4m"),
	piHorizon ? "Pi's default idle warming must extend the cache to its last refresh inside 30 minutes" : "Pi before 1.5.1 must fall back to last touch + lifetime");
show("idle explicit", { settings: { cacheWarming: "idle" }, branch: [turn(start, warmFrom)], now: start + minute });
equal(expiry(), piOr("warm for 31m", "warm for 4m"), "An explicit idle setting must give the same time");
show("idle below", { settings: {}, branch: [turn(start, below)], now: start + minute });
equal(expiry(), "warm for 4m", "Below Pi's cost-rule size, Pi does not warm: last touch + lifetime");
show("off", { settings: { cacheWarming: "off" }, branch: [turn(start, warmFrom)], now: start + minute });
equal(expiry(), "warm for 4m", "With warming off: last touch + lifetime");

// Pi's cache warms are touches.
show("pi warm", { settings: { cacheWarming: "streaming" }, branch: [turn(start, below), piWarm(start + 4.5 * minute, below)], now: start + 6 * minute });
equal(expiry(), "warm for 4m", "A Pi cache warm must restart the lifetime");

// pi-keep-cache-warm, loaded in this process: an armed deadline counts until a stop.
const armed = [turn(start, 100_000), keepWarm(start + minute, { kind: "arm", deadline: new Date(start + 60 * minute).toISOString(), prefixTokens: 100_000 })];
show("armed", { tools: keepWarmTool, branch: armed, now: start + minute });
equal(expiry(), "warm for 59m", "An armed deadline later than Pi's horizon must win");
show("armed past an hour", { tools: keepWarmTool, branch: [turn(start, 100_000), keepWarm(start + minute, { kind: "arm", deadline: new Date(start + 125 * minute).toISOString() })], now: start + minute });
equal(expiry(), "warm for 2h4m", "Past an hour, the time left reads in hours and minutes");
show("armed, not loaded", { tools: [], branch: armed, now: start + minute });
equal(expiry(), piOr(100_000 >= warmFrom ? "warm for 31m" : "warm for 4m", "warm for 4m"), "Entries without the loaded extension must not count");
show("armed before load", { tools: keepWarmTool, branch: [turn(start - 20 * minute, warmFrom), keepWarm(start - 15 * minute, { kind: "arm", deadline: new Date(start + 60 * minute).toISOString() }), turn(start, warmFrom)], now: start + minute });
equal(expiry(), piOr("warm for 31m", "warm for 4m"), "An arm written before this process loaded the footer must not count");
show("stopped", { tools: keepWarmTool, branch: [...armed, keepWarm(start + 20 * minute, { kind: "stop", reason: "test", warms: 0, cost: 0 })], now: start + 21 * minute });
equal(expiry(), piOr(100_000 >= warmFrom ? "warm for 11m" : "none", "none"), "A stop must end the deadline, and must not count as a touch");
show("keep warm touch", {
	settings: { cacheWarming: "streaming" }, tools: keepWarmTool, now: start + 41 * minute,
	branch: [...armed, keepWarm(start + 40 * minute, { kind: "warm", provider: model.provider, model: model.id, usage: usage(warmFrom, 1_000) }), keepWarm(start + 40.5 * minute, { kind: "stop" })],
});
equal(expiry(), "warm for 4m", "Every keep-cache-warm warm, even one that wrote, must restart the lifetime");

// A compaction starts over: nothing cached for the next request yet.
show("compacted", { settings: { cacheWarming: "streaming" }, branch: [turn(start, warmFrom), { type: "compaction" }], now: start + minute });
ok(!/warm for/.test(footerAt(200).join("\n")), "After a compaction the footer must show no expiry until the next request");

// OpenAI and Codex: no lifetime, no fact.
show("codex", { model: codex, branch: [turn(start, warmFrom, codex)], now: start + minute });
ok(!/warm for/.test(footerAt(200).join("\n")), "A model without a declared lifetime must show no expiry");
show("other model", { settings: { cacheWarming: "streaming" }, branch: [turn(start, warmFrom, codex)], now: start + minute });
ok(!/warm for/.test(footerAt(200).join("\n")), "Only touches by the selected model count");
// A touch by the selected model, then another model's request: the touch keeps its own lifetime,
// and Pi's idle horizon is dropped, because Pi warms only the last request.
show("model switch", { settings: {}, branch: [turn(start, warmFrom), turn(start + 2 * minute, warmFrom, codex)], now: start + 3 * minute });
equal(expiry(), "warm for 2m", "After another model's request, the selected model's cache must expire one lifetime after its own last touch");

// Passed: the fact hides.
show("passed", { settings: { cacheWarming: "streaming" }, branch: [turn(start, 100_000)], now: start + 5 * minute });
equal(expiry(), "none", "Once the time has passed, the fact must hide");

// The minute timer: started in session_start, unref'd, redraws, and the time left moves.
equal(activeTimers().length, 1, "session_start must start one timer");
equal(activeTimers()[0].milliseconds, minute, "The timer must tick once a minute");
ok(activeTimers()[0].unrefed, "The timer must not keep the process alive");
show("live", { settings: { cacheWarming: "streaming" }, branch: [turn(start, 100_000)], now: start + minute });
equal(expiry(), "warm for 4m");
now += minute;
const rendersBefore = renderRequests;
activeTimers()[0].callback();
equal(renderRequests, rendersBefore + 1, "Each tick must request a render");
equal(expiry(), "warm for 3m", "A minute later the time left must move with no session event");
now += 3 * minute;
activeTimers()[0].callback();
equal(expiry(), "none", "When the time passes between events, the next tick must hide the fact");

// Reload: shutdown clears the timer, the next session_start starts exactly one.
const firstTimer = activeTimers()[0];
await handlers.get("session_shutdown")({ type: "session_shutdown" }, context);
ok(clearedTimers.includes(firstTimer), "session_shutdown must clear the timer");
equal(activeTimers().length, 0, "No timer may survive session_shutdown");
await handlers.get("session_start")({ type: "session_start", reason: "reload" }, context);
await handlers.get("session_start")({ type: "session_start", reason: "new" }, context);
equal(activeTimers().length, 1, "Repeated session starts must leave exactly one timer");
footer = footerFactory(tui, theme, footerData);
await handlers.get("session_shutdown")({ type: "session_shutdown" }, context);
equal(activeTimers().length, 0, "The last shutdown must leave no timer");

rmSync(cacheHome, { recursive: true, force: true });
console.log(`custom-footer cache expiry ok on Pi ${piVersion}`);
