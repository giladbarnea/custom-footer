/**
 * Show session context, cache usage, cost, and loaded skills around the editor.
 *
 * Skill row. Each loaded skill shows its name and its token age: how far the
 * context has grown since the first response that saw the skill. The age tells
 * how deep in the context the skill now sits. On a terminal of 40 rows or
 * fewer, the skills get at most four rows. When they do not fit, the row gives
 * up the least important thing left, one step at a time:
 *   1. The token ages.
 *   2. The separators between skills.
 *   3. The middle of the longest names, one character per step, down to four
 *      characters on each side of the ellipsis. Names shorter than ten
 *      characters never change.
 *   4. Last, three rows in the most compact layout plus a "+N skills" count.
 * Knowing which skills are loaded matters more than any detail about them, so
 * hiding a skill is the last resort. The Claude Code status line in
 * ~/.claude/statusline.sh uses the same order.
 *
 * Known gaps reviewed September 30, 2026, against Pi 0.99.0:
 * - Costs omit codemode and nested-model usage recorded on tool results.
 * - Loaded skills omit successful reads recorded in tool-result nestedCalls.
 * - The header omits the routed physical model and thinking level.
 * - After compaction, unknown usage falls back to the selected model's window
 *   or 200k, ignoring the known physical window from getContextUsage().
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { getLoadedSkills, type SkillLocation } from "./skill-tracker.ts";

// ── Layout constants ────────────────────────────────────────────────────────

const SHORT_TERMINAL_HEIGHT = 40;
const SKILL_COLLAPSE_ROW_THRESHOLD = 4;
const COLLAPSED_SKILL_ROWS = 3;
// A truncated name keeps four characters on each side of the ellipsis.
const MIN_TRUNCATED_NAME_LENGTH = 9;
const NARROW_SEPARATOR = " ";
const WIDE_SEPARATOR = " · ";
const BRANCH_GLYPH = "";
const CONTEXT_GAUGE_SYMBOLS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const CONTEXT_GAUGE_STEP_COUNT = CONTEXT_GAUGE_SYMBOLS.length;
const CACHE_MISS_NOISE_FLOOR_TOKENS = 1_024;
// Match Theme.fg, which resets the foreground only. A full reset would punch a
// hole in any background the caller has already opened, such as the cwd pill.
const ANSI_FG_RESET = "\x1b[39m";
const QUIET_BLEND = 0.38;

// ── Colour rules ────────────────────────────────────────────────────────────
// Hue means one of two things here and nothing else.
//
// 1. A RAMP is a measurement. Its colour moves with the value, and it is loud
//    only where there is something to act on. CONTEXT_STOPS runs quiet to loud
//    as the window fills. CACHE_STOPS is that same scale mirrored, because a
//    full cache is the good end and an empty one is the problem.
// 2. A FAMILY is a category. One token per kind of fact, held everywhere it
//    appears, so the shape of the footer becomes learnable:
//        accent         place    cwd, branch, dirty marker
//        warning        spend    total cost, cost per turn
//        syntaxKeyword  machine  model name; thinking has its own theme ramp
//        mdCode         skills   loaded skill names
//        dim / muted    labels, units, reference figures, session id
//
// Every colour resolves through the theme. No literal colours below this line.

type Stop = { at: number; token: string; quiet?: boolean };

const CONTEXT_STOPS: readonly Stop[] = [
	{ at: 0, token: "success", quiet: true },
	{ at: 40, token: "success" },
	{ at: 70, token: "warning" },
	{ at: 100, token: "error" },
];

/** The context ramp mirrored, so a full cache is quiet and an empty one is loud. */
const CACHE_STOPS: readonly Stop[] = CONTEXT_STOPS.map((stop) => ({ ...stop, at: 100 - stop.at })).reverse();

const PLACE_TOKEN = "accent";
const SPEND_TOKEN = "warning";
const MACHINE_TOKEN = "syntaxKeyword";
const SKILL_TOKEN = "mdCode";

const THINKING_LEVELS: Record<string, { full: string; short: string; token: string }> = {
	off: { full: "off", short: "o", token: "dim" },
	minimal: { full: "min", short: "mn", token: "thinkingMinimal" },
	low: { full: "low", short: "l", token: "thinkingLow" },
	medium: { full: "med", short: "md", token: "thinkingMedium" },
	high: { full: "high", short: "h", token: "thinkingHigh" },
	xhigh: { full: "xhigh", short: "x", token: "thinkingXhigh" },
	max: { full: "max", short: "mx", token: "thinkingMax" },
};

