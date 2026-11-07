import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const customFooter = (await createJiti(import.meta.url).import("../index.ts")).default;
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };

async function fixture({ persisted = false } = {}) {
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
	let manager = persisted ? SessionManager.create(directory, join(directory, "sessions")) : SessionManager.inMemory(directory);
	let session;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
	let edits = [];
	let firstKeptEntryId;
	let header;
	let footer;
	const errors = [];
	const render = () => header.render(200).join("\n");
	const tui = { terminal: { rows: 60 }, requestRender() { header?.render(200); footer?.render(200); } };
	async function start() {
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			skillsOverride: () => ({ skills, diagnostics: [] }),
			extensionFactories: [
				customFooter,
				createCodemodeExtension({ models: false }),
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
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, model: faux.getModel(), thinkingLevel: "off",
			resourceLoader, settingsManager, sessionManager: manager, tools: ["read", "codemode"],
		}));
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
	}
	await start();
	return {
		get session() { return session; },
		get manager() { return manager; },
		faux, skills, render, errors,
		async reopen() {
			const sessionFile = manager.getSessionFile();
			session.dispose();
			manager = SessionManager.open(sessionFile);
			await start();
		},
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
		async runScript(code) {
			faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code })), fauxAssistantMessage("Script seen.")]);
			await session.prompt("Run the script.");
			assert.deepEqual(errors, []);
			return manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
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

test("a codemode script that prints a complete skill read loads that skill", async () => {
	const setup = await fixture();
	try {
		const [alpha] = setup.skills;
		const result = await setup.runScript(`text(await tools.read({ path: ${JSON.stringify(alpha.filePath)} }));`);
		assert.equal(result.message.toolName, "codemode");
		assert.equal(result.message.nestedCalls.calls[0].status, "ok");
		assert.match(setup.render(), /skill-alpha -\d/, "A skill whose complete text reached the model must be listed with its token age");
		assert.doesNotMatch(setup.render(), /skill-beta/);
		await setup.edit(result.id, "The script output was summarized.");
		assert.doesNotMatch(setup.render(), /skill-alpha/, "A replaced codemode result must no longer claim its skill");
		await setup.edit(result.id, result.message.content);
		assert.match(setup.render(), /skill-alpha/, "Restoring the codemode result must restore its skill");
		await writeFile(alpha.filePath, "Rewritten after the read.\n");
		setup.faux.setResponses([fauxAssistantMessage("Later.")]);
		await setup.session.prompt("Continue after the file changed.");
		assert.match(setup.render(), /skill-alpha/, "Changing the file on disk must not unload the text the model already received");
	} finally {
		await setup.dispose();
	}
});

test("a later script error does not unload a successful codemode skill read the model received", async () => {
	const setup = await fixture();
	try {
		const lateError = await setup.runScript(`text(await tools.read({ path: ${JSON.stringify(setup.skills[0].filePath)} })); throw new Error("Late failure.");`);
		assert.equal(lateError.message.isError, true);
		assert.match(setup.render(), /skill-alpha/, "A later script error must not unload a successful read the model received");
	} finally {
		await setup.dispose();
	}
});

test("editing only unrelated codemode output keeps the intact skill", async () => {
	const setup = await fixture();
	try {
		const beta = setup.skills[1];
		const diagnosed = await setup.runScript(`text("Diagnostic one."); text(await tools.read({ path: ${JSON.stringify(beta.filePath)} }));`);
		assert.match(setup.render(), /skill-beta/);
		const changedDiagnostic = diagnosed.message.content.map((block) => ({ ...block, text: block.text.replace("Diagnostic one.", "Changed.") }));
		assert.notDeepEqual(changedDiagnostic, diagnosed.message.content);
		await setup.edit(diagnosed.id, changedDiagnostic);
		assert.match(setup.render(), /skill-beta/, "Editing only unrelated script output must keep the intact skill");
	} finally {
		await setup.dispose();
	}
});

