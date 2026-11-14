/**
 * Show session context, cache usage, cost, and loaded skills around the editor.
 *
 * Skill row. Each loaded skill shows its name and its token age: how far the
 * context has grown since the first response that saw the skill. The age tells
 * how deep in the context the skill now sits. Skills get one row for every
 * eight terminal rows past the first six, rounded down, with a minimum of one.
 * When they do not fit, the row gives up the least important thing left:
 *   1. The token ages.
 *   2. The separators between skills.
 *   3. The middle of the longest names, one character per step, down to four
 *      characters on each side of the ellipsis. Names shorter than ten
 *      characters never change.
 *   4. Last, hide skills from the end behind a "+N" count that ends the
 *      last row.
 * Knowing which skills are loaded matters more than any detail about them, so
 * hiding a skill is the last resort. The Claude Code status line in
 * ~/.claude/statusline.sh uses the same order.
 *
 * Known gaps reviewed September 30, 2026, against Pi 0.99.0:
 * - Costs omit codemode and nested-model usage recorded on tool results.
 * - Loaded skills omit successful reads recorded in tool-result nestedCalls
 *   that ran without this extension, which records their returned text.
 * - The header omits the routed physical model and thinking level.
 * - After compaction, unknown usage falls back to the selected model's window
 *   or 200k, ignoring the known physical window from getContextUsage().
 *
 * Known differences from Pi's cache-miss notice, reviewed November 11, 2026,
 * against Pi 1.4.0 and 1.5.2:
 * - The footer shows a miss above 1,024 tokens when at most 90% of the
 *   prompt was read from the cache. Pi's notice hides a miss under 20k tokens
 *   that also costs under $0.10.
 * - Errored and aborted turns are skipped, as elsewhere in the footer. Pi's
 *   scan includes them.
 * - The footer scans the current branch. Pi scans every session entry.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as piAi from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import {
	getLoadedSkills, isNestedSkillRead, NESTED_SKILL_READ_ENTRY, nestedReadText, nestedSkillReadTexts,
	type NestedSkillRead, type SkillLocation,
} from "./skill-tracker.ts";

// ── Layout constants ────────────────────────────────────────────────────────

// The skill-row limit reads only the terminal height, never the todo list, editor or other widgets: predictable, and no measuring loop with taller-editor.
// Accepted cost: when a short screen and a long todo list overflow Pi's stack, Pi cuts the skill rows first, rather than us measuring Pi's internal layout.
// Calibrated on a phone over SSH: 21 terminal rows give one skill row, 22 to
// 29 give two, and 30 to 37 give three.
const MINIMUM_SKILL_ROWS = 1;
const TERMINAL_ROWS_BEFORE_SKILL_ROWS = 6;
const TERMINAL_ROWS_PER_SKILL_ROW = 8;
// A truncated name keeps four characters on each side of the ellipsis.
const MIN_TRUNCATED_NAME_LENGTH = 9;
const NARROW_SEPARATOR = " ";
const WIDE_SEPARATOR = " · ";
const BRANCH_GLYPH = "";
const CONTEXT_GAUGE_SYMBOLS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const CONTEXT_GAUGE_STEP_COUNT = CONTEXT_GAUGE_SYMBOLS.length;
const CACHE_MISS_NOISE_FLOOR_TOKENS = 1_024;
// The last message counts as a cache hit when more than this share of its prompt was read from the cache.
const CACHE_HIT_ABOVE_PERCENT = 90;
// Pi's prompt-cache TTL: a miss after a longer idle gap names the gap as its cause.
const CACHE_TTL_MS = 5 * 60 * 1000;
// Match Theme.fg, which resets the foreground only. A full reset would punch a
// hole in any background the caller has already opened, such as the cwd pill.
const ANSI_FG_RESET = "\x1b[39m";
const QUIET_BLEND = 0.38;
const PACE_BAR_CELLS = 9;
const MINUTE_MS = 60_000;
// pi-keep-cache-warm's session entries and tool, read only while that extension is loaded.
const KEEP_CACHE_WARM_ENTRY = "keep-cache-warm";
const KEEP_CACHE_WARM_TOOL = "keep_cache_warm";
// The quota tool refreshes its cache every 5 minutes while in use. A reading older than half an hour has gone stale.
const PACE_STALE_AFTER_MS = 30 * 60 * 1000;
// The quota tool's own rule (FABLE_SHARE_OF_WEEKLY in its pick.py): Fable use counts at half weight against the shared Claude week.
const FABLE_SHARE_OF_WEEKLY = 0.5;

// ── Colour rules ────────────────────────────────────────────────────────────
// Hue means one of two things here and nothing else.
//
// 1. A RAMP is a measurement. Its colour moves with the value, and it is loud
//    only where there is something to act on. CONTEXT_STOPS runs quiet to loud
//    as the window fills. CACHE_STOPS is that same scale mirrored, because a
//    full cache is the good end and an empty one is the problem. PACE_STOPS is
//    the quota tool's heat map: green at the ideal 1.0×, cool where allowance
//    goes unused, amber then red where it runs out early.
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

/** The quota tool's pace heat map (DashboardPalette.pace) on theme tokens, over pacePosition's scale. `mdLink` is the theme's cool blue. */
const PACE_STOPS: readonly Stop[] = [
	{ at: -1, token: "mdLink" },
	{ at: 0, token: "success" },
	{ at: 0.5, token: "warning" },
	{ at: 1, token: "error" },
];

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

