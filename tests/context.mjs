import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const customFooter = (await createJiti(import.meta.url).import("../index.ts")).default;
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "footer-context-"));
	const skills = await Promise.all(["skill-alpha", "skill-beta"].map(async (name) => {
		const baseDir = join(directory, name);
		await mkdir(baseDir);
		const filePath = join(baseDir, "SKILL.md");
		const content = `---\nname: ${name}\ndescription: Fixture skill.\n---\nFollow the complete ${name} instructions.\n`;
		await writeFile(filePath, content);
		return { name, description: "Fixture skill.", filePath, baseDir, source: "test", disableModelInvocation: false };
	}));
	const faux = fauxProvider({ provider: "footer-test", models: [{ id: "local", contextWindow: 1_000_000 }], tokensPerSecond: 0 });
	const manager = SessionManager.inMemory(directory);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
	let edits = [];
	let firstKeptEntryId;
	let header;
	let footer;
	const errors = [];
	const render = () => header.render(200).join("\n");
	const tui = { terminal: { rows: 60 }, requestRender() { header?.render(200); footer?.render(200); } };
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		skillsOverride: () => ({ skills, diagnostics: [] }),
		extensionFactories: [
			customFooter,
			(pi) => {
				pi.registerProvider(faux.provider);
				pi.on("session_before_compact", (event) => ({
					compaction: { summary: "Earlier skills were summarized.", firstKeptEntryId, tokensBefore: event.preparation.tokensBefore },
				}));
				pi.on("turn_end", (event) => {
					const pending = edits;
					edits = [];
					return { entries: [...event.entries, ...pending] };
				});
			},
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, model: faux.getModel(), thinkingLevel: "off",
		resourceLoader, settingsManager, sessionManager: manager, tools: ["read"],
	});
	await session.bindExtensions({
		uiContext: {
			setFooter(factory) {
				footer = factory(tui, theme, { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() });
			},
			setWidget(_name, factory) { header = factory(tui, theme); },
			notify() {},
		},
		onError: (error) => errors.push(error),
	});
	return {
		session, manager, faux, skills, render, errors,
		async dispose() {
			session.dispose();
			await rm(directory, { recursive: true, force: true });
		},
		async compact(keptEntryId) {
			firstKeptEntryId = keptEntryId;
			await session.compact();
			assert.deepEqual(errors, []);
		},
		async edit(targetId, content) {
			await this.editMany([{ type: "context_edit", targetId, replacement: content === null ? null : { content } }]);
		},
		async editMany(entries, inspectNextRequest) {
			edits = entries;
			faux.setResponses(inspectNextRequest ? [
				fauxAssistantMessage(fauxToolCall("read", { path: skills[1].filePath })),
				(context) => {
					inspectNextRequest(context, render());
					return fauxAssistantMessage("Verified in the same run.");
				},
			] : [fauxAssistantMessage("Edited.")]);
			await session.prompt("Apply the queued context edit.");
			assert.deepEqual(errors, [], "The real Pi extension runtime must not report errors");
			const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
			assert.notEqual(lastAssistant.stopReason, "error", lastAssistant.errorMessage);
		},
		async load() {
			for (const { name, filePath } of skills) {
				faux.setResponses([
					fauxAssistantMessage(fauxToolCall("read", { path: filePath })),
					fauxAssistantMessage("Loaded."),
				]);
				await session.prompt(`Load ${name}.`);
			}
			assert.deepEqual(errors, []);
			assert.match(render(), /skill-alpha/);
			assert.match(render(), /skill-beta/);
		},
	};
}

test("compaction removes summarized skills while retaining verbatim skills", async () => {
	const setup = await fixture();
	try {
		await setup.load();
		const kept = setup.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content.some((block) => block.type === "text" && block.text === "Load skill-beta."));
		assert.ok(kept, "The second skill has its own user-message span");
		await setup.compact(kept.id);
		assert.doesNotMatch(setup.render(), /skill-alpha/, "A summarized read must no longer be listed");
		assert.match(setup.render(), /skill-beta/, "A retained read must still be listed");
		assert.ok(setup.manager.buildSessionProjection().messages.some((message) => message.role === "compactionSummary"));
		setup.faux.setResponses([(context) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 1, "Only the retained read reaches the provider");
			assert.match(results[0].content[0].text, /skill-beta/);
			return fauxAssistantMessage("Compacted.");
		}]);
		await setup.session.prompt("Continue after compaction.");
		assert.equal(setup.session.getLastAssistantText(), "Compacted.");
	} finally {
		await setup.dispose();
	}
});

