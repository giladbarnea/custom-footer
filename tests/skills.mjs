#!/usr/bin/env node

import { deepEqual } from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getLoadedSkills } = await jiti.import("../skill-tracker.ts");
const customFooterModule = await jiti.import("../index.ts");
const customFooter = customFooterModule.default ?? customFooterModule;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function usage(promptTokens, output = 10_000) {
	return {
		input: promptTokens,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const cwd = "/workspace";
const skills = [
	{ name: "ai-to-leader", filePath: "/skills/ai-to-leader/SKILL.md" },
	{ name: "tdd", filePath: "/skills/tdd/SKILL.md" },
];
const directReadMessages = [
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "read-leader",
				name: "read",
				arguments: { path: "/skills/ai-to-leader/SKILL.md", offset: 1, limit: 2000 },
			},
		],
		stopReason: "toolUse",
		timestamp: 10,
		usage: usage(100_000),
	},
	{
		role: "toolResult",
		toolCallId: "read-leader",
		toolName: "read",
		content: [{ type: "text", text: "skill contents" }],
		isError: false,
		timestamp: 11,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "loaded" }],
		stopReason: "stop",
		timestamp: 12,
		usage: usage(250_000),
	},
];

const directLoads = getLoadedSkills(directReadMessages, skills, cwd);
assert(
	JSON.stringify(directLoads) === JSON.stringify([{ name: "ai-to-leader", loadedAtTokens: 250_000 }]),
	`A successful partial read got the wrong prompt-token baseline: ${JSON.stringify(directLoads)}`,
);

const expandedMessages = [
	{
		role: "user",
		content: [
			{
				type: "text",
				text: [
					'<skill name="tdd" location="/skills/tdd/SKILL.md">Test first.</skill>',
					'<skill name="a/b" location="/tmp/invalid">invalid</skill>',
				].join("\n"),
			},
		],
		timestamp: 20,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		timestamp: 21,
		usage: usage(300_000),
	},
];
assert(
	JSON.stringify(getLoadedSkills(expandedMessages, skills, cwd)) ===
		JSON.stringify([{ name: "tdd", loadedAtTokens: 300_000 }]),
	"Expanded skills were not validated or assigned their next prompt-token baseline",
);

const nestedSkillMessages = [
	{
		role: "user",
		content: [
			{
				type: "text",
				text: '<skill-file skill="ai-to-leader" location="/skills/ai-to-leader/references/human.md">Human.</skill-file>',
			},
		],
		timestamp: 30,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		timestamp: 31,
		usage: usage(320_000),
	},
];
assert(
	getLoadedSkills(nestedSkillMessages, skills, cwd).length === 0,
	"An inline-commands-only skill-file block incorrectly loaded its parent skill",
);

const nestedReadManyMessages = [
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "read-many",
				name: "read_many_files",
				arguments: { paths: ["/skills/tdd/references/example.md", "/workspace/README.md"] },
			},
		],
		stopReason: "toolUse",
		timestamp: 40,
		usage: usage(325_000),
	},
	{
		role: "toolResult",
		toolCallId: "read-many",
		toolName: "read_many_files",
		content: [{ type: "text", text: "files" }],
		isError: false,
		timestamp: 41,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		timestamp: 42,
		usage: usage(330_000),
	},
];
assert(
	getLoadedSkills(nestedReadManyMessages, skills, cwd).length === 0,
	"A nested skill-directory read incorrectly loaded its parent skill",
);

const failedReadMessages = [
	directReadMessages[0],
	{ ...directReadMessages[1], isError: true },
	directReadMessages[2],
];
assert(getLoadedSkills(failedReadMessages, skills, cwd).length === 0, "A failed read loaded its skill");

const compactedMessages = [
	{ role: "compactionSummary", summary: "summary", tokensBefore: 500_000, timestamp: 200 },
	{
		role: "user",
		content: '<skill name="tdd" location="/skills/tdd/SKILL.md">Test first.</skill>',
		timestamp: 100,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "before compaction" }],
		stopReason: "stop",
		timestamp: 150,
		usage: usage(500_000),
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "after compaction" }],
		stopReason: "stop",
		timestamp: 250,
		usage: usage(90_000),
	},
];
assert(
	getLoadedSkills(compactedMessages, skills, cwd)[0]?.loadedAtTokens === 90_000,
	"A retained skill reused its stale pre-compaction token baseline",
);