test("a codemode read truncated by the read tool counts like the same direct read", async () => {
	const setup = await fixture();
	try {
		const [alpha] = setup.skills;
		await writeFile(alpha.filePath, Array.from({ length: 2105 }, (_, index) => `Line ${index + 1}.`).join("\n"));
		const result = await setup.runScript(`text(await tools.read({ path: ${JSON.stringify(alpha.filePath)} }));`);
		const forwarded = result.message.content.map((block) => block.text).join("\n");
		assert.match(forwarded, /Showing lines 1-2000 of 2105/);
		assert.doesNotMatch(forwarded, /truncated output/, "Codemode itself must forward the whole read result");
		assert.match(setup.render(), /skill-alpha/, "A fully forwarded truncated read must count, as the direct read does");
	} finally {
		await setup.dispose();
	}
});

test("reopening a persisted session with a fresh footer keeps a delivered codemode skill and still drops it when its text leaves the context", async () => {
	const setup = await fixture({ persisted: true });
	try {
		const [alpha, beta] = setup.skills;
		const nested = await setup.runScript(`text("Diagnostic first."); text(await tools.read({ path: ${JSON.stringify(alpha.filePath)} }));`);
		setup.faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: beta.filePath })), fauxAssistantMessage("Loaded.")]);
		await setup.session.prompt("Load skill-beta directly.");
		assert.match(setup.render(), /skill-alpha/);
		assert.match(setup.render(), /skill-beta/);

		await setup.reopen();
		let received;
		setup.faux.setResponses([(context) => {
			received = context.messages.filter((message) => message.role === "toolResult").map((message) => message.content.map((block) => block.text).join("\n")).join("\n");
			return fauxAssistantMessage("Reopened.");
		}]);
		await setup.session.prompt("Continue after reopening.");
		assert.deepEqual(setup.errors, []);
		for (const name of ["skill-alpha", "skill-beta"]) assert.match(received, new RegExp(`Follow the complete ${name} instructions.`), `The reopened provider request must still carry ${name}`);
		assert.match(setup.render(), /skill-beta/, "The direct read stays listed after reopening");
		assert.match(setup.render(), /skill-alpha/, "A fresh footer instance must keep a delivered codemode skill the model still receives");

		await setup.edit(nested.id, "The script output was summarized.");
		assert.doesNotMatch(setup.render(), /skill-alpha/, "After reopening, recorded bookkeeping alone must not keep a skill whose text left the context");
		assert.match(setup.render(), /skill-beta/);
		await setup.edit(nested.id, nested.message.content);
		assert.match(setup.render(), /skill-alpha/, "Restoring the original result must restore the skill after reopening");
	} finally {
		await setup.dispose();
	}
});

test("reopening a persisted session does not load codemode skill reads that failed or were not delivered", async () => {
	const setup = await fixture({ persisted: true });
	try {
		const path = JSON.stringify(setup.skills[0].filePath);
		await setup.runScript(`await tools.read({ path: ${path} }); text("Discarded.");`);
		await setup.runScript(`text((await tools.read({ path: ${path} })).slice(0, 40));`);
		await setup.runScript(`try { await tools.read({ path: ${path}, offset: 9999 }); } catch (error) { text(String(error)); }`);
		await setup.reopen();
		setup.faux.setResponses([fauxAssistantMessage("Reopened.")]);
		await setup.session.prompt("Continue after reopening.");
		assert.doesNotMatch(setup.render(), /skill-alpha/, "Undelivered or failed codemode reads must stay unlisted after reopening");
	} finally {
		await setup.dispose();
	}
});

test("codemode skill reads that failed or whose result did not reach the model do not load it", async () => {
	const setup = await fixture();
	try {
		const path = JSON.stringify(setup.skills[0].filePath);
		for (const [code, status] of [
			[`await tools.read({ path: ${path} }); text("Discarded.");`, "ok"],
			[`text((await tools.read({ path: ${path} })).slice(0, 40));`, "ok"],
			[`// @options: {"max_output_tokens": 8}\ntext("x".repeat(200) + await tools.read({ path: ${path} }));`, "ok"],
			[`try { await tools.read({ path: ${path}, offset: 9999 }); } catch (error) { text(String(error)); }`, "error"],
		]) {
			const result = await setup.runScript(code);
			assert.equal(result.message.nestedCalls.calls[0].status, status, `Unexpected nested read status for: ${code}`);
			assert.doesNotMatch(setup.render(), /skill-alpha/, `A failed or undelivered codemode read must not load the skill: ${code}`);
		}
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
