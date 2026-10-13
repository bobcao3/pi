import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const durableName = "@earendil-works/pi-durable";

export function smokeTestDurable(directory, runtime = process.execPath) {
	const entry = join(directory, "durable-smoke.mjs");
	try {
		writeFileSync(entry, `import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "${durableName}";
import { MemoryStorage as SubpathMemoryStorage } from "${durableName}/storage/memory";
import { NodeExecutionEnv } from "${durableName}/env/node";
import { createNodePhotonImages } from "${durableName}/images/node";
import { openNodeJsonlStorage } from "${durableName}/storage/jsonl/node";
import { NodeSqliteDatabase, openNodeSqliteDatabase, openNodeSqliteStorage } from "${durableName}/storage/sqlite/node";
assert.equal(MemoryStorage, SubpathMemoryStorage);
for (const exported of [NodeExecutionEnv, createNodePhotonImages, openNodeJsonlStorage,
  NodeSqliteDatabase, openNodeSqliteDatabase, openNodeSqliteStorage]) {
  assert.equal(typeof exported, "function");
}
const storage = new MemoryStorage();
try {
  const id = await storage.mintId();
  assert(Number.isSafeInteger(id) && id > 0);
  assert.equal(await storage.conversation(id, BACKGROUND_CONTEXT), undefined);
  const record = { id };
  const sequence = await storage.commit([{ type: "conversation", value: record }], BACKGROUND_CONTEXT);
  assert(Number.isSafeInteger(sequence) && sequence > 0);
  assert.deepEqual(await storage.conversation(id, BACKGROUND_CONTEXT), record);
} finally {
  await storage.close(BACKGROUND_CONTEXT);
}
await assert.rejects(storage.mintId());
`);
		execFileSync(runtime, [entry], { cwd: directory, stdio: "inherit", timeout: 30_000 });
	} finally {
		rmSync(entry, { force: true });
	}
	console.log(`Durable packaged storage smoke tests passed (${runtime}).`);
}
