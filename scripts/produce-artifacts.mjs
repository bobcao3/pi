#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "es-module-lexer";
import { version as esbuild } from "esbuild";
import { emitDeclarations } from "./artifacts/declarations.mjs";
import { prepareReleaseSources } from "./artifacts/sources.mjs";
import { manifestPaths, stageTree } from "./artifacts/stage.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [destinationArg, version, upstreamRevision] = process.argv.slice(2);
assert(destinationArg && /^\d+\.\d+\.\d+-[\w.-]+$/.test(version) && /^[a-f0-9]{40}$/.test(upstreamRevision ?? ""),
	"Usage: node scripts/produce-artifacts.mjs NEW_DESTINATION VERSION UPSTREAM_REVISION");
const forkConfig = JSON.parse(await readFile(join(checkout, "fork.json"), "utf8"));
assert.equal(forkConfig.upstreamRevision, upstreamRevision, "fork.json upstreamRevision does not match");
assert(typeof forkConfig.upstreamVersion === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(forkConfig.upstreamVersion),
	"fork.json upstreamVersion must be an exact stable semver");
assert(Array.isArray(forkConfig.redistributedPackages) && forkConfig.redistributedPackages.every(name => typeof name === "string"),
	"fork.json redistributedPackages must be an array of package names");
assert.equal(new Set(forkConfig.redistributedPackages).size, forkConfig.redistributedPackages.length,
	"fork.json redistributedPackages must be unique");
const destination = resolve(destinationArg);
assert(!destination.startsWith(`${checkout}/`), "Artifacts must be outside the checkout");
await assert.rejects(lstat(destination), { code: "ENOENT" });
await mkdir(destination, { recursive: true });
const revision = spawnSync("jj", ["log", "--no-graph", "-r", "@", "-T", "commit_id"], { cwd: checkout, encoding: "utf8", timeout: 10000 });
const fallback = revision.status === 0 ? revision : spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", timeout: 10000 });
assert.equal(fallback.status, 0, "Revision provenance unavailable");
const snapshot = await prepareReleaseSources(checkout, dirname(destination));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
try {
	const workspaces = [];
	for (const entry of await readdir(join(snapshot.root, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const folder = join(snapshot.root, "packages", entry.name);
		let manifest;
		try { manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8")); }
		catch (error) { if (error.code === "ENOENT") continue; throw error; }
		if (!manifest.private) workspaces.push({ folder, original: entry.name, manifest });
	}
	const workspacesByName = new Map(workspaces.map(workspace => [workspace.manifest.name, workspace]));
	const names = new Set(workspacesByName.keys());
	const selected = forkConfig.redistributedPackages.map(name => {
		assert(workspacesByName.has(name), `Configured redistributed package does not exist: ${name}`);
		return workspacesByName.get(name);
	});
	const selectedNames = new Set(forkConfig.redistributedPackages);
	await init;
	const declarations = await emitDeclarations(snapshot.root, selected);
	const artifacts = [];
	const upstreamPackages = {};
	for (const workspace of selected) {
		const staged = join(destination, "staging", workspace.original);
		await mkdir(staged, { recursive: true });
		const allowed = new Set(["README.md", "LICENSE", ...(workspace.manifest.files ?? ["src"]).filter(path => !path.startsWith("!")).map(path => path.split("/")[0] === "dist" ? "src" : path.split("/")[0])]);
		await stageTree(workspace.folder, staged, workspace.folder, "", allowed);
		await cp(declarations.get(workspace.manifest.name), join(staged, "dist"), {
			recursive: true, filter: async path => (await lstat(path)).isDirectory() || /\.d\.(ts|mts|cts)$/.test(path),
		});
		const manifest = structuredClone(workspace.manifest);
		delete manifest.devDependencies;
		delete manifest.scripts;
		delete manifest.workspaces;
		manifest.version = version;
		for (const key of ["exports", "main", "module", "bin", "pi"]) if (manifest[key]) manifest[key] = manifestPaths(manifest[key]);
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
			for (const name of Object.keys(manifest[field] ?? {})) if (names.has(name)) {
				if (selectedNames.has(name)) manifest[field][name] = version;
				else {
					manifest[field][name] = forkConfig.upstreamVersion;
					upstreamPackages[name] = forkConfig.upstreamVersion;
				}
			}
		}
		await save(join(staged, "package.json"), manifest);
		try { await lstat(join(staged, "LICENSE")); }
		catch (error) { if (error.code !== "ENOENT") throw error; await copyFile(join(checkout, "LICENSE"), join(staged, "LICENSE")); }
		const result = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
			cwd: staged, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, NODE_OPTIONS: "", npm_config_ignore_scripts: "true" },
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		const info = Object.values(JSON.parse(result.stdout))[0];
		const bytes = await readFile(join(destination, info.filename));
		const hash = sha256(bytes);
		const filename = `${hash}.tgz`;
		await rename(join(destination, info.filename), join(destination, filename));
		artifacts.push({ name: manifest.name, version, filename, sha256: hash, integrity: info.integrity, dependencies: manifest.dependencies ?? {} });
		console.log(`${manifest.name}@${version}: ${filename}`);
	}
	await save(join(destination, "manifest.json"), {
		format: 1, upstreamRevision, upstreamVersion: forkConfig.upstreamVersion,
		upstreamPackages, forkRevision: fallback.stdout.trim(), version,
		rootLockSha256: sha256(await readFile(join(checkout, "package-lock.json"))),
		modelCatalogRevision: snapshot.modelCatalogRevision, modelsSha256: sha256(await readFile(join(snapshot.root, "packages/ai/src/models.generated.ts"))),
		node: process.version, esbuild, typescript: JSON.parse(await readFile(join(checkout, "node_modules/typescript/package.json"), "utf8")).version,
		artifacts,
	});
	await rm(join(destination, "staging"), { recursive: true });
} finally {
	await rm(snapshot.root, { recursive: true, force: true });
}