test("a compaction committed at turn_end invalidates the already-rendered skill snapshot", async () => {
	const setup = await fixture();
	try {
		await setup.load();
		const kept = setup.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content.some((block) => block.type === "text" && block.text === "Load skill-beta."));
		await setup.editMany([{ type: "compaction", summary: "Summarized skill-alpha.", firstKeptEntryId: kept.id, tokensBefore: 1000 }]);
		assert.doesNotMatch(setup.render(), /skill-alpha/, "Committed boundary compaction must invalidate the pre-commit render");
		assert.match(setup.render(), /skill-beta/);
	} finally {
		await setup.dispose();
	}
});

test("omitting and restoring a native read exchange updates the footer", async () => {
	const setup = await fixture();
	try {
		await setup.load();
		const exchange = setup.manager.getBranch().filter((entry) => entry.type === "message" && (entry.message.role === "toolResult" || (entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall")))).slice(0, 2);
		assert.equal(exchange.length, 2);
		await setup.editMany(exchange.map((entry) => ({ type: "context_edit", targetId: entry.id, replacement: null })));
		assert.doesNotMatch(setup.render(), /skill-alpha/, "An omitted exchange must not be listed");
		assert.match(setup.render(), /skill-beta/);
		await setup.editMany(exchange.map((entry) => ({ type: "context_edit", targetId: entry.id, replacement: { content: entry.message.content } })));
		assert.match(setup.render(), /skill-alpha/, "A restored exchange must be listed again");
	} finally {
		await setup.dispose();
	}
});

test("editing an expanded skill body invalidates it even when its tags survive", async () => {
	const setup = await fixture();
	try {
		for (const { name } of setup.skills) {
			setup.faux.setResponses([fauxAssistantMessage("Loaded expansion.")]);
			await setup.session.prompt(`/skill:${name}`);
		}
		assert.match(setup.render(), /skill-alpha/);
		assert.match(setup.render(), /skill-beta/);
		const expanded = setup.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
		const originalText = expanded.message.content[0].text;
		const changed = originalText.replace("Follow the complete skill-alpha instructions.", "Short summary.");
		assert.notEqual(changed, originalText);
		await setup.edit(expanded.id, changed);
		assert.doesNotMatch(setup.render(), /skill-alpha/, "Tags alone do not prove that a skill remains verbatim");
		assert.match(setup.render(), /skill-beta/);
		await setup.edit(expanded.id, expanded.message.content);
		assert.match(setup.render(), /skill-alpha/);
		await setup.edit(expanded.id, `New introduction.\n${originalText}`);
		assert.match(setup.render(), /skill-alpha/, "Changing surrounding prose must not invalidate the intact expansion");
		await setup.edit(expanded.id, null);
		assert.doesNotMatch(setup.render(), /skill-alpha/);
	} finally {
		await setup.dispose();
	}
});

test("a native context edit replacing a successful read removes only that skill from the rendered footer", async () => {
	const setup = await fixture();
	try {
		await setup.load();
		const result = setup.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		await setup.editMany([{
			type: "context_edit", targetId: result.id,
			replacement: { content: "The skill was summarized, not retained verbatim." },
		}], (context, header) => {
			const projected = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === result.message.toolCallId);
			assert.deepEqual(projected.content, [{ type: "text", text: "The skill was summarized, not retained verbatim." }]);
			assert.doesNotMatch(header, /skill-alpha/, "The next provider request and footer must agree in the same run");
		});
		assert.equal(setup.session.getLastAssistantText(), "Verified in the same run.");
		assert.doesNotMatch(setup.render(), /skill-alpha/, "A read result replaced by a summary must no longer claim its skill is loaded");
		assert.match(setup.render(), /skill-beta/, "An untouched read must remain loaded");
		await setup.edit(result.id, result.message.content);
		assert.match(setup.render(), /skill-alpha/, "Restoring the original result must restore its skill");
		await setup.edit(result.id, [...result.message.content, { type: "text", text: "An added note." }]);
		assert.match(setup.render(), /skill-alpha/, "An edit that retains the entire read verbatim must keep its skill");
	} finally {
		await setup.dispose();
	}
});