const handlers = new Map();
let widgetFactory;
let currentTokens = 484_000;
let effectiveMessages = directReadMessages;
const fakePi = {
	events: { on() {} },
	on(eventName, handler) {
		handlers.set(eventName, handler);
	},
	async exec(command) {
		return { stdout: command === "git" ? "main\n" : "", stderr: "", code: 0 };
	},
	getCommands() {
		return skills.map((skill) => ({
			name: `skill:${skill.name}`,
			source: "skill",
			sourceInfo: { path: skill.filePath },
		}));
	},
	getSessionName() {
		return undefined;
	},
	getThinkingLevel() {
		return "high";
	},
};
customFooter(fakePi);
const extensionContext = {
	cwd,
	getContextUsage: () => ({ tokens: currentTokens, contextWindow: 1_000_000, percent: 48.4 }),
	model: { name: "test-model" },
	sessionManager: {
		buildSessionContext: () => ({ messages: effectiveMessages }),
		getBranch: () => [],
		getSessionId: () => "session-1",
		getLeafId: () => "leaf-1",
	},
	ui: {
		setFooter() {},
		setWidget(identifier, factory) {
			if (identifier === "custom-footer-above") widgetFactory = factory;
		},
	},
};
const sessionStart = handlers.get("session_start");
assert(sessionStart, "Custom footer did not register session_start");
await sessionStart({ type: "session_start", reason: "startup" }, extensionContext);
assert(widgetFactory, "Custom footer did not register its header widget");
const theme = {
	bg: (token, text) => `<bg:${token}>${text}</bg>`,
	bold: (text) => text,
	fg: (token, text) => `<fg:${token}>${text}</fg>`,
};
const tui = { terminal: { rows: 60 } };
const headerLines = widgetFactory(tui, theme).render(160);
const expectedSkillPill = "<fg:mdCode>ai-to-leader</fg><fg:dim> -234k</fg>";
assert(
	headerLines.length === 2 && headerLines[1].includes(expectedSkillPill),
	`Custom footer did not render the history-derived token age: ${JSON.stringify(headerLines)}`,
);

currentTokens = 500_000;
const unchangedDuringStreaming = widgetFactory(tui, theme).render(160);
assert(
	unchangedDuringStreaming[1].includes("<fg:dim> -234k</fg>"),
	"Rendering recomputed skill state before turn_end",
);
const turnEnd = handlers.get("turn_end");
assert(turnEnd, "Custom footer did not register turn_end");
await turnEnd({ type: "turn_end" }, extensionContext);
const agedHeaderLines = widgetFactory(tui, theme).render(160);
assert(
	agedHeaderLines[1].includes("<fg:dim> -250k</fg>"),
	`turn_end did not refresh the token age: ${JSON.stringify(agedHeaderLines)}`,
);

const sessionCompact = handlers.get("session_compact");
const sessionTree = handlers.get("session_tree");
assert(sessionCompact, "Custom footer did not register session_compact");
assert(sessionTree, "Custom footer did not register session_tree");
effectiveMessages = [];
await sessionTree({ type: "session_tree" }, extensionContext);
const clearedHeaderLines = widgetFactory(tui, theme).render(160);
assert(clearedHeaderLines.length === 1, `session_tree left removed skill pills: ${JSON.stringify(clearedHeaderLines)}`);

effectiveMessages = directReadMessages;
await sessionCompact({ type: "session_compact" }, extensionContext);
const compactedHeaderLines = widgetFactory(tui, theme).render(160);
assert(
	compactedHeaderLines[1].includes("<fg:dim> -250k</fg>"),
	`session_compact did not refresh skill pills: ${JSON.stringify(compactedHeaderLines)}`,
);

