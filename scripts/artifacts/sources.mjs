import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { hydrateModelCatalog } from "../../packages/ai/scripts/hydrate-model-catalog.ts";

async function linkModules(source, destination, locals) {
	let entries;
	try { entries = await readdir(source); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	await mkdir(destination);
	const modules = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		if (entry.startsWith("@")) {
			await mkdir(join(destination, entry));
			for (const child of await readdir(join(source, entry))) modules.push(`${entry}/${child}`);
		} else modules.push(entry);
	}
	for (const name of modules) {
		try { await symlink(locals.get(name) ?? await realpath(join(source, name)), join(destination, name)); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	}
}

export async function prepareReleaseSources(checkout, cache) {
	const root = await mkdtemp(join(cache, "pi-release-source-"));
	const skipped = new Set(["node_modules", "dist", ".git", ".jj", ".zig-cache", "zig-out", ".artifacts", ".cache", "coverage", ".env", "auth.json"]);
	let files = 0;
	let sourceBytes = 0;
	try {
		await cp(join(checkout, "packages"), join(root, "packages"), {
			recursive: true,
			filter: async (path) => {
				assert(++files < 40000, "Release source snapshot exceeds the file limit");
				if (skipped.has(basename(path)) || relative(checkout, path) === "packages/ai/src/providers/data") return false;
				const stats = await lstat(path);
				assert(!stats.isSymbolicLink(), `Source snapshot contains a symlink: ${path}`);
				sourceBytes += stats.size;
				assert(sourceBytes < 512 * 1024 * 1024, "Release source snapshot exceeds the byte limit");
				return true;
			},
		});
		for (const name of ["package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.json", "LICENSE"]) {
			await cp(join(checkout, name), join(root, name));
		}
		const locals = new Map();
		for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const directory = join(root, "packages", entry.name);
			try { locals.set(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name, directory); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
		}
		await linkModules(join(checkout, "node_modules"), join(root, "node_modules"), locals);
		for (const directory of locals.values()) {
			const workspace = relative(root, directory);
			await linkModules(join(checkout, workspace, "node_modules"), join(directory, "node_modules"), locals);
		}
		const { revision } = JSON.parse(await readFile(join(checkout, "nix/model-catalog.json"), "utf8"));
		assert.match(revision, /^sha256-[0-9a-f]{64}$/);
		const url = `https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`;
		const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
		assert(response.ok, `Pinned model catalog unavailable: ${response.status}`);
		const chunks = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			assert(size < 32 * 1024 * 1024, "Model catalog exceeds the release limit");
			chunks.push(chunk);
		}
		const bytes = Buffer.concat(chunks, size);
		assert.equal(`sha256-${createHash("sha256").update(bytes).digest("hex")}`, revision, "Pinned model catalog integrity mismatch");
		const catalog = join(root, "models.all.json");
		await writeFile(catalog, bytes);
		hydrateModelCatalog(join(root, "packages/ai"), catalog);
		return { root, modelCatalogRevision: revision };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
