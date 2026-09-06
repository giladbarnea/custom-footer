import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const directory = await mkdtemp(join(tmpdir(), "pi-custom-footer-load-"));
try {
  const result = await discoverAndLoadExtensions(
    [fileURLToPath(new URL("../index.ts", import.meta.url))],
    directory,
    directory,
  );
  assert.deepEqual(result.errors, [], "Pi must load Custom Footer without errors");
  assert.equal(result.extensions.length, 1, "Only Custom Footer should load in the isolated directory");
  console.log("custom-footer Pi loader regression ok");
} finally {
  await rm(directory, { recursive: true, force: true });
}
