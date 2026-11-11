#!/usr/bin/env node
// The footer mirrors Pi's miss detection (detectMiss in dist/core/cache-stats.js),
// which Pi does not export. This differential test runs both on the same generated
// sessions, so a Pi release that changes its miss accounting fails `npm test`.
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getSessionStats } = await jiti.import("../index.ts");
const { collectCacheMisses } = await import(new URL("core/cache-stats.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

/** Deterministic PRNG (mulberry32), so a failure reproduces from its session number. */
function random(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const minute = 60_000;
const pricesPerToken = { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 };
const listCacheReadPerMillion = { "model-1": 0.3, "model-2": 0.5 };
const models = {
	find: (_provider, model) => ({ cost: { cacheRead: listCacheReadPerMillion[model] } }),
	getModel: (_provider, model) => ({ cost: { cacheRead: listCacheReadPerMillion[model] } }),
};

// A session without caching reports no cache reads or writes, and Pi counts no miss for it.
// A caching session sometimes sends a turn with no cache activity, which Pi counts as a total miss.
function usage(next, priced, caching, promptTokens) {
	const cached = caching && next() < 0.9;
	const readShare = cached ? [0, 1, next()][Math.floor(next() * 3)] : 0;
	const cacheRead = Math.round(promptTokens * readShare);
	const cacheWrite = cached ? Math.round((promptTokens - cacheRead) * next()) : 0;
	const input = promptTokens - cacheRead - cacheWrite;
	const output = Math.round(next() * 5_000);
	const cost = Object.fromEntries(Object.entries({ input, output, cacheRead, cacheWrite })
		.map(([kind, tokens]) => [kind, priced ? tokens * pricesPerToken[kind] : 0]));
	return { input, output, cacheRead, cacheWrite, totalTokens: promptTokens + output, cost: { ...cost, total: Object.values(cost).reduce((sum, part) => sum + part, 0) } };
}

function session(seed) {
	const next = random(seed);
	const priced = next() < 0.8;
	const caching = next() < 0.85;
	const entries = [];
	let time = 0;
	let promptTokens = 2_000 + Math.round(next() * 50_000);
	for (let index = 0; index < 4 + Math.floor(next() * 10); index += 1) {
		time += Math.round(next() * 12 * minute);
		promptTokens += Math.round(next() * 20_000);
		const kind = next();
		const model = next() < 0.85 ? "model-1" : "model-2";
		if (kind < 0.08) entries.push({ type: "compaction" });
		else if (kind < 0.25) entries.push({ type: "usage", kind: "cache_warm", provider: "anthropic", model, timestamp: new Date(time).toISOString(), usage: usage(next, priced, caching, promptTokens) });
		else entries.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: [], provider: "anthropic", model, timestamp: time, usage: usage(next, priced, caching, promptTokens) } });
	}
	return entries;
}

const counts = { turns: 0, misses: 0, idle: 0, switched: 0, partial: 0, total: 0, priced: 0 };
for (let seed = 1; seed <= 400; seed += 1) {
	const entries = session(seed);
	const piMisses = collectCacheMisses(entries, models);
	entries.forEach((entry, index) => {
		if (entry.type !== "message") return;
		const expected = piMisses.get(entry.message) ?? null;
		counts.turns += 1;
		assert.deepEqual(getSessionStats(entries.slice(0, index + 1), models).latestCacheMiss, expected, `session ${seed}, entry ${index}`);
		if (!expected) return;
		counts.misses += 1;
		counts.idle += expected.idleMs >= 5 * minute ? 1 : 0;
		counts.switched += expected.modelChanged ? 1 : 0;
		counts.partial += entry.message.usage.cacheRead > 0 ? 1 : 0;
		counts.total += entry.message.usage.cacheRead + entry.message.usage.cacheWrite === 0 ? 1 : 0;
		counts.priced += expected.missedCost >= 0.01 ? 1 : 0;
	});
}
// The generator must reach every branch of the miss rules, or the comparison proves little.
for (const [kind, count] of Object.entries(counts)) assert.ok(count >= 20, `only ${count} ${kind} cases`);
console.log(`custom-footer miss parity ok (${JSON.stringify(counts)})`);