effectiveMessages = [];
await sessionTree({ type: "session_tree" }, extensionContext);
const layoutTheme = { ...theme, fg: (_token, text) => `\x1b[36m${text}\x1b[39m` };
const layoutWidget = widgetFactory(tui, layoutTheme);
const metadataLines = layoutWidget.render(24).map(stripVTControlCharacters);
const metadataLinesAt45 = layoutWidget.render(45).map(stripVTControlCharacters);
const metadataLinesAt60 = layoutWidget.render(60).map(stripVTControlCharacters);
const layoutSkillNames = Array.from({ length: 13 }, (_, index) => `skill-${String(index + 1).padStart(2, "0")}`);
effectiveMessages = [{
	role: "user",
	content: layoutSkillNames.map((name) => `<skill name="${name}" location="/skills/${name}/SKILL.md">Loaded.</skill>`).join("\n"),
}];
await sessionTree({ type: "session_tree" }, extensionContext);
tui.terminal.rows = 40;
deepEqual(
	layoutWidget.render(24).map(stripVTControlCharacters),
	[...metadataLines, " skill-01 skill-02", " skill-03 skill-04", " skill-05 skill-06", " +7 skills"],
	"A terminal with 40 rows must show three skills rows in the most compact layout and the exact hidden skill count",
);

const collapsedHeaderLines = layoutWidget.render(24).map(stripVTControlCharacters);
tui.terminal.rows = 41;
deepEqual(
	layoutWidget.render(24).map(stripVTControlCharacters),
	[
		...metadataLines,
		" skill-01 · skill-02", " skill-03 · skill-04", " skill-05 · skill-06",
		" skill-07 · skill-08", " skill-09 · skill-10", " skill-11 · skill-12", " skill-13",
	],
	"Growing the same terminal to 41 rows must restore the full skills list without a session event",
);
tui.terminal.rows = 24;
deepEqual(
	layoutWidget.render(24).map(stripVTControlCharacters),
	collapsedHeaderLines,
	"Shrinking the same terminal must collapse the list again without losing skills",
);
deepEqual(
	layoutWidget.render(45).map(stripVTControlCharacters),
	[
		...metadataLinesAt45,
		" skill-01 · skill-02 · skill-03 · skill-04",
		" skill-05 · skill-06 · skill-07 · skill-08",
		" skill-09 · skill-10 · skill-11 · skill-12",
		" skill-13",
	],
	"Exactly four skills rows must remain unchanged even when metadata makes the widget taller",
);
deepEqual(
	layoutWidget.render(60).map(stripVTControlCharacters),
	[
		...metadataLinesAt60,
		" skill-01 · skill-02 · skill-03 · skill-04 · skill-05",
		" skill-06 · skill-07 · skill-08 · skill-09 · skill-10",
		" skill-11 · skill-12 · skill-13",
	],
	"Widening the same short terminal must restore the full list when it fits in fewer than four rows",
);

const ladderSkillNames = [
	"theory-of-mind", "cautious-refactor", "ai-to-delegated", "tdd",
	"pseudocode", "type-annotations", "write-tests", "herdr",
];
effectiveMessages = [
	{
		role: "user",
		content: ladderSkillNames.map((name) => `<skill name="${name}" location="/skills/${name}/SKILL.md">Loaded.</skill>`).join("\n"),
		timestamp: 300,
	},
	{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 301, usage: usage(100_000) },
];
currentTokens = 121_000;
await sessionTree({ type: "session_tree" }, extensionContext);
tui.terminal.rows = 40;
const skillRowsAt = (width) => layoutWidget.render(width).slice(-4).map(stripVTControlCharacters);
deepEqual(
	skillRowsAt(46),
	[
		" theory-of-mind -21k · cautious-refactor -21k",
		" ai-to-delegated -21k · tdd -21k",
		" pseudocode -21k · type-annotations -21k",
		" write-tests -21k · herdr -21k",
	],
	"Skills that fit in four rows must keep their token ages and separators",
);
deepEqual(
	skillRowsAt(38),
	[" theory-of-mind · cautious-refactor", " ai-to-delegated · tdd · pseudocode", " type-annotations · write-tests", " herdr"],
	"The first thing a short terminal gives up must be the token ages",
);
deepEqual(
	skillRowsAt(30),
	[" theory…f-mind cautio…factor", " ai-to-…egated tdd pseudocode", " type-a…ations write-tests", " herdr"],
	"After the token ages, a short terminal must drop the separators, then cut the middle of the longest names",
);
deepEqual(
	skillRowsAt(16),
	[" theo…mind", " caut…ctor", " ai-t…ated tdd", " +4 skills"],
	"Hiding skills must come only after every long name keeps just four characters on each side",
);

console.log("custom-footer skill tracking regression ok");