// ── Shrink ladders ──────────────────────────────────────────────────────────
// The same approach as the Claude Code status line in ~/.claude/statusline.sh.
// Each region packs its rows onto the fewest lines it can, at the fullest state
// that reaches that count. State N applies the first N steps. Each phase gives
// up a kind of detail that matters more than the phase before it, and within a
// phase the least needed fact goes first.

type Form = "full" | "short" | "bare" | "hidden";
/** A fact's text in each form it has. A step names only forms its fact has. */
type FactForms = { full: string } & Partial<Record<"short" | "bare", string>>;
/** One row of facts. Each inner list is one group, joined by the narrow joiner. */
type Row<Key extends string> = readonly (readonly Key[])[];
type Ladder<Key extends string> = {
	rows: readonly Row<Key>[];
	steps: readonly (readonly [Key | "spacing", Form])[];
};
type HeaderFact = "model" | "thinking" | "sessionName" | "sessionId";
type FooterFact = "branch" | "cwd" | "context" | "tokens" | "cost" | "perTurn" | "cacheSession" | "latest" | "reuse";

const SPACING = {
	full: { separator: WIDE_SEPARATOR, joiner: "  " },
	bare: { separator: NARROW_SEPARATOR, joiner: " " },
};

const HEADER_LADDER: Ladder<HeaderFact> = {
	rows: [[["model"], ["thinking"], ["sessionName"], ["sessionId"]]],
	steps: [
		// 1. Narrow the separators to one space.
		["spacing", "bare"],
		// 2. Shorten the thinking level.
		["thinking", "short"],
		// 3. Trim the session id to its first two segments. Last, because the
		//    full id is what finds the session again.
		["sessionId", "short"],
	],
};

const FOOTER_LADDER: Ladder<FooterFact> = {
	rows: [
		[["branch"], ["cwd"]],
		[["context", "tokens"], ["cost", "perTurn"]],
		[["cacheSession"], ["latest"], ["reuse"]],
	],
	steps: [
		// 1. Drop the labels the values already imply.
		["tokens", "short"], ["context", "bare"], ["cacheSession", "bare"],
		// 2. Shorten the readings: the latest cache figure, then the cost, rounded twice.
		["latest", "short"], ["cost", "short"], ["cost", "bare"],
		// 3. Remove whitespace: the padding inside the cwd pill, then the separators.
		["cwd", "short"], ["spacing", "bare"],
		// 4. Drop the branch icon.
		["branch", "bare"],
		// 5. Hide whole facts. The cost per turn goes last, because seeing what
		//    each turn costs is half of what the footer is for.
		["reuse", "hidden"], ["cacheSession", "hidden"], ["tokens", "hidden"], ["perTurn", "hidden"],
	],
};

// ── Generic helpers ─────────────────────────────────────────────────────────

function joinedLine(parts: string[], separator: string): string {
	return ` ${parts.join(separator)}`;
}

/** Wrap whole parts into lines narrower than width. A part wider than width takes a line alone.
 * @example
 * wrapParts(["one", "two"], 6, " · ") // [["one"], ["two"]]
 */
function wrapParts(parts: string[], width: number, separator: string): string[][] {
	const lines: string[][] = [];
	const remainingParts = [...parts];
	while (remainingParts.length > 0) {
		const lineParts: string[] = [];
		while (remainingParts.length > 0) {
			const candidateLine = joinedLine([...lineParts, remainingParts[0]!], separator);
			if (lineParts.length > 0 && visibleWidth(candidateLine) >= width) break;
			lineParts.push(remainingParts.shift()!);
			if (visibleWidth(joinedLine(lineParts, separator)) >= width) break;
		}
		lines.push(lineParts);
	}
	return lines;
}

type WrappedLine = { text: string; partCount: number };

/** Wrap whole parts and retain the number of parts in each row.
 * @example
 * wrapJoinedLines(["one", "two"], 6, " · ") // [{ text: " one", partCount: 1 }, { text: " two", partCount: 1 }]
 */
function wrapJoinedLines(parts: string[], width: number, separator: string): WrappedLine[] {
	return wrapParts(parts, width, separator).map((lineParts) => ({
		text: truncateToWidth(joinedLine(lineParts, separator), width),
		partCount: lineParts.length,
	}));
}

