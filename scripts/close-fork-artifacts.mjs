import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { integrity, jsonBytes, readBundle, sha256 } from "./fork-release-contract.mjs";

async function payload(archive, destination) {
	const files = new Map();
	const entries = new Set();
	let size = 0;
	const extract = tar.extract();
	extract.on("entry", (header, stream, next) => {
		(async () => {
			assert(entries.size < 20000 && !entries.has(header.name), "Duplicate or excessive archive entries");
			entries.add(header.name);
			assert(["file", "directory"].includes(header.type), "Archive links and special files are unsupported");
			assert(header.name.startsWith("package/") && !header.name.includes("\\"));
			assert(!header.name.split("/").some(part => part === ".." || part === "."), "Unsafe archive path");
			assert(Number.isSafeInteger(header.size) && header.size >= 0 && header.size <= 32 * 1024 * 1024);
			const chunks = [];
			for await (const chunk of stream) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			assert.equal(bytes.length, header.size);
			if (header.type !== "file") return;
			files.set(header.name, `${header.mode & 0o777}:${sha256(bytes)}`);
			if (destination) {
				const path = join(destination, header.name);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, bytes, { flag: "wx" });
				await chmod(path, header.mode & 0o777);
			}
		})().then(() => next(), error => extract.destroy(error));
	});
	const bound = new Transform({ transform(chunk, _encoding, callback) {
		size += chunk.length;
		callback(size > 256 * 1024 * 1024 ? new Error("Expanded archive exceeds byte limit") : null, chunk);
	} });
	await pipeline(createReadStream(archive), createGunzip(), bound, extract, { signal: AbortSignal.timeout(120000) });
	assert(files.has("package/package.json"), "Archive lacks package.json");
	files.delete("package/package.json");
	return [...files].sort(([a], [b]) => a.localeCompare(b));
}

export async function closeArtifacts(input, output, context) {
	await assert.rejects(lstat(output), { code: "ENOENT" });
	const rawBytes = await readFile(join(input, "manifest.json"));
	const manifest = JSON.parse(rawBytes);
	assert.equal(manifest.format, 1);
	assert(manifest.artifacts.length > 0 && manifest.artifacts.length < 32);
	const pending = new Map(manifest.artifacts.map(artifact => [artifact.name, artifact]));
	assert.equal(pending.size, manifest.artifacts.length);
	const closed = new Map();
	await mkdir(output, { recursive: true });
	const staging = join(output, "staging");
	try {
		for (let pass = 0; pending.size && pass < manifest.artifacts.length; pass++) {
			const previous = pending.size;
			for (const [name, artifact] of pending) {
				assert.match(name, /^@earendil-works\/[\w.-]+$/);
				assert.equal(artifact.version, manifest.version);
				assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
				assert.equal(artifact.filename, `${artifact.sha256}.tgz`);
				const archive = join(input, artifact.filename);
				assert((await lstat(archive)).size <= 64 * 1024 * 1024);
				const bytes = await readFile(archive);
				assert.equal(sha256(bytes), artifact.sha256);
				assert.equal(integrity(bytes), artifact.integrity);
				await rm(staging, { recursive: true, force: true });
				await mkdir(staging);
				const originalPayload = await payload(archive, staging);
				const folder = join(staging, "package");
				const packagePath = join(folder, "package.json");
				const pkg = JSON.parse(await readFile(packagePath, "utf8"));
				assert.equal(pkg.name, name);
				assert.equal(pkg.version, manifest.version);
				const fields = ["dependencies", "optionalDependencies"];
				for (const [dependency, value] of Object.entries(pkg.peerDependencies ?? {})) {
					if (dependency.startsWith("@earendil-works/"))
						assert.equal(value, pending.has(dependency) || closed.has(dependency) ? manifest.version : manifest.upstreamPackages?.[dependency]);
				}
				const dependencies = new Set();
				for (const field of fields) for (const [dependency, value] of Object.entries(pkg[field] ?? {})) {
					if (!dependency.startsWith("@earendil-works/")) continue;
					if (closed.has(dependency) || pending.has(dependency)) dependencies.add(dependency);
					else assert.equal(value, manifest.upstreamPackages?.[dependency], `Unknown or unpinned upstream dependency: ${dependency}`);
				}
				if ([...dependencies].some(dependency => !closed.has(dependency))) continue;
				artifact.source = { sha256: artifact.sha256, integrity: artifact.integrity, url: new URL(artifact.filename, context.base).href };
				await copyFile(archive, join(output, artifact.filename));
				if (dependencies.size) {
					for (const field of fields) for (const dependency of Object.keys(pkg[field] ?? {})) {
						if (closed.has(dependency)) pkg[field][dependency] = closed.get(dependency).url;
					}
					await writeFile(packagePath, jsonBytes(pkg));
					const result = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
						cwd: folder, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
						env: { ...process.env, NODE_OPTIONS: "", npm_config_ignore_scripts: "true" },
					});
					assert.ifError(result.error);
					assert.equal(result.status, 0, result.stdout + result.stderr);
					const [info] = Object.values(JSON.parse(result.stdout));
					const packedPath = join(output, info.filename);
					assert.deepEqual(await payload(packedPath), originalPayload, `${name}: package payload changed`);
					const packed = await readFile(packedPath);
					artifact.sha256 = sha256(packed);
					artifact.integrity = integrity(packed);
					artifact.filename = `${artifact.sha256}.tgz`;
					artifact.dependencies = pkg.dependencies ?? {};
					await rename(packedPath, join(output, artifact.filename));
				}
				artifact.url = new URL(artifact.filename, context.base).href;
				closed.set(name, artifact);
				pending.delete(name);
			}
			assert(pending.size < previous, "Fork dependency graph contains a cycle");
		}
		assert.equal(pending.size, 0);
		const npm = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 10000 });
		assert.equal(npm.status, 0);
		manifest.closure = { algorithm: 1, node: process.version, npm: npm.stdout.trim() };
		await writeFile(join(output, "manifest.json"), jsonBytes(manifest));
		await writeFile(join(output, "raw-manifest.json"), rawBytes);
		await copyFile(join(input, "verification.json"), join(output, "verification.json"));
		const names = [...new Set(manifest.artifacts.flatMap(artifact => [artifact.filename, `${artifact.source.sha256}.tgz`])), "manifest.json", "raw-manifest.json", "verification.json"].sort();
		const sums = [];
		for (const name of names) sums.push(`${sha256(await readFile(join(output, name)))}  ${name}\n`);
		await writeFile(join(output, "SHA256SUMS"), sums.join(""));
		await readBundle(output, context);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	assert.equal(process.argv.length, 7, "Usage: close-fork-artifacts.mjs RAW_DIRECTORY NEW_DIRECTORY RELEASE_BASE TAG COMMIT");
	await closeArtifacts(resolve(process.argv[2]), resolve(process.argv[3]), { base: process.argv[4], tag: process.argv[5], commit: process.argv[6] });
}
