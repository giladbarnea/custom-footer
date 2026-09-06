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

function expandedSkillNames(content: unknown): string[] {
	return [...textFromContent(content).matchAll(/<skill name="([^"]+)" location="[^"]+">/g)]
		.map((match) => match[1]!)
		.filter(isValidSkillName);
}

function readPaths(toolCall: UnknownRecord): string[] {
	if (!isRecord(toolCall.arguments)) return [];
	if (toolCall.name === "read" && typeof toolCall.arguments.path === "string") {
		return [toolCall.arguments.path];
	}
	if (toolCall.name !== "read_many_files" || !Array.isArray(toolCall.arguments.paths)) return [];
	return toolCall.arguments.paths.filter((path): path is string => typeof path === "string");
}

function skillNamesForReadPath(rawPath: string, skills: readonly SkillLocation[], cwd: string): string[] {
	const path = resolvePath(cwd, rawPath);
	return skills.flatMap((skill) => path === resolvePath(cwd, skill.filePath) ? [skill.name] : []);
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
 * Return skills in the effective model history with their first valid post-load prompt size.
 *
 * @example
 * getLoadedSkills([], [], "/workspace") // []
 */
export function getLoadedSkills(
	history: readonly unknown[],
	skills: readonly SkillLocation[],
	cwd: string,
): LoadedSkill[] {
	const compactionTimestamp = latestCompactionTimestamp(history);
	const loadedSkills = new Map<string, number | null>();
	const pendingBaselines = new Set<string>();
	const skillNamesByToolCall = new Map<string, string[]>();

	const markLoaded = (skillName: string) => {
		loadedSkills.set(skillName, null);
		pendingBaselines.add(skillName);
	};

	for (const message of history) {
		if (!isRecord(message)) continue;

		if (message.role === "user") {
			for (const skillName of expandedSkillNames(message.content)) markLoaded(skillName);
			continue;
		}

		if (message.role === "toolResult") {
			if (message.isError !== false || typeof message.toolCallId !== "string") continue;
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