/** Pack rows onto lines. Rows share a line when they fit, and a row breaks only
 * when it is wider than the width, so a fact moves between lines only with its whole row.
 * @example
 * packRows([["a", "b"], ["c"]], 20, " · ") // [" a · b · c"]
 */
function packRows(rows: string[][], width: number, separator: string): string[] {
	const rowLines = rows.flatMap((row) => wrapParts(row, width, separator).map((lineParts) => lineParts.join(separator)));
	return wrapJoinedLines(rowLines, width, separator).map((line) => line.text);
}

/** The ladder's fullest state among those that pack the facts onto the fewest lines.
 * A fact missing from `facts` is left out.
 */
function fitFacts<Key extends string>(
	facts: Partial<Record<Key, FactForms>>,
	ladder: Ladder<Key>,
	width: number,
	theme: Theme,
): string[] {
	const linesAt = (state: number): string[] => {
		const forms = new Map<Key | "spacing", Form>(ladder.steps.slice(0, state));
		const spacing = forms.get("spacing") === "bare" ? SPACING.bare : SPACING.full;
		const text = (key: Key): string => {
			const form = forms.get(key) ?? "full";
			const fact = facts[key];
			return form === "hidden" || !fact ? "" : fact[form]!;
		};
		const rows = ladder.rows.map((row) => row.map((group) => group.map(text).filter(Boolean).join(spacing.joiner)).filter(Boolean));
		return packRows(rows, width, theme.fg("dim", spacing.separator));
	};
	const states = Array.from({ length: ladder.steps.length + 1 }, (_, state) => linesAt(state));
	return states.find((lines) => lines.length === states.at(-1)!.length)!;
}

/** Cut the middle of a name down to maxLength, marking the cut with an ellipsis.
 * @example
 * middleTruncate("cautious-refactor", 9) // "caut…ctor"
 */
function middleTruncate(name: string, maxLength: number): string {
	if (name.length <= maxLength) return name;
	const kept = maxLength - 1;
	return `${name.slice(0, Math.ceil(kept / 2))}…${name.slice(name.length - Math.floor(kept / 2))}`;
}

type SkillLayout = { ages: boolean; separator: string; maxNameLength: number };

/** Skill row layouts, fullest first. Each step gives up the least important
 * thing left: first the token ages, then the separators, then one more
 * character of the longest names.
 * @example
 * skillLayouts(3).length // 3
 */
function skillLayouts(longestName: number): SkillLayout[] {
	const truncations = Array.from(
		{ length: Math.max(0, longestName - MIN_TRUNCATED_NAME_LENGTH) },
		(_, index) => ({ ages: false, separator: NARROW_SEPARATOR, maxNameLength: longestName - 1 - index }),
	);
	return [
		{ ages: true, separator: WIDE_SEPARATOR, maxNameLength: longestName },
		{ ages: false, separator: WIDE_SEPARATOR, maxNameLength: longestName },
		{ ages: false, separator: NARROW_SEPARATOR, maxNameLength: longestName },
		...truncations,
	];
}

function renderExtensionStatuses(
	extensionStatuses: ReadonlyMap<string, string>,
	width: number,
	theme: any,
): string[] {
	if (extensionStatuses.size === 0) return [];
	const statusLine = [...extensionStatuses.entries()]
		.sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
		.join(" ");
	return [truncateToWidth(statusLine, width, theme.fg("dim", "..."))];
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		const millions = n / 1_000_000;
		return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
	}
	if (n >= 1_000) {
		const thousands = n / 1_000;
		return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
	}
	return String(n);
}