type Form = "full" | "short" | "brief" | "bare" | "least" | "hidden";
/** A fact's text in each form it has. A step names only forms its fact has. */
type FactForms = { full: string } & Partial<Record<"short" | "brief" | "bare" | "least", string>>;
/** One row of facts. Each inner list is one group, joined by the narrow joiner. */
type Row<Key extends string> = readonly (readonly Key[])[];
type Ladder<Key extends string> = {
	rows: readonly Row<Key>[];
	steps: readonly (readonly [Key | "spacing", Form])[];
};
type HeaderFact = "model" | "thinking" | "sessionName" | "sessionId";
type FooterFact = "branch" | "cwd" | "context" | "tokens" | "cost" | "perTurn" | "cacheSession" | "latest" | "expiry" | "reuse" | "pace";

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
		[["cacheSession"], ["latest"], ["expiry"], ["reuse"]],
		[["pace"]],
	],
	steps: [
		// 1. Drop what the values already imply. First the pace bar and the words
		//    "resets in": the bar draws what the two rates say. Then the labels.
		["pace", "short"],
		["tokens", "short"], ["context", "bare"], ["cacheSession", "bare"], ["expiry", "short"],
		// 2. Shorten the readings: the last message's cache share (for a
		//    detected miss, its re-billed tokens), then the cost, rounded twice.
		["latest", "short"], ["cost", "short"], ["cost", "bare"],
		// 3. Remove whitespace: the padding inside the cwd pill, then the separators.
		["cwd", "short"], ["spacing", "bare"],
		// 4. Drop the branch icon.
		["branch", "bare"],
		// 5. Hide whole facts. First the "sub" mark: that a model runs on your
		//    subscription is rarely news, so it is the least important fact, but
		//    it is still data and outlasts all the formatting above. Then a stale
		//    quota reading's age: it outlasts the bar, the labels and the
		//    whitespace, so a laptop still sees that the rates are old, and it
		//    goes before every other part of the pace left. Then the burn rate
		//    and the reset time: the sign keeps the verdict, and the target is
		//    the number to act on. The last message's "hit" or "miss" hides
		//    before the session hit rate: the session rate is the cost signal,
		//    and the last message only hints at it. The session rate also
		//    outlasts the token counts, which the context gauge already sums
		//    up, so a phone keeps one cache fact. The word
		//    "target" outlasts the cache and token facts, because it names that
		//    number once the burn rate is gone. The time left on the cache
		//    outlasts it: it says whether to hurry back before a cold restart.
		//    The cost per turn goes last of them, because seeing what each turn
		//    costs is half of what the footer is for. The target rate hides only
		//    at the very end, in step 7.
		["cost", "least"],
		["pace", "brief"], ["pace", "bare"],
		["reuse", "hidden"], ["latest", "brief"], ["tokens", "hidden"], ["cacheSession", "hidden"], ["pace", "least"], ["expiry", "hidden"], ["perTurn", "hidden"],
		// 6. Drop the cause of a detected cache miss, keeping its cost.
		//    Unlike a plain "hit" or "miss", it outranks every hidden fact: it
		//    shows only on the turn that missed, and says what to do about the
		//    cost (an idle gap or a model switch).
		["latest", "bare"],
		// 7. Last, hide the target rate. Because the footer takes the fullest
		//    state with the fewest lines, this fires only where the target alone
		//    would add a line, as on a phone with the keyboard up.
		["pace", "hidden"],
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

/** Wrap whole parts into joined lines that fit the width.
 * @example
 * wrapJoinedLines(["one", "two"], 6, " · ") // [" one", " two"]
 */
function wrapJoinedLines(parts: string[], width: number, separator: string): string[] {
	return wrapParts(parts, width, separator).map((lineParts) => truncateToWidth(joinedLine(lineParts, separator), width));
}

/** Pack rows onto lines. Rows share a line when they fit, and a row breaks only
 * when it is wider than the width, so a fact moves between lines only with its whole row.
 * @example
 * packRows([["a", "b"], ["c"]], 20, " · ") // [" a · b · c"]
 */
function packRows(rows: string[][], width: number, separator: string): string[] {
	const rowLines = rows.flatMap((row) => wrapParts(row, width, separator).map((lineParts) => lineParts.join(separator)));
	return wrapJoinedLines(rowLines, width, separator);
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

/** A number with as many decimal places as its size earns: two below 10, one below 100, none from 100, and never more than maxPlaces.
 * @example
 * [formatDecimal(0.099), formatDecimal(9.996), formatDecimal(12.34), formatDecimal(99.96), formatDecimal(123.4), formatDecimal(5.25, 1)]
 * // ["0.10", "10.0", "12.3", "100", "123", "5.3"]
 */
function formatDecimal(value: number, maxPlaces = 2): string {
	const places = [2, 1].find((candidate) => candidate <= maxPlaces && Number(value.toFixed(candidate)) < 10 ** (3 - candidate)) ?? 0;
	return value.toFixed(places);
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

/** A cache miss in the terms of Pi's own miss notice. */
type CacheMiss = { missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean };
type PreviousRequest = { promptTokens: number; modelKey: string; timestamp: number; reportedCache: boolean };
type ModelLookup = Pick<ExtensionContext["modelRegistry"], "find">;

// Mirror pi's own miss detection (detectMiss in dist/core/cache-stats.js, which
// pi does not export), so the footer reports the numbers of pi's notice.
function detectCacheMiss(previous: PreviousRequest | undefined, message: AssistantMessage, models: ModelLookup): CacheMiss | null {
	const { input, cacheRead, cacheWrite, cost } = message.usage;
	const promptTokens = input + cacheRead + cacheWrite;
	if (!previous || (cacheRead + cacheWrite === 0 && !previous.reportedCache)) return null;
	const missedTokens = Math.min(previous.promptTokens, promptTokens) - cacheRead;
	if (missedTokens <= CACHE_MISS_NOISE_FLOOR_TOKENS) return null;
	const paidTokens = input + cacheWrite;
	const paidPerToken = paidTokens > 0 ? (cost.input + cost.cacheWrite) / paidTokens : 0;
	const readPerToken = cacheRead > 0
		? cost.cacheRead / cacheRead
		: (models.find(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - previous.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== previous.modelKey,
	};
}

/** The last message's miss in its three forms. Ranked: what it cost, then why it
 * happened, then how many tokens. Without a cost, the tokens take its place.
 * @example
 * cacheMissForms({ missedTokens: 199_000, missedCost: 0.38, idleMs: 360_000, modelChanged: false })
 * // { full: "miss after 6m idle: 199k re-billed $0.38", short: "miss 6m idle $0.38", bare: "miss $0.38" }
 */
function cacheMissForms(miss: CacheMiss): Record<"full" | "short" | "bare", string> {
	// Pi's notice shows a cost from one cent, rounded to cents, and an idle gap from the TTL, in whole minutes.
	const cost = miss.missedCost >= 0.01 ? `$${formatDecimal(miss.missedCost)}` : null;
	const cause = miss.modelChanged ? "model switch" : miss.idleMs >= CACHE_TTL_MS ? `${Math.round(miss.idleMs / 60_000)}m idle` : null;
	const tokens = formatTokens(miss.missedTokens);
	const words = (...parts: (string | null)[]) => parts.filter(Boolean).join(" ");
	return {
		full: words("miss", cause && `after ${cause}:`, `${tokens} re-billed`, cost),
		short: words("miss", cause, cost ?? tokens),
		bare: words("miss", cost ?? tokens),
	};
}

// ── Quota pace ──────────────────────────────────────────────────────────────
// Read from the cache file the author's `quota` tool writes. The footer never
// runs the tool and never fetches: it shows the last reading any quota run
// left there, and adds the reading's age once it is stale. It reads the file
// once per snapshot, not per redraw.

type QuotaPool = "CLAUDE" | "FABLE" | "CODEX";
type WeeklyWindow = { used_pct: number; window_start: string; window_duration_seconds: number };
type QuotaCache = Record<string, { written_at?: string; usages?: { name: string; weekly: WeeklyWindow }[] }>;
/** One weekly limit's pace. `used` and `elapsed` are shares of the window, 0 to 1. `ageMs` is how old the reading is. */
type Pace = { burn: number; target: number; used: number; elapsed: number; resetsInMs: number; ageMs: number };

function quotaCacheFile(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "quota", "provider-usage.json");
}

/** The weekly pool a model spends from.
 * @example
 * quotaPool({ provider: "anthropic", id: "claude-fable-5-2" }) // "FABLE"
 */
function quotaPool(model: ExtensionContext["model"]): QuotaPool | null {
	if (model?.provider === "openai-codex") return "CODEX";
	if (model?.provider !== "anthropic") return null;
	return model.id.includes("fable") ? "FABLE" : "CLAUDE";
}

/** Burn and target rate of one weekly window, as the quota tool computes them. Null outside the window.
 * @example
 * windowPace({ used_pct: 15, window_start: "2026-01-01T00:00:00Z", window_duration_seconds: 1000 }, Date.parse("2026-01-01T00:01:40Z"))
 * // { burn: 1.5, target: 0.944…, used: 0.15, elapsed: 0.1, resetsInMs: 900_000 }
 * The age is the caller's: it comes from the provider entry, not the window.
 */
function windowPace(weekly: WeeklyWindow, now: number): Omit<Pace, "ageMs"> | null {
	const durationMs = weekly.window_duration_seconds * 1000;
	const elapsedMs = now - Date.parse(weekly.window_start);
	if (elapsedMs <= 0 || elapsedMs >= durationMs) return null;
	const used = weekly.used_pct / 100;
	const elapsed = elapsedMs / durationMs;
	return { burn: used / elapsed, target: Math.max(0, 1 - used) / (1 - elapsed), used, elapsed, resetsInMs: durationMs - elapsedMs };
}

/** The pace of the model's pool, from the quota cache. Fable's target is the quota tool's pick score:
 * its own target rate, capped by the room left in the shared Claude week. The age is that of the
 * provider entry holding the pool, which Claude and Fable share.
 */
function readPace(model: ExtensionContext["model"], now: number): Pace | null {
	const pool = quotaPool(model);
	if (!pool) return null;
	// The file belongs to another tool. A missing file, another shape or a missing pool all mean no reading.
	try {
		const cache: QuotaCache = JSON.parse(readFileSync(quotaCacheFile(), "utf8"));
		const providerOf = (name: QuotaPool) => Object.values(cache).find((provider) => provider.usages?.some((usage) => usage.name === name))!;
		const paceOf = (name: QuotaPool): Omit<Pace, "ageMs"> | null => windowPace(providerOf(name).usages!.find((usage) => usage.name === name)!.weekly, now);
		const ageMs = Math.max(0, now - Date.parse(providerOf(pool).written_at!));
		const pace = paceOf(pool);
		if (!pace || Number.isNaN(ageMs)) return null;
		if (pool !== "FABLE") return { ...pace, ageMs };
		const claude = paceOf("CLAUDE");
		return claude && { ...pace, target: Math.min(pace.target, claude.target / FABLE_SHARE_OF_WEEKLY), ageMs };
	} catch {
		return null;
	}
}

/** Where a rate sits on PACE_STOPS, by its distance from the ideal 1.0×. Mirrors the quota tool's
 * DashboardPalette.pace: a burn rate heats above 1.0× (amber at 1.25×, red at 2×) and cools below it;
 * a target rate runs the other way. Both are ideal within 5% of 1.0×.
 * @example
 * [pacePosition(1, false), pacePosition(1.25, false), pacePosition(2, false), pacePosition(0.25, false)] // [0, 0.5, 1, -1]
 * [pacePosition(0.8, true), pacePosition(4, true)] // [0.5, -1]
 */
function pacePosition(rate: number, isTarget: boolean): number {
	const pressure = (isTarget ? -1 : 1) * Math.log2(rate);
	const idealBand = Math.log2(1.05);
	const amberPoint = Math.log2(1.25);
	if (pressure < -idealBand) return -Math.min(1, (-pressure - idealBand) / (2 - idealBand));
	if (pressure <= idealBand) return 0;
	if (pressure <= amberPoint) return 0.5 * (pressure - idealBand) / (amberPoint - idealBand);
	return 0.5 + 0.5 * Math.min(1, (pressure - amberPoint) / (1 - amberPoint));
}

/** The used share (●) against the elapsed share (┊) of the window. The dot passes the marker when use is ahead of time.
 * @example
 * paceBar(0.55, 0.6, String, String) // "━━━━●┊───"
 * paceBar(0.9, 0.85, String, String) // "━━━━━━┊●─"
 */
function paceBar(used: number, elapsed: number, heat: (text: string) => string, quiet: (text: string) => string): string {
	const first = Math.round(Math.min(used, elapsed) * (PACE_BAR_CELLS - 2));
	const second = Math.max(first + 1, Math.round(Math.min(1, Math.max(used, elapsed)) * (PACE_BAR_CELLS - 1)));
	const between = second - first - 1;
	const after = "─".repeat(PACE_BAR_CELLS - 1 - second);
	return used > elapsed
		? `${heat("━".repeat(first))}${quiet("┊")}${heat(`${"━".repeat(between)}●`)}${quiet(after)}`
		: `${heat(`${"━".repeat(first)}●`)}${quiet(`${"─".repeat(between)}┊${after}`)}`;
}

/** A duration in the quota tool's own format: time left, or a reading's age.
 * @example
 * [formatRemaining(45_000_000), formatRemaining(110_000_000), formatRemaining(1_800_000)] // ["12h", "1d 6h", "30m"]
 */
function formatRemaining(milliseconds: number): string {
	const hours = Math.floor(milliseconds / 3_600_000);
	if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h`;
	return `${Math.floor(milliseconds / 60_000)}m`;
}

// ── Cache expiry ────────────────────────────────────────────────────────────
// When the prompt cache is really gone: the latest of three times. The last
// touch plus the model's cache lifetime. Pi's own idle-warming horizon, when Pi
// will refresh this context. And an armed pi-keep-cache-warm deadline, when
// that extension runs in this Pi process. Pi's warming policy comes from pi-ai,
// which exports it since Pi 1.5.1. Without it, or without idle warming (the
// default since Pi 1.5.1), the time is last touch plus lifetime.

/** Pi's idle cache-warming policy, exported by pi-ai since Pi 1.5.1. */
type PiWarmingPolicy = {
	evaluateCacheWarming(model: Model<Api>, promptTokens: number, phase: "idle"): { action: "warm" | "stop" };
	getCacheWarmingDelayMs(ttlMs: number): number | undefined;
	getPromptCacheTtlMs(model: Model<Api>): number | undefined;
	CACHE_WARMING_MAX_IDLE_AGE_MS: number;
};
const piWarming = piAi as unknown as Partial<PiWarmingPolicy>;
/** Pi's own lifetime lookup where pi-ai exports it, else the same lookup on the model's `promptCache`. */
const promptCacheTtlMs = piWarming.getPromptCacheTtlMs ?? ((model: Model<Api>): number | undefined => {
	const seconds = model.promptCache?.[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
	return seconds === undefined ? undefined : seconds * 1000;
});

type KeepCacheWarmData = { kind: "arm"; deadline: string } | { kind: "warm"; provider: string; model: string } | { kind: "stop" };
type CacheExpiryInputs = {
	model: Model<Api>;
	/** Pi's effective `cacheWarming` mode. */
	warmingMode: string;
	/** When this process loaded pi-keep-cache-warm's tool; null when it is not loaded. Older entries are ignored. */
	keepCacheWarmSince: number | null;
};

/** When the session's prompt cache is really gone, or null when Pi knows no cache lifetime for the model or nothing cached yet.
 * A compaction or branch summary starts over: the next request misses anyway.
 */
function cacheExpiresAt(branch: readonly SessionEntry[], { model, warmingMode, keepCacheWarmSince }: CacheExpiryInputs): number | null {
	const lifetimeMs = promptCacheTtlMs(model);
	if (lifetimeMs === undefined) return null;
	const isCurrentModel = (provider: string, id: string) => provider === model.provider && id === model.id;
	let lastTouch: number | undefined;
	let lastRequest: { at: number; promptTokens: number } | undefined;
	let keepWarmDeadline: number | undefined;
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			lastTouch = lastRequest = keepWarmDeadline = undefined;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const { input, cacheRead, cacheWrite } = message.usage;
			// Pi warms only the last request, and only for the selected model.
			lastRequest = isCurrentModel(message.provider, message.model) ? { at: message.timestamp, promptTokens: input + cacheRead + cacheWrite } : undefined;
			if (lastRequest) lastTouch = message.timestamp;
		} else if (entry.type === "usage" && entry.kind === "cache_warm" && isCurrentModel(entry.provider, entry.model)) {
			lastTouch = Date.parse(entry.timestamp);
		} else if (entry.type === "custom" && entry.customType === KEEP_CACHE_WARM_ENTRY && keepCacheWarmSince !== null && Date.parse(entry.timestamp) >= keepCacheWarmSince) {
			const data = entry.data as KeepCacheWarmData;
			if (data.kind === "arm") keepWarmDeadline = Date.parse(data.deadline);
			if (data.kind === "stop") keepWarmDeadline = undefined;
			if (data.kind === "warm" && isCurrentModel(data.provider, data.model)) lastTouch = Date.parse(entry.timestamp);
		}
	}
	if (lastTouch === undefined) return null;
	return Math.max(lastTouch + lifetimeMs, keepWarmDeadline ?? 0, piIdleHorizon(model, warmingMode, lifetimeMs, lastRequest) ?? 0);
}

/** When Pi's own idle warming lets the cache go: the last refresh inside Pi's idle limit after the last request, plus the lifetime.
 * Null when Pi will not refresh this context: no exported policy, a mode other than "idle", or Pi's cost rule says stop.
 */
function piIdleHorizon(model: Model<Api>, warmingMode: string, lifetimeMs: number, lastRequest: { at: number; promptTokens: number } | undefined): number | null {
	const { evaluateCacheWarming, getCacheWarmingDelayMs, CACHE_WARMING_MAX_IDLE_AGE_MS } = piWarming;
	if (!lastRequest || warmingMode !== "idle" || !evaluateCacheWarming || !getCacheWarmingDelayMs || CACHE_WARMING_MAX_IDLE_AGE_MS === undefined) return null;
	const delayMs = getCacheWarmingDelayMs(lifetimeMs);
	if (delayMs === undefined || evaluateCacheWarming(model, lastRequest.promptTokens, "idle").action !== "warm") return null;
	return lastRequest.at + Math.floor(CACHE_WARMING_MAX_IDLE_AGE_MS / delayMs) * delayMs + lifetimeMs;
}

/** Time left, in the shortest clear form, rounded up so a live cache never reads 0m.
 * @example
 * [formatTimeLeft(26 * 60_000), formatTimeLeft(30_000), formatTimeLeft(65 * 60_000), formatTimeLeft(120 * 60_000)] // ["26m", "1m", "1h5m", "2h"]
 */
function formatTimeLeft(milliseconds: number): string {
	const minutes = Math.ceil(milliseconds / MINUTE_MS);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

interface SessionStats {
	totalCost: number;
	totalReused: number;
	totalFresh: number;
	sessionCacheHitRate: number | null;
	latestCacheHitRate: number | null;
	latestCacheMiss: CacheMiss | null;
	averageCostPerTurn: number;
	lastContextTokens: number; // input+output+cacheRead+cacheWrite of the last valid turn
}

/** Exported for tests/miss-parity.mjs, which compares the mirrored miss detection with Pi's. */
export function getSessionStats(branch: readonly SessionEntry[], models: ModelLookup): SessionStats {
	let turnCount = 0;
	let totalCost = 0;
	let turnCost = 0;
	let totalReused = 0;
	let totalFresh = 0;
	let lastContextTokens = 0;
	let previousRequest: PreviousRequest | undefined;
	let cacheWasReported = false;
	let latestCacheHitRate: number | null = null;
	let latestCacheMiss: CacheMiss | null = null;
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			previousRequest = undefined;
			cacheWasReported = false;
			continue;
		}
		// Like Pi's footer, count usage entries (cache warms) in the totals only: they are not turns.
		if (entry.type === "usage") {
			const { input, cacheRead, cacheWrite, cost } = entry.usage;
			totalCost += cost.total;
			totalReused += cacheRead;
			totalFresh += input + cacheWrite;
			// Like pi's miss detection, the next turn's miss and idle gap count from a cache warm.
			const warmPromptTokens = input + cacheRead + cacheWrite;
			if (entry.kind === "cache_warm" && warmPromptTokens > 0) {
				previousRequest = {
					promptTokens: warmPromptTokens, modelKey: `${entry.provider}/${entry.model}`, timestamp: Date.parse(entry.timestamp), reportedCache: true,
				};
			}
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const { input, output, cacheRead, cacheWrite, cost } = message.usage;
		const promptTokens = input + cacheRead + cacheWrite;
		turnCount += 1;
		turnCost += cost.total;
		totalCost += cost.total;
		totalReused += cacheRead;
		totalFresh += input + cacheWrite;
		lastContextTokens = promptTokens + output;
		if (promptTokens <= 0) continue;

		const cacheReported = cacheRead + cacheWrite > 0;
		const cacheKnowledgeAvailable = cacheReported || cacheWasReported;
		latestCacheHitRate = cacheKnowledgeAvailable ? (cacheRead / promptTokens) * 100 : null;
		latestCacheMiss = detectCacheMiss(previousRequest, message, models);
		previousRequest = {
			promptTokens, modelKey: `${message.provider}/${message.model}`, timestamp: message.timestamp,
			reportedCache: (previousRequest?.reportedCache ?? false) || cacheReported,
		};
		cacheWasReported ||= cacheReported;
	}
	const totalPrompt = totalReused + totalFresh;
	return {
		totalCost,
		totalReused,
		totalFresh,
		sessionCacheHitRate: totalPrompt > 0 ? (totalReused / totalPrompt) * 100 : null,
		latestCacheHitRate,
		latestCacheMiss,
		averageCostPerTurn: turnCount > 0 ? turnCost / turnCount : 0,
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
	pace: Pace | null;
	cacheExpiresAt: number | null;
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const loadedAt = Date.now();
	// Redraws the footer once a minute, so the cache's time left stays live without session events.
	let minuteTimer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: any = null;
	let tuiRef: any = null;
	let gitBranch: string | null = null;
	let gitDirty = false;
	let thinkingLevel = "off";
	let loadedSkills: Array<{ name: string; tokenAge: number | null }> = [];
	const runningNestedSkillReads = new Set<string>();
	let skillsDirty = true;
	let skillContextChangeId: string | undefined;
	let snapshot: FooterSnapshot | undefined;

	// ── Rendering ────────────────────────────────────────────────────────

	function refreshLoadedSkills(ctx: ExtensionContext, branch: readonly SessionEntry[], currentContextTokens: number | null): void {
		loadedSkills = getLoadedSkills(
			ctx.sessionManager.buildSessionProjection().entries,
			getSkillLocations(pi),
			ctx.cwd,
			nestedSkillReadTexts(branch),
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
		const branch = manager.getBranch();
		const stats = getSessionStats(branch, currentCtx.modelRegistry);
		const usage = currentCtx.getContextUsage();
		// Boundary edits commit after turn_end, which may already have rendered the old projection.
		const contextChangeId = branch.reduce<string | undefined>((latest, entry) =>
			entry.type === "context_edit" || entry.type === "compaction" ? entry.id : latest, undefined);
		if (skillsDirty || contextChangeId !== skillContextChangeId) refreshLoadedSkills(currentCtx, branch, usage?.tokens ?? null);
		skillContextChangeId = contextChangeId;
		skillsDirty = false;
		snapshot = {
			manager, sessionId, leafId, model, stats,
			context: getContextPercent(currentCtx, stats.lastContextTokens, usage),
			session: getDisplaySession(currentCtx, currentCtx.cwd || ".", pi),
			pace: readPace(model, Date.now()),
			// Read Pi's settings and tools only for a model with a known cache lifetime.
			cacheExpiresAt: model && promptCacheTtlMs(model) !== undefined ? cacheExpiresAt(branch, {
				model,
				// Pi's own default for the setting, which changed to "idle" in Pi 1.5.1.
				warmingMode: SettingsManager.inMemory(pi.getSettings()).getCacheWarmingMode(),
				keepCacheWarmSince: pi.getAllTools().some((tool) => tool.name === KEEP_CACHE_WARM_TOOL) ? loadedAt : null,
			}) : null,
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
		const skillParts = (layout: SkillLayout) => loadedSkills.map(({ name, tokenAge }) => {
			const nameText = paint.token(SKILL_TOKEN, middleTruncate(name, layout.maxNameLength));
			const ageText = layout.ages && tokenAge !== null ? theme.fg("dim", ` -${formatTokens(tokenAge)}`) : "";
			return `${nameText}${ageText}`;
		});
		const renderSkillLines = (parts: string[], layout: SkillLayout) => wrapJoinedLines(parts, width, theme.fg("dim", layout.separator));
		// Take the fullest layout that fits the row limit. Hiding skills behind a
		// count is the last resort, after the most compact layout. The count ends
		// the last row, so even a one-row limit still names some skills.
		const maximumSkillRows = Math.max(MINIMUM_SKILL_ROWS, Math.floor((terminalHeight - TERMINAL_ROWS_BEFORE_SKILL_ROWS) / TERMINAL_ROWS_PER_SKILL_ROW));
		const layouts = skillLayouts(Math.max(0, ...loadedSkills.map(({ name }) => name.length)));
		const layout = layouts.find((candidate) => renderSkillLines(skillParts(candidate), candidate).length <= maximumSkillRows) ?? layouts.at(-1)!;
		const parts = skillParts(layout);
		const partsHiding = (hiddenCount: number) => hiddenCount === 0
			? parts
			: [...parts.slice(0, parts.length - hiddenCount), theme.fg("dim", `+${hiddenCount}`)];
		const hiddenSkillCount = Array.from({ length: parts.length + 1 }, (_, count) => count)
			.find((count) => renderSkillLines(partsHiding(count), layout).length <= maximumSkillRows)!;
		return [
			...fitFacts(headerFacts, HEADER_LADDER, width, theme),
			...renderSkillLines(partsHiding(hiddenSkillCount), layout),
		];
	}

	function renderBelow(width: number, theme: any): string[] {
		if (!currentCtx) return [];
		const { stats, context: { pct, window, tokens }, pace, cacheExpiresAt: expiresAt } = getSnapshot();
		const paint = makePainter(theme);
		const label = (text: string) => theme.fg("dim", `${text} `);
		const pill = (text: string) => theme.bg("selectedBg", paint.token(PLACE_TOKEN, theme.bold(text)));
		const directory = currentDirectoryName(currentCtx.cwd || ".");
		// A dirty worktree is a property of the place, not a cost, so it stays in
		// the place family and leaves `warning` meaning spend alone.
		const dirty = gitDirty ? paint.token(PLACE_TOKEN, "*") : "";
		const gauge = paint.ramp(CONTEXT_STOPS, pct, `${ctxGauge(pct)}${Math.round(pct)}%`);
		// Colour the figure that moves and leave its reference quiet, so the eye
		// lands on the reading rather than on the window size beside it.
		const usedTokens = paint.ramp(CONTEXT_STOPS, pct, formatTokens(tokens));
		const usingSubscription = currentCtx.model
			? currentCtx.modelRegistry?.isUsingOAuth?.(currentCtx.model)
			: false;
		const cost = (maxPlaces: number) => paint.token(SPEND_TOKEN, `$${formatDecimal(stats.totalCost, maxPlaces)}`);
		const sub = usingSubscription ? theme.fg("muted", " sub") : "";
		// A hit rate is a measurement, so it rides the ramp. The old cliff at 80%
		// made 79% and 20% look identical and threw the reading away.
		const sessionHit = stats.sessionCacheHitRate;
		const sessionHitText = sessionHit != null
			? paint.ramp(CACHE_STOPS, sessionHit, `${formatDecimal(sessionHit, 1)}% session`)
			: theme.fg("dim", "no cache yet");
		// The last message is a hit or a miss by its cache share alone. A miss that pi's accounting
		// also detects shows its cost and cause instead of the share.
		const latestHit = stats.latestCacheHitRate;
		const isHit = latestHit != null && latestHit > CACHE_HIT_ABOVE_PERCENT;
		const missForms = !isHit && stats.latestCacheMiss ? cacheMissForms(stats.latestCacheMiss) : null;
		const paceForms = (reading: Pace): FactForms => {
			const dim = (text: string) => theme.fg("dim", text);
			const burnHeat = (text: string) => paint.ramp(PACE_STOPS, pacePosition(reading.burn, false), text);
			const burn = burnHeat(`${formatDecimal(reading.burn)}×`);
			const target = paint.ramp(PACE_STOPS, pacePosition(reading.target, true), `${formatDecimal(reading.target)}×`);
			// The sign carries the verdict, and colour repeats it.
			const sign = reading.burn > reading.target ? theme.fg("error", ">") : dim("≤");
			const resets = formatRemaining(reading.resetsInMs);
			// A stale reading keeps showing, with its age until "brief", the form without it.
			const age = reading.ageMs > PACE_STALE_AFTER_MS ? dim(` · ${formatRemaining(reading.ageMs)} old`) : "";
			return {
				full: `${label("burn")}${paceBar(reading.used, reading.elapsed, burnHeat, dim)} ${burn} ${sign} ${label("target")}${target}${dim(` · resets in ${resets}`)}${age}`,
				short: `${label("burn")}${burn} ${sign} ${label("target")}${target}${dim(` · ${resets}`)}${age}`,
				brief: `${label("burn")}${burn} ${sign} ${label("target")}${target}${dim(` · ${resets}`)}`,
				bare: `${sign} ${label("target")}${target}`,
				least: `${sign} ${target}`,
			};
		};
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
			cost: { full: `${cost(2)}${sub}`, short: `${cost(1)}${sub}`, bare: `${cost(0)}${sub}`, least: cost(0) },
			perTurn: { full: paint.quiet(SPEND_TOKEN, `$${formatDecimal(stats.averageCostPerTurn)}/turn`) },
			cacheSession: { full: `${label("cache")}${sessionHitText}`, bare: sessionHitText },
			// "brief" is the step where a plain hit or miss hides; a detected miss stays to the end.
			latest: missForms
				? { full: theme.fg("error", missForms.full), short: theme.fg("error", missForms.short), brief: theme.fg("error", missForms.short), bare: theme.fg("error", missForms.bare) }
				: latestHit != null
					? {
						full: paint.ramp(CACHE_STOPS, latestHit, `${isHit ? "hit" : "miss"} ${Math.round(latestHit)}%`),
						short: paint.ramp(CACHE_STOPS, latestHit, isHit ? "hit" : "miss"),
						brief: "",
						bare: "",
					}
					: undefined,
			reuse: {
				full: paint.ramp(CACHE_STOPS, sessionHit ?? 0, formatTokens(stats.totalReused)) +
					theme.fg("dim", ` reused / ${formatTokens(stats.totalFresh)} new`),
			},
			// Once the time has passed the fact hides: there is nothing left to hurry back for,
			// and the next request's miss shows what it cost.
			expiry: expiresAt !== null && expiresAt > Date.now()
				? {
					full: `${label("warm for")}${theme.fg("muted", formatTimeLeft(expiresAt - Date.now()))}`,
					short: theme.fg("muted", formatTimeLeft(expiresAt - Date.now())),
				}
				: undefined,
			pace: pace ? paceForms(pace) : undefined,
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
		clearInterval(minuteTimer);
		minuteTimer = setInterval(requestRender, MINUTE_MS);
		minuteTimer.unref();
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
		clearInterval(minuteTimer);
		minuteTimer = undefined;
		currentCtx = null;
		tuiRef = null;
		gitBranch = null;
		gitDirty = false;
		loadedSkills = [];
		runningNestedSkillReads.clear();
		snapshot = undefined;
		skillsDirty = true;
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (isNestedSkillRead(event, getSkillLocations(pi), ctx.cwd)) runningNestedSkillReads.add(event.toolCallId);
	});
	pi.on("tool_execution_end", async (event) => {
		if (!runningNestedSkillReads.delete(event.toolCallId)) return;
		const readText = nestedReadText(event);
		if (readText !== null) pi.appendEntry<NestedSkillRead>(NESTED_SKILL_READ_ENTRY, { toolCallId: event.toolCallId, text: readText });
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
