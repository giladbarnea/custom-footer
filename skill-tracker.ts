import type { ProjectedSessionEntry, SessionEntry, ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type SkillLocation = {
	filePath: string;
	name: string;
};

export type LoadedSkill = {
	loadedAtTokens: number | null;
	name: string;
};

/** A successful nested skill read's returned text, kept as a custom session entry because Pi does not persist nested results. */
export type NestedSkillRead = {
	toolCallId: string;
	text: string;
};

export const NESTED_SKILL_READ_ENTRY = "custom-footer-nested-skill-read";

type UnknownRecord = Record<string, unknown>;

const MAX_SKILL_NAME_LENGTH = 64;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function resolvePath(cwd: string, rawPath: string): string {
	const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	).join("\n");
}

function isValidSkillName(name: string): boolean {
	return name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(name);
}

function expandedSkillNames(content: unknown, originalContent: unknown): string[] {
	const text = textFromContent(content);
	return [...textFromContent(originalContent).matchAll(/<skill name="([^"]+)" location="[^"]+">[\s\S]*?<\/skill>/g)]
		.filter((match) => text.includes(match[0]))
		.map((match) => match[1]!)
		.filter(isValidSkillName);
}

function readPaths(toolCall: UnknownRecord): string[] {
	if (!isRecord(toolCall.arguments)) return [];
	if (toolCall.name === "read" && typeof toolCall.arguments.path === "string") {
		return [toolCall.arguments.path];
	}
	return [];
}

function skillNamesForReadPath(rawPath: string, skills: readonly SkillLocation[], cwd: string): string[] {
	const path = resolvePath(cwd, rawPath);
	return skills.flatMap((skill) => path === resolvePath(cwd, skill.filePath) ? [skill.name] : []);
}

/**
 * Whether a starting tool call is a nested skill read, such as one from a codemode script.
 *
 * @example
 * isNestedSkillRead({ type: "tool_execution_start", toolCallId: "c/1", toolName: "read", args: { path: "/s/SKILL.md" }, parentToolCallId: "c" }, [{ name: "s", filePath: "/s/SKILL.md" }], "/") // true
 */
export function isNestedSkillRead(event: ToolExecutionStartEvent, skills: readonly SkillLocation[], cwd: string): boolean {
	return event.parentToolCallId !== undefined && readPaths({ name: event.toolName, arguments: event.args })
		.some((path) => skillNamesForReadPath(path, skills, cwd).length > 0);
}

/**
 * The text a successful nested read returned to its caller, to match against the parent result later.
 *
 * @example
 * nestedReadText({ type: "tool_execution_end", toolCallId: "c/1", toolName: "read", result: { content: [{ type: "text", text: "Body." }] }, isError: false }) // "Body."
 */
export function nestedReadText(event: ToolExecutionEndEvent): string | null {
	return event.isError ? null : textFromContent(event.result?.content);
}

/**
 * Nested read texts recorded on a session branch, by nested tool call id.
 *
 * @example
 * nestedSkillReadTexts([]) // Map(0) {}
 */
export function nestedSkillReadTexts(branch: readonly SessionEntry[]): Map<string, string> {
	return new Map(branch.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== NESTED_SKILL_READ_ENTRY) return [];
		const { toolCallId, text } = entry.data as NestedSkillRead;
		return [[toolCallId, text]];
	}));
}

/** Skills whose nested read text, captured when the read succeeded, survives verbatim in the projected parent result. */
function deliveredNestedSkillNames(
	message: UnknownRecord,
	skills: readonly SkillLocation[],
	cwd: string,
	nestedReadTexts: ReadonlyMap<string, string>,
): string[] {
	if (!isRecord(message.nestedCalls) || !Array.isArray(message.nestedCalls.calls)) return [];
	const deliveredText = textFromContent(message.content);
	return message.nestedCalls.calls.filter(isRecord).flatMap((call) => {
		const readText = typeof call.id === "string" ? nestedReadTexts.get(call.id) : undefined;
		if (readText === undefined || !deliveredText.includes(readText)) return [];
		return readPaths(call).flatMap((path) => skillNamesForReadPath(path, skills, cwd));
	});
}

function assistantPromptTokens(message: UnknownRecord, compactionTimestamp: number | null): number | null {
	if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return null;
	if (compactionTimestamp !== null && (typeof message.timestamp !== "number" || message.timestamp <= compactionTimestamp)) return null;
	if (!isRecord(message.usage)) return null;
	const { input, cacheRead, cacheWrite } = message.usage;
	if (typeof input !== "number" || typeof cacheRead !== "number" || typeof cacheWrite !== "number") return null;
	const promptTokens = input + cacheRead + cacheWrite;
	return promptTokens > 0 ? promptTokens : null;
}

function latestCompactionTimestamp(history: readonly unknown[]): number | null {
	return history.reduce<number | null>((latest, message) => {
		if (!isRecord(message) || message.role !== "compactionSummary" || typeof message.timestamp !== "number") return latest;
		return latest === null ? message.timestamp : Math.max(latest, message.timestamp);
	}, null);
}

/**
 * Return skills whose loaded text survives verbatim in Pi's projection, with their first valid post-load prompt size.
 *
 * @example
 * getLoadedSkills([], [], "/workspace", new Map()) // []
 */
export function getLoadedSkills(
	entries: readonly ProjectedSessionEntry[],
	skills: readonly SkillLocation[],
	cwd: string,
	nestedReadTexts: ReadonlyMap<string, string>,
): LoadedSkill[] {
	const history: Array<{ message: unknown; originalContent: unknown }> = entries.flatMap(({ sourceEntry, messages }) => messages.map((message) => ({
		message,
		originalContent: sourceEntry.type === "message" && "content" in sourceEntry.message ? sourceEntry.message.content : undefined,
	})));
	const compactionTimestamp = latestCompactionTimestamp(history.map(({ message }) => message));
	const loadedSkills = new Map<string, number | null>();
	const pendingBaselines = new Set<string>();
	const skillNamesByToolCall = new Map<string, string[]>();

	const markLoaded = (skillName: string) => {
		loadedSkills.set(skillName, null);
		pendingBaselines.add(skillName);
	};

	for (const { message, originalContent } of history) {
		if (!isRecord(message)) continue;

		if (message.role === "user") {
			for (const skillName of expandedSkillNames(message.content, originalContent)) markLoaded(skillName);
			continue;
		}

		if (message.role === "toolResult") {
			for (const skillName of deliveredNestedSkillNames(message, skills, cwd, nestedReadTexts)) markLoaded(skillName);
			if (message.isError !== false || typeof message.toolCallId !== "string") continue;
			if (!textFromContent(message.content).includes(textFromContent(originalContent))) continue;
			for (const skillName of skillNamesByToolCall.get(message.toolCallId) ?? []) markLoaded(skillName);
			continue;
		}

		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const promptTokens = assistantPromptTokens(message, compactionTimestamp);
		if (promptTokens !== null) {
			for (const skillName of pendingBaselines) loadedSkills.set(skillName, promptTokens);
			pendingBaselines.clear();
		}

		for (const toolCall of message.content.filter(isRecord)) {
			if (toolCall.type !== "toolCall" || typeof toolCall.id !== "string") continue;
			const skillNames = readPaths(toolCall).flatMap((path) => skillNamesForReadPath(path, skills, cwd));
			if (skillNames.length > 0) skillNamesByToolCall.set(toolCall.id, [...new Set(skillNames)]);
		}
	}

	return [...loadedSkills].map(([name, loadedAtTokens]) => ({ name, loadedAtTokens }));
}
