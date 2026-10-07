import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { installConsumer } from "./local-package-install.mjs";

assert.equal(process.argv.length, 3, "Usage: node scripts/verify-fork-artifacts.mjs ARTIFACT_DIRECTORY");
const directory = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
assert.equal(manifest.format, 1);
assert(manifest.artifacts.length > 0 && manifest.artifacts.length < 32);
const tarballs = new Map();
for (const artifact of manifest.artifacts) {
	assert.equal(artifact.filename, `${artifact.sha256}.tgz`);
	assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
	assert.equal(artifact.version, manifest.version);
	assert(!tarballs.has(artifact.name));
	const path = join(directory, artifact.filename);
	const bytes = await readFile(path);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
	assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, artifact.integrity);
	tarballs.set(artifact.name, path);
}
const packages = manifest.artifacts.map(artifact => ({
	...artifact,
	tarballPath: tarballs.get(artifact.name),
}));
const artifactSet = {
	packages,
	getPackage(name) {
		const entry = packages.find(pkg => pkg.name === name);
		assert(entry, `Missing artifact: ${name}`);
		return entry;
	},
};
const work = await mkdtemp(join(tmpdir(), "pi-fork-consumer-"));
try {
	for (const manager of ["npm", "bun"]) {
		const consumer = join(work, manager);
		installConsumer({
			artifactSet,
			directory: consumer,
			packageNames: [codingAgentName],
			packageManager: manager,
		});
		smokeTestCodingAgent(consumer, manager === "npm" ? process.execPath : "bun");
	}
	await writeFile(join(directory, "verification.json"), `${JSON.stringify({
		version: manifest.version, forkRevision: manifest.forkRevision, npm: "passed", bun: "passed",
	}, null, 2)}\n`);
} finally {
	await rm(work, { recursive: true, force: true });
}