function formatCost(value: number): string {
	return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

function currentDirectoryName(cwd: string): string {
	return cwd.split("/").pop() || cwd;
}

function normalizeDisplayValue(value: string): string {
	return value.toLowerCase().replace(/[/\\]/g, "").trim();
}

function trimSessionPrefix(session: string, cwd: string): string {
	const firstWord = session.split(/\s+/)[0] ?? "";
	return normalizeDisplayValue(firstWord) === normalizeDisplayValue(currentDirectoryName(cwd))
		? session.slice(firstWord.length).trim()
		: session;
}

type DisplaySession = { name: string | null; id: string | null };

function getDisplaySession(ctx: any, cwd: string, pi: ExtensionAPI): DisplaySession {
	const customName: string | null = pi.getSessionName?.() || null;
	return {
		name: customName && trimSessionPrefix(customName, cwd),
		id: ctx.sessionManager?.getSessionId?.() || null,
	};
}

function getSkillLocations(pi: ExtensionAPI): SkillLocation[] {
	return pi.getCommands().flatMap((command) => {
		if (command.source !== "skill") return [];
		const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
		return [{ name, filePath: command.sourceInfo.path }];
	});
}

// ── ANSI color helpers ──────────────────────────────────────────────────────

type RgbColor = { red: number; green: number; blue: number };

function ansi256ToRgb(index: number): RgbColor {
	const basicPalette: RgbColor[] = [
		{ red: 0, green: 0, blue: 0 },
		{ red: 128, green: 0, blue: 0 },
		{ red: 0, green: 128, blue: 0 },
		{ red: 128, green: 128, blue: 0 },
		{ red: 0, green: 0, blue: 128 },
		{ red: 128, green: 0, blue: 128 },
		{ red: 0, green: 128, blue: 128 },
		{ red: 192, green: 192, blue: 192 },
		{ red: 128, green: 128, blue: 128 },
		{ red: 255, green: 0, blue: 0 },
		{ red: 0, green: 255, blue: 0 },
		{ red: 255, green: 255, blue: 0 },
		{ red: 0, green: 0, blue: 255 },
		{ red: 255, green: 0, blue: 255 },
		{ red: 0, green: 255, blue: 255 },
		{ red: 255, green: 255, blue: 255 },
	];
	if (index < 16) return basicPalette[index] ?? basicPalette[7]!;
	if (index >= 232) {
		const value = 8 + (index - 232) * 10;
		return { red: value, green: value, blue: value };
	}
	const cubeIndex = index - 16;
	const redLevel = Math.floor(cubeIndex / 36);
	const greenLevel = Math.floor((cubeIndex % 36) / 6);
	const blueLevel = cubeIndex % 6;
	const levelToValue = (level: number) => (level === 0 ? 0 : 55 + level * 40);
	return {
		red: levelToValue(redLevel),
		green: levelToValue(greenLevel),
		blue: levelToValue(blueLevel),
	};
}

function ansiCodeToRgb(code: number): RgbColor | null {
	if (code >= 30 && code <= 37) return ansi256ToRgb(code - 30);
	if (code >= 90 && code <= 97) return ansi256ToRgb(code - 90 + 8);
	return null;
}

function getThemeTokenRgb(theme: any, token: string): RgbColor | null {
	let themed: string;
	try {
		themed = typeof theme.getFgAnsi === "function" ? theme.getFgAnsi(token) : theme.fg(token, "x");
	} catch {
		return null;
	}
	const matches = [...themed.matchAll(/\x1b\[([0-9;]+)m/g)];
	for (let i = matches.length - 1; i >= 0; i -= 1) {
		const codes = matches[i]?.[1]?.split(";").map(Number) ?? [];
		for (let j = 0; j < codes.length; j += 1) {
			const code = codes[j];
			if (code === 38 && codes[j + 1] === 2) {
				return { red: codes[j + 2] ?? 255, green: codes[j + 3] ?? 255, blue: codes[j + 4] ?? 255 };
			}
			if (code === 38 && codes[j + 1] === 5) {
				return ansi256ToRgb(codes[j + 2] ?? 7);
			}
			const basic = ansiCodeToRgb(code);
			if (basic) return basic;
		}
	}
	return null;
}

function blendChannel(start: number, end: number, ratio: number): number {
	return Math.round(start + (end - start) * ratio);
}

function blendRgb(start: RgbColor, end: RgbColor, ratio: number): RgbColor {
	return {
		red: blendChannel(start.red, end.red, ratio),
		green: blendChannel(start.green, end.green, ratio),
		blue: blendChannel(start.blue, end.blue, ratio),
	};
}

function colorizeRgb(text: string, rgb: RgbColor): string {
	return `\x1b[38;2;${rgb.red};${rgb.green};${rgb.blue}m${text}${ANSI_FG_RESET}`;
}

function nearestStop(stops: readonly Stop[], value: number): Stop {
	return stops.reduce((best, stop) =>
		Math.abs(stop.at - value) < Math.abs(best.at - value) ? stop : best,
	);
}

export interface Painter {
	/** A family colour, held wherever that kind of fact appears. */
	token(name: string, text: string): string;
	/** The same family colour, receded, for a figure subordinate to another. */
	quiet(name: string, text: string): string;
	/** A measurement, coloured by where it sits on its own scale. */
	ramp(stops: readonly Stop[], value: number, text: string): string;
}

/**
 * Resolve every colour the footer needs from the live theme.
 *
 * A 256-colour terminal cannot render a blend, so both the ramp and the quiet
 * variant fall back to the nearest whole theme token rather than emitting
 * truecolor the terminal would drop.
 */
function makePainter(theme: any): Painter {
	const blendable = theme.getColorMode?.() !== "256color";
	const resolved = new Map<string, RgbColor | null>();
	const rgbOf = (name: string): RgbColor | null => {
		if (!resolved.has(name)) resolved.set(name, getThemeTokenRgb(theme, name));
		return resolved.get(name) ?? null;
	};
	const quietRgb = (name: string): RgbColor | null => {
		const base = rgbOf(name);
		const dim = rgbOf("dim");
		return base && dim ? blendRgb(base, dim, QUIET_BLEND) : null;
	};
	const stopRgb = (stop: Stop): RgbColor | null => (stop.quiet ? quietRgb(stop.token) : rgbOf(stop.token));

	return {
		token: (name, text) => theme.fg(name, text),
		quiet(name, text) {
			const rgb = blendable ? quietRgb(name) : null;
			return rgb ? colorizeRgb(text, rgb) : theme.fg("dim", text);
		},
		ramp(stops, value, text) {
			const clamped = Math.min(Math.max(value, stops[0]!.at), stops[stops.length - 1]!.at);
			for (let i = 0; i < stops.length - 1; i += 1) {
				const low = stops[i]!;
				const high = stops[i + 1]!;
				if (clamped > high.at) continue;
				const lowRgb = stopRgb(low);
				const highRgb = stopRgb(high);
				if (!blendable || !lowRgb || !highRgb) return theme.fg(nearestStop(stops, clamped).token, text);
				return colorizeRgb(text, blendRgb(lowRgb, highRgb, (clamped - low.at) / (high.at - low.at)));
			}
			return theme.fg(stops[stops.length - 1]!.token, text);
		},
	};
}

function ctxGauge(pct: number): string {
	const stepIndex = Math.min(
		Math.floor(pct / (100 / CONTEXT_GAUGE_STEP_COUNT)),
		CONTEXT_GAUGE_STEP_COUNT - 1,
	);
	return CONTEXT_GAUGE_SYMBOLS[stepIndex]!;
}

function renderThinkingLabel(theme: any, level: string, full: boolean): string {
	const info = THINKING_LEVELS[level];
	if (!info) return level;
	const label = full ? info.full : info.short;
	const text = level === "high" || level === "xhigh" ? theme.bold(label) : label;
	return theme.fg(info.token, text);
}

// ── Session helpers ─────────────────────────────────────────────────────────

interface SessionStats {
	totalCost: number;
	totalReused: number;
	totalFresh: number;
	sessionCacheHitRate: number | null;
	latestCacheHitRate: number | null;
	latestCacheMissTokens: number | null;
	averageCostPerTurn: number;
	lastContextTokens: number; // input+output+cacheRead+cacheWrite of the last valid turn
}

function getSessionStats(ctx: any): SessionStats {
	let turnCount = 0;
	let totalCost = 0;
	let totalReused = 0;
	let totalFresh = 0;
	let lastContextTokens = 0;
	let previousPromptTokens: number | null = null;
	let cacheWasReported = false;
	let latestCacheHitRate: number | null = null;
	let latestCacheMissTokens: number | null = null;
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			previousPromptTokens = null;
			cacheWasReported = false;
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const { input, output, cacheRead, cacheWrite, cost } = message.usage;
		const promptTokens = input + cacheRead + cacheWrite;
		turnCount += 1;
		totalCost += cost.total;
		totalReused += cacheRead;
		totalFresh += input + cacheWrite;
		lastContextTokens = promptTokens + output;
		if (promptTokens <= 0) continue;

		const cacheReported = cacheRead + cacheWrite > 0;
		const cacheKnowledgeAvailable = cacheReported || cacheWasReported;
		latestCacheHitRate = cacheKnowledgeAvailable ? (cacheRead / promptTokens) * 100 : null;
		latestCacheMissTokens = null;
		if (previousPromptTokens !== null && cacheKnowledgeAvailable) {
			const missedTokens = Math.min(previousPromptTokens, promptTokens) - cacheRead;
			latestCacheMissTokens = missedTokens > CACHE_MISS_NOISE_FLOOR_TOKENS ? missedTokens : null;
		}
		previousPromptTokens = promptTokens;
		cacheWasReported ||= cacheReported;
	}
	const totalPrompt = totalReused + totalFresh;
	return {
		totalCost,
		totalReused,
		totalFresh,
		sessionCacheHitRate: totalPrompt > 0 ? (totalReused / totalPrompt) * 100 : null,
		latestCacheHitRate,
		latestCacheMissTokens,
		averageCostPerTurn: turnCount > 0 ? totalCost / turnCount : 0,
		lastContextTokens,
	};
}

// Mirror pi's own context accounting (calculateContextTokens in
// dist/core/compaction/compaction.js: input+output+cacheRead+cacheWrite of the
// last valid assistant turn). getContextUsage() is authoritative when present;
// the fallback only fires before the first response or right after compaction.
function getContextPercent(
	ctx: any,
	lastContextTokens: number,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
): { pct: number; window: number; tokens: number } {
	if (usage && usage.percent != null) {
		return { pct: usage.percent, window: usage.contextWindow ?? 0, tokens: usage.tokens ?? 0 };
	}
	const window = ctx.model?.contextWindow ?? 200_000;
	return {
		pct: window > 0 ? (lastContextTokens / window) * 100 : 0,
		window,
		tokens: lastContextTokens,
	};
}

function formatModel(model: any): string {
	const rawName = model?.name || model?.id || "no-model";
	const words = rawName.split(/\s+/);
	return words.length === 2 && words[0]?.endsWith(":") ? words[1] : rawName;
}

interface FooterSnapshot {
	manager: ExtensionContext["sessionManager"];
	sessionId: string;
	leafId: string | null;
	model: ExtensionContext["model"];
	stats: SessionStats;
	context: ReturnType<typeof getContextPercent>;
	session: DisplaySession;
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let currentCtx: any = null;
	let tuiRef: any = null;
	let gitBranch: string | null = null;
	let gitDirty = false;
	let thinkingLevel = "off";
	let loadedSkills: Array<{ name: string; tokenAge: number | null }> = [];
	let skillsDirty = true;
	let snapshot: FooterSnapshot | undefined;

	// ── Rendering ────────────────────────────────────────────────────────

	function refreshLoadedSkills(ctx: any, currentContextTokens: number | null): void {
		loadedSkills = getLoadedSkills(
			ctx.sessionManager.buildSessionContext().messages,
			getSkillLocations(pi),
			ctx.cwd,
		).map(({ name, loadedAtTokens }) => ({
			name,
			tokenAge:
				currentContextTokens !== null && loadedAtTokens !== null && currentContextTokens >= loadedAtTokens
					? currentContextTokens - loadedAtTokens
					: null,
		}));
	}

	function getSnapshot(): FooterSnapshot {
		const manager: ExtensionContext["sessionManager"] = currentCtx.sessionManager;
		const sessionId = manager.getSessionId();
		const leafId = manager.getLeafId();
		const model: ExtensionContext["model"] = currentCtx.model;
		if (snapshot && snapshot.manager === manager && snapshot.sessionId === sessionId && snapshot.leafId === leafId && snapshot.model === model) return snapshot;
		const stats = getSessionStats(currentCtx);
		const usage = currentCtx.getContextUsage();
		if (skillsDirty) refreshLoadedSkills(currentCtx, usage?.tokens ?? null);
		skillsDirty = false;
		snapshot = {
			manager, sessionId, leafId, model, stats,
			context: getContextPercent(currentCtx, stats.lastContextTokens, usage),
			session: getDisplaySession(currentCtx, currentCtx.cwd || ".", pi),
		};
		return snapshot;
	}

	function renderAbove(width: number, terminalHeight: number, theme: Theme): string[] {
		if (!currentCtx) return [];
		const paint = makePainter(theme);
		const { session } = getSnapshot();
		// Weight is reserved for the pill and for thinking at high and above, so
		// the model carries its family hue and nothing more.
		const headerFacts: Partial<Record<HeaderFact, FactForms>> = {
			model: { full: paint.token(MACHINE_TOKEN, formatModel(currentCtx.model)) },
			thinking: { full: renderThinkingLabel(theme, thinkingLevel, true), short: renderThinkingLabel(theme, thinkingLevel, false) },
			sessionName: session.name ? { full: theme.fg("text", session.name) } : undefined,
			sessionId: session.id
				? { full: theme.fg("dim", session.id), short: theme.fg("dim", session.id.split("-").slice(0, 2).join("-")) }
				: undefined,
		};
		// No background here: the cwd pill is the one filled element in the whole
		// footer, and a second pill style would leave neither of them the anchor.
		const renderSkillLines = (layout: SkillLayout) => wrapJoinedLines(
			loadedSkills.map(({ name, tokenAge }) => {
				const nameText = paint.token(SKILL_TOKEN, middleTruncate(name, layout.maxNameLength));
				const ageText = layout.ages && tokenAge !== null ? theme.fg("dim", ` -${formatTokens(tokenAge)}`) : "";
				return `${nameText}${ageText}`;
			}),
			width,
			theme.fg("dim", layout.separator),
		);
		// A short terminal takes the fullest layout that fits the row limit. Hiding
		// skills behind a count is the last resort, after the most compact layout.
		const shortTerminal = terminalHeight <= SHORT_TERMINAL_HEIGHT;
		const layouts = skillLayouts(Math.max(0, ...loadedSkills.map(({ name }) => name.length)));
		const candidates = shortTerminal ? layouts : layouts.slice(0, 1);
		const layout = candidates.find((candidate) => renderSkillLines(candidate).length <= SKILL_COLLAPSE_ROW_THRESHOLD) ?? candidates.at(-1)!;
		const skillLines = renderSkillLines(layout);
		const collapseSkills = shortTerminal && skillLines.length > SKILL_COLLAPSE_ROW_THRESHOLD;
		const visibleSkillLines = collapseSkills ? skillLines.slice(0, COLLAPSED_SKILL_ROWS) : skillLines;
		const hiddenSkillCount = skillLines.slice(visibleSkillLines.length).reduce((count, line) => count + line.partCount, 0);
		const overflowLines = hiddenSkillCount === 0 ? [] : [truncateToWidth(theme.fg("dim", ` +${hiddenSkillCount} skills`), width)];
		return [
			...fitFacts(headerFacts, HEADER_LADDER, width, theme),
			...visibleSkillLines.map((line) => line.text),
			...overflowLines,
		];
	}

	function renderBelow(width: number, theme: any): string[] {
		if (!currentCtx) return [];
		const { stats, context: { pct, window, tokens } } = getSnapshot();
		const paint = makePainter(theme);
		const label = (text: string) => theme.fg("dim", `${text} `);
		const pill = (text: string) => theme.bg("selectedBg", paint.token(PLACE_TOKEN, theme.bold(text)));
		const directory = currentDirectoryName(currentCtx.cwd || ".");
		// A dirty worktree is a property of the place, not a cost, so it stays in
		// the place family and leaves `warning` meaning spend alone.
		const dirty = gitDirty ? paint.token(PLACE_TOKEN, "*") : "";
		const gauge = paint.ramp(CONTEXT_STOPS, pct, `${ctxGauge(pct)} ${Math.round(pct)}%`);
		// Colour the figure that moves and leave its reference quiet, so the eye
		// lands on the reading rather than on the window size beside it.
		const usedTokens = paint.ramp(CONTEXT_STOPS, pct, formatTokens(tokens));
		const usingSubscription = currentCtx.model
			? currentCtx.modelRegistry?.isUsingOAuth?.(currentCtx.model)
			: false;
		const cost = (amount: string) => paint.token(SPEND_TOKEN, `$${amount}`) + (usingSubscription ? theme.fg("muted", " sub") : "");
		// A hit rate is a measurement, so it rides the ramp. The old cliff at 80%
		// made 79% and 20% look identical and threw the reading away.
		const sessionHit = stats.sessionCacheHitRate;
		const sessionHitText = sessionHit != null
			? paint.ramp(CACHE_STOPS, sessionHit, `${sessionHit.toFixed(1)}% session`)
			: theme.fg("dim", "no cache yet");
		const latestHit = stats.latestCacheHitRate;
		const missedTokens = stats.latestCacheMissTokens;
		const footerFacts: Partial<Record<FooterFact, FactForms>> = {
			branch: gitBranch
				? { full: `${paint.token(PLACE_TOKEN, `${BRANCH_GLYPH} ${gitBranch}`)}${dirty}`, bare: `${paint.token(PLACE_TOKEN, gitBranch)}${dirty}` }
				: undefined,
			cwd: { full: pill(` ${directory}/ `), short: pill(`${directory}/`) },
			context: { full: `${label("context")}${gauge}`, bare: gauge },
			tokens: {
				full: `${usedTokens}${theme.fg("dim", ` / ${formatTokens(window)} tokens`)}`,
				short: `${usedTokens}${theme.fg("dim", ` / ${formatTokens(window)}`)}`,
			},
			cost: { full: cost(formatCost(stats.totalCost)), short: cost(stats.totalCost.toFixed(1)), bare: cost(stats.totalCost.toFixed(0)) },
			perTurn: { full: paint.quiet(SPEND_TOKEN, `$${formatCost(stats.averageCostPerTurn)}/turn`) },
			cacheSession: { full: `${label("cache")}${sessionHitText}`, bare: sessionHitText },
			latest: missedTokens != null
				? { full: theme.fg("error", `latest miss ${formatTokens(missedTokens)} re-billed`), short: theme.fg("error", `miss ${formatTokens(missedTokens)}`) }
				: latestHit != null
					? { full: paint.ramp(CACHE_STOPS, latestHit, `latest ${latestHit.toFixed(1)}%`), short: paint.ramp(CACHE_STOPS, latestHit, `latest ${Math.round(latestHit)}%`) }
					: undefined,
			reuse: {
				full: paint.ramp(CACHE_STOPS, sessionHit ?? 0, formatTokens(stats.totalReused)) +
					theme.fg("dim", ` reused / ${formatTokens(stats.totalFresh)} new`),
			},
		};
		return fitFacts(footerFacts, FOOTER_LADDER, width, theme);
	}

	// ── Git ───────────────────────────────────────────────────────────────

	async function refreshGit(): Promise<void> {
		try {
			const branchResult = await pi.exec("git", ["branch", "--show-current"]);
			gitBranch = branchResult.stdout.trim() || null;
			if (!gitBranch) {
				gitDirty = false;
				return;
			}
			const statusResult = await pi.exec("git", ["status", "--porcelain"]);
			gitDirty = statusResult.stdout.trim().length > 0;
		} catch {
			gitBranch = null;
			gitDirty = false;
		}
	}

	function requestRender(): void {
		tuiRef?.requestRender();
	}

	function updateCtx(ctx: any): void {
		currentCtx = ctx;
		snapshot = undefined;
		requestRender();
	}

	async function refreshCtx(ctx: any): Promise<void> {
		currentCtx = ctx;
		snapshot = undefined;
		await refreshGit();
		requestRender();
	}

	// ── Event wiring ──────────────────────────────────────────────────────

	pi.events.on("session:name-changed", () => {
		snapshot = undefined;
		requestRender();
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		currentCtx = ctx;
		snapshot = undefined;
		skillsDirty = true;
		thinkingLevel = pi.getThinkingLevel() ?? "off";
		await refreshGit();

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				void refreshGit().then(requestRender);
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return [...renderBelow(width, theme), ...renderExtensionStatuses(footerData.getExtensionStatuses(), width, theme)];
				},
			};
		});

		ctx.ui.setWidget(
			"custom-footer-above",
			(tui: TUI, theme: Theme) => ({
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					return renderAbove(width, tui.terminal.rows, theme);
				},
			}),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
		tuiRef = null;
		gitBranch = null;
		gitDirty = false;
		loadedSkills = [];
		snapshot = undefined;
		skillsDirty = true;
	});

	pi.on("model_select", async (_event: any, ctx: any) => updateCtx(ctx));
	pi.on("thinking_level_select", async (event: any) => {
		thinkingLevel = event.level;
		requestRender();
	});
	pi.on("message_end", async (_event: any, ctx: any) => updateCtx(ctx));
	pi.on("turn_end", async (_event: any, ctx: any) => {
		skillsDirty = true;
		await refreshCtx(ctx);
	});
	pi.on("session_compact", async (_event: any, ctx: any) => {
		skillsDirty = true;
		updateCtx(ctx);
	});
	pi.on("session_tree", async (_event: any, ctx: any) => {
		skillsDirty = true;
		updateCtx(ctx);
	});
}
