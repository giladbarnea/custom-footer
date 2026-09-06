/** Show session context, cache usage, cost, and loaded skills around the editor. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { getLoadedSkills, type SkillLocation } from "./skill-tracker.ts";

// ── Layout constants ────────────────────────────────────────────────────────

const NARROW_WIDTH = 56;
const NARROW_SEPARATOR = " ";
const WIDE_SEPARATOR = " · ";
const CONTEXT_GAUGE_SYMBOLS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const CONTEXT_GAUGE_STEP_COUNT = CONTEXT_GAUGE_SYMBOLS.length;
const CONTEXT_MUTED_THRESHOLD = 40;
const CONTEXT_WARNING_THRESHOLD = 65;
const CONTEXT_ERROR_THRESHOLD = 85;
const CACHE_MISS_NOISE_FLOOR_TOKENS = 1_024;
const ANSI_RESET = "\x1b[0m";

const THINKING_LEVELS: Record<string, { full: string; short: string; token: string }> = {
	off: { full: "off", short: "o", token: "dim" },
	minimal: { full: "min", short: "mn", token: "thinkingMinimal" },
	low: { full: "low", short: "l", token: "thinkingLow" },
	medium: { full: "med", short: "md", token: "thinkingMedium" },
	high: { full: "high", short: "h", token: "thinkingHigh" },
	xhigh: { full: "xhigh", short: "x", token: "thinkingXhigh" },
	max: { full: "max", short: "mx", token: "thinkingMax" },
};

// ── Generic helpers ─────────────────────────────────────────────────────────

function isNarrow(width: number): boolean {
	return width <= NARROW_WIDTH;
}

function joinedLine(parts: string[], separator: string): string {
	return ` ${parts.join(separator)}`;
}

function wrapJoinedLines(parts: string[], width: number, separator: string): string[] {
	if (parts.length === 0) return [];
	const lines: string[] = [];
	const remainingParts = [...parts];
	while (remainingParts.length > 0) {
		const lineParts: string[] = [];
		while (remainingParts.length > 0) {
			const candidateLine = joinedLine([...lineParts, remainingParts[0]!], separator);
			if (lineParts.length > 0 && visibleWidth(candidateLine) >= width) break;
			lineParts.push(remainingParts.shift()!);
			if (visibleWidth(joinedLine(lineParts, separator)) >= width) break;
		}
		lines.push(truncateToWidth(joinedLine(lineParts, separator), width));
	}
	return lines;
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

type DisplaySessionPart = { text: string; token: "text" | "dim" };

function getDisplaySessionParts(ctx: any, cwd: string, pi: ExtensionAPI): DisplaySessionPart[] {
	const customName = pi.getSessionName?.() || null;
	const sessionId = ctx.sessionManager?.getSessionId?.() || null;
	if (!customName) return sessionId ? [{ text: sessionId, token: "dim" }] : [];
	const displayName = trimSessionPrefix(customName, cwd);
	const namePart = { text: displayName, token: "text" } as const;
	const idPart = sessionId ? [{ text: sessionId, token: "dim" } as const] : [];
	return [namePart, ...idPart];
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
type RgbTokens = { dim: RgbColor | null; muted: RgbColor | null; warning: RgbColor | null; error: RgbColor | null };

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
	const themed = theme.fg(token, "x");
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
	return `\x1b[38;2;${rgb.red};${rgb.green};${rgb.blue}m${text}${ANSI_RESET}`;
}

function renderContextUsage(
	theme: any,
	pct: number,
	text: string,
	rgbTokens: RgbTokens,
): string {
	const { dim, muted, warning, error } = rgbTokens;
	if (!dim || !muted || !warning || !error) {
		if (pct >= CONTEXT_ERROR_THRESHOLD) return theme.fg("error", text);
		if (pct >= CONTEXT_WARNING_THRESHOLD) return theme.fg("warning", text);
		if (pct >= CONTEXT_MUTED_THRESHOLD) return theme.fg("muted", text);
		return theme.fg("dim", text);
	}
	if (pct < CONTEXT_MUTED_THRESHOLD) {
		return colorizeRgb(text, blendRgb(dim, muted, pct / CONTEXT_MUTED_THRESHOLD));
	}
	if (pct < CONTEXT_WARNING_THRESHOLD) {
		return colorizeRgb(
			text,
			blendRgb(muted, warning, (pct - CONTEXT_MUTED_THRESHOLD) / (CONTEXT_WARNING_THRESHOLD - CONTEXT_MUTED_THRESHOLD)),
		);
	}
	if (pct < CONTEXT_ERROR_THRESHOLD) {
		return colorizeRgb(
			text,
			blendRgb(warning, error, (pct - CONTEXT_WARNING_THRESHOLD) / (CONTEXT_ERROR_THRESHOLD - CONTEXT_WARNING_THRESHOLD)),
		);
	}
	return theme.fg("error", text);
}

function ctxGauge(pct: number): string {
	const stepIndex = Math.min(
		Math.floor(pct / (100 / CONTEXT_GAUGE_STEP_COUNT)),
		CONTEXT_GAUGE_STEP_COUNT - 1,
	);
	return CONTEXT_GAUGE_SYMBOLS[stepIndex]!;
}

function renderThinkingLabel(theme: any, level: string, full: boolean): string | null {
	if (!level) return null;
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
	sessionParts: DisplaySessionPart[];
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
			sessionParts: getDisplaySessionParts(currentCtx, currentCtx.cwd || ".", pi),
		};
		return snapshot;
	}

	function renderAbove(width: number, theme: any): string[] {
		if (!currentCtx) return [];
		const model = formatModel(currentCtx.model);
		const thinking = renderThinkingLabel(theme, thinkingLevel, true);
		const sessionParts = getSnapshot().sessionParts.map((part) => theme.fg(part.token, part.text));
		const skillPills = loadedSkills.map(({ name, tokenAge }) => {
			const nameText = theme.fg("mdHeading", ` ${name}`);
			const ageText = tokenAge === null ? "" : theme.fg("muted", ` -${formatTokens(tokenAge)}`);
			return theme.bg("toolPendingBg", `${nameText}${ageText} `);
		});
		const parts = [theme.fg("accent", theme.bold(model))];
		if (thinking) parts.push(thinking);
		parts.push(...sessionParts);
		const separator = theme.fg("dim", WIDE_SEPARATOR);
		return [
			...wrapJoinedLines(parts, width, separator),
			...wrapJoinedLines(skillPills, width, separator),
		];
	}

	function renderBelow(width: number, theme: any): string[] {
		if (!currentCtx) return [];
		const { stats, context: { pct, window, tokens } } = getSnapshot();
		const rgbTokens: RgbTokens = {
			dim: getThemeTokenRgb(theme, "dim"),
			muted: getThemeTokenRgb(theme, "muted"),
			warning: getThemeTokenRgb(theme, "warning"),
			error: getThemeTokenRgb(theme, "error"),
		};
		return isNarrow(width)
			? renderFooterNarrow(width, theme, stats, pct, window, rgbTokens)
			: renderFooterWide(width, theme, stats, pct, window, tokens, rgbTokens);
	}

	function renderFooterWide(
		width: number,
		theme: any,
		stats: SessionStats,
		pct: number,
		window: number,
		tokens: number,
		rgbTokens: RgbTokens,
	): string[] {
		const separator = theme.fg("dim", WIDE_SEPARATOR);
		const label = (text: string) => theme.fg("dim", text.padEnd(8));
		const cwd = currentCtx.cwd || ".";

		const locationParts: string[] = [];
		if (gitBranch) {
			const dirty = gitDirty ? theme.fg("warning", "*") : "";
			locationParts.push(`${theme.fg("accent", ` ${gitBranch}`)}${dirty}`);
		}
		locationParts.push(theme.bg("selectedBg", theme.fg("text", ` ${currentDirectoryName(cwd)}/ `)));
		const locationLine = truncateToWidth(` ${locationParts.join(separator)}`, width);

		const gauge = renderContextUsage(theme, pct, `${ctxGauge(pct)} ${Math.round(pct)}%`, rgbTokens);
		const contextValue = theme.fg("text", `${formatTokens(tokens)} / ${formatTokens(window)} tokens`);
		const usingSubscription = currentCtx.model
			? currentCtx.modelRegistry?.isUsingOAuth?.(currentCtx.model)
			: false;
		const costText = theme.fg("warning", `$${formatCost(stats.totalCost)}`);
		const subLabel = usingSubscription ? theme.fg("muted", " sub") : "";
		const perTurn = theme.fg("dim", `$${formatCost(stats.averageCostPerTurn)}/turn`);
		const contextLine = truncateToWidth(
			` ${label("context")}${gauge}  ${contextValue}${separator}${costText}${subLabel}  ${perTurn}`,
			width,
		);

		const sessionHit = stats.sessionCacheHitRate;
		const sessionHitToken = sessionHit != null && sessionHit >= 80 ? "success" : "muted";
		const sessionHitText = sessionHit != null ? `${sessionHit.toFixed(1)}% session` : "no cache yet";
		const latestHit = stats.latestCacheHitRate;
		const latestText = stats.latestCacheMissTokens != null
			? theme.fg("warning", `latest miss ${formatTokens(stats.latestCacheMissTokens)} re-billed`)
			: latestHit != null
				? theme.fg(latestHit >= 80 ? "success" : "muted", `latest ${latestHit.toFixed(1)}%`)
				: null;
		const reuseSplit = theme.fg("dim", `${formatTokens(stats.totalReused)} reused / ${formatTokens(stats.totalFresh)} new`);
		const cacheParts = [theme.fg(sessionHitToken, sessionHitText), latestText, reuseSplit].filter(Boolean);
		const cacheLine = truncateToWidth(` ${label("cache")}${cacheParts.join(separator)}`, width);

		return [locationLine, contextLine, cacheLine];
	}

	function renderFooterNarrow(
		width: number,
		theme: any,
		stats: SessionStats,
		pct: number,
		window: number,
		rgbTokens: RgbTokens,
	): string[] {
		const cwd = currentCtx.cwd || ".";
		const locationParts: string[] = [];
		if (gitBranch) {
			const dirty = gitDirty ? theme.fg("warning", "*") : "";
			locationParts.push(`${theme.fg("accent", gitBranch)}${dirty}`);
		}
		locationParts.push(theme.fg("text", `${currentDirectoryName(cwd)}/`));
		const locationLine = truncateToWidth(` ${locationParts.join(NARROW_SEPARATOR)}`, width);

		const gauge = renderContextUsage(theme, pct, `${Math.round(pct)}%/${formatTokens(window)}`, rgbTokens);
		const latestHit = stats.latestCacheHitRate;
		const cache = stats.latestCacheMissTokens != null
			? theme.fg("warning", `miss ${formatTokens(stats.latestCacheMissTokens)}`)
			: latestHit != null
				? theme.fg("muted", `latest ${Math.round(latestHit)}%`)
				: "";
		const cost = theme.fg("warning", `$${formatCost(stats.totalCost)}`);
		const dataLine = truncateToWidth(` ${[gauge, cache, cost].filter(Boolean).join(NARROW_SEPARATOR)}`, width);

		return [locationLine, dataLine];
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
			(_tui: any, theme: any) => ({
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					return renderAbove(width, theme);
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
