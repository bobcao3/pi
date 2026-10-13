import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import { closeArtifacts } from "./close-fork-artifacts.mjs";
import { integrity, jsonBytes, readBundle, releaseVersion, sha256, verifyPublicRelease } from "./fork-release-contract.mjs";
import { publishRelease } from "./publish-fork-release.mjs";

const tag = "cpi-1.1.1-7";
const version = "1.1.1-cpi.7";
const commit = "1".repeat(40);
const leaf = "@earendil-works/pi-ai";
const top = "@earendil-works/pi-coding-agent";

async function fixture(root) {
	const input = join(root, "raw");
	await mkdir(input);
	const artifacts = [];
	for (const [name, fields] of [[top, { dependencies: { [leaf]: version, "@earendil-works/chord": "1.1.0" }, optionalDependencies: { [leaf]: version }, peerDependencies: { [leaf]: version } }], [leaf, {}]]) {
		const folder = join(root, name.split("/")[1]);
		await mkdir(folder);
		await writeFile(join(folder, "package.json"), jsonBytes({ name, version, type: "module", main: "index.js", bin: { fixture: "cli.js" }, files: ["index.js", "cli.js", "payload.bin"], ...fields }));
		await writeFile(join(folder, "index.js"), name === leaf ? 'export const value = 73;\n' : `export { value } from "${leaf}";\n`);
		await writeFile(join(folder, "cli.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
		await chmod(join(folder, "cli.js"), 0o755);
		await writeFile(join(folder, "payload.bin"), Buffer.from([0, 255, 3, 0, 17]));
		const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", input], { cwd: folder, encoding: "utf8", timeout: 120000 });
		assert.equal(packed.status, 0, packed.stderr);
		const [info] = Object.values(JSON.parse(packed.stdout));
		const bytes = await readFile(join(input, info.filename));
		const hash = sha256(bytes);
		await rename(join(input, info.filename), join(input, `${hash}.tgz`));
		artifacts.push({ name, version, filename: `${hash}.tgz`, sha256: hash, integrity: integrity(bytes), dependencies: fields.dependencies ?? {} });
	}
	const manifest = { format: 1, version, forkRevision: commit, upstreamRevision: "2".repeat(40), upstreamVersion: "1.1.0", upstreamPackages: { "@earendil-works/chord": "1.1.0" }, rootLockSha256: "3".repeat(64), modelCatalogRevision: `sha256-${"4".repeat(64)}`, modelsSha256: "5".repeat(64), node: process.version, esbuild: "0.28.2", typescript: "7.0.2", artifacts };
	await writeFile(join(input, "manifest.json"), jsonBytes(manifest));
	await writeFile(join(input, "verification.json"), jsonBytes({ version, forkRevision: commit, npm: "passed", bun: "passed" }));
	return { input, manifest };
}

async function archiveEntries(bytes) {
	const entries = new Map();
	const extract = tar.extract();
	extract.on("entry", (header, stream, next) => {
		const chunks = [];
		stream.on("data", chunk => chunks.push(chunk));
		stream.on("end", () => { entries.set(header.name, { mode: header.mode, bytes: Buffer.concat(chunks) }); next(); });
	});
	const source = new PassThrough();
	source.end(bytes);
	await pipeline(source, createGunzip(), extract);
	return entries;
}

async function releaseStore(root) {
	const storage = join(root, "assets");
	await mkdir(storage);
	let release;
	let remoteCommit = commit;
	let writes = 0;
	let nextId = 0;
	let publicRequests = 0;
	const assets = [];
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, origin);
			const path = url.pathname;
			const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
			if (path.startsWith("/download/")) {
				assert.equal(request.headers.authorization, undefined, "Public requests must not send credentials");
				publicRequests++;
				const asset = assets.find(entry => entry.name === path.slice("/download/".length));
				if (!release || release.draft || !asset) return send({}, 404);
				response.end(await readFile(join(storage, `${asset.id}`)));
				return;
			}
			assert.equal(request.headers.authorization, "Bearer local-integration-token");
			if (request.method === "GET") {
				if (path.endsWith(`/git/ref/tags/${tag}`)) return send({ object: { type: "tag", sha: "a".repeat(40) } });
				if (path.includes("/git/tags/")) return send({ object: { type: "commit", sha: remoteCommit } });
				if (path.endsWith(`/releases/tags/${tag}`)) return send(release ?? {}, release ? 200 : 404);
				if (path.endsWith("/releases/1/assets")) return send(assets);
				if (path.includes("/releases/assets/")) {
					response.end(await readFile(join(storage, path.split("/").at(-1))));
					return;
				}
			}
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			if (request.method === "POST" && path.endsWith("/releases")) {
				assert.equal(release, undefined);
				release = { ...JSON.parse(bytes), id: 1, upload_url: `${origin}/uploads/1{?name,label}` };
				writes++;
				return send(release, 201);
			}
			if (request.method === "POST" && path === "/uploads/1") {
				const name = url.searchParams.get("name");
				if (assets.some(asset => asset.name === name)) return send({}, 422);
				const asset = { name, id: ++nextId };
				await writeFile(join(storage, `${asset.id}`), bytes, { flag: "wx" });
				assets.push(asset);
				writes++;
				return send(asset, 201);
			}
			if (request.method === "PATCH" && path.endsWith("/releases/1")) {
				Object.assign(release, JSON.parse(bytes));
				writes++;
				return send(release);
			}
			send({}, 404);
		} catch (error) { response.writeHead(500); response.end(String(error)); }
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	return { origin, base: `${origin}/download/`, assets, storage, get release() { return release; }, get writes() { return writes; }, get publicRequests() { return publicRequests; }, set remoteCommit(value) { remoteCommit = value; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("tag versions remain stable and reject malformed or mismatched tags", () => {
	assert.equal(releaseVersion("1.1.1", tag, "99"), version);
	assert.equal(releaseVersion("1.1.1", tag, "100"), version);
	assert.equal(releaseVersion("1.1.1", undefined, "101"), "1.1.1-cpi.101");
	for (const invalid of ["cpi-1.1.1-0", "cpi-1.1.1-01", "cpi-1.1.1--1", "cpi-1.1.1-2x", "cpi-01.1.1-1", "cpi-1.1.1-beta-1", "cpi-1.1.0-7"]) assert.throws(() => releaseVersion("1.1.1", invalid));
});

test("actual archive closure, reproducible bytes, durable publication and conflict safety", { timeout: 120000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "fork-release-test-"));
	const store = await releaseStore(root);
	try {
		const { input, manifest: raw } = await fixture(root);
		const context = { tag, commit, base: store.base };
		const output = join(root, "closed");
		await closeArtifacts(input, output, context);
		const files = await readBundle(output, context);
		const manifest = JSON.parse(files.get("manifest.json"));
		assert.equal(manifest.forkRevision, raw.forkRevision);
		assert.deepEqual(JSON.parse(files.get("raw-manifest.json")), raw);
		assert.deepEqual(files.get("verification.json"), await readFile(join(input, "verification.json")));
		const topArtifact = manifest.artifacts.find(entry => entry.name === top);
		const leafArtifact = manifest.artifacts.find(entry => entry.name === leaf);
		assert.notEqual(topArtifact.sha256, raw.artifacts[0].sha256);
		assert.equal(leafArtifact.sha256, raw.artifacts[1].sha256);
		const original = await archiveEntries(await readFile(join(input, raw.artifacts[0].filename)));
		const transformed = await archiveEntries(files.get(topArtifact.filename));
		const pkg = JSON.parse(transformed.get("package/package.json").bytes);
		for (const field of ["dependencies", "optionalDependencies"]) assert.equal(pkg[field][leaf], leafArtifact.url);
		assert.equal(pkg.peerDependencies[leaf], version);
		assert.equal(pkg.dependencies["@earendil-works/chord"], "1.1.0");
		assert.equal(transformed.get("package/cli.js").mode & 0o111, 0o111);
		original.delete("package/package.json");
		transformed.delete("package/package.json");
		assert.deepEqual(transformed, original);
		await closeArtifacts(input, join(root, "retry"), context);
		for (const name of await readdir(output)) assert.deepEqual(await readFile(join(output, name)), await readFile(join(root, "retry", name)));
		const options = { directory: output, repository: "owner/fork", tag, commit, token: "local-integration-token", apiBase: store.origin, base: store.base };
		await publishRelease(options);
		assert.equal(store.release.name, tag);
		assert.equal(store.release.draft, false);
		assert.equal(store.assets.length, files.size);
		assert(store.publicRequests >= files.size);
		const writes = store.writes;
		await publishRelease(options);
		assert.equal(store.writes, writes, "Identical retries must not write existing assets");
		await verifyPublicRelease(files, store.base, context);
		store.remoteCommit = "9".repeat(40);
		await assert.rejects(publishRelease(options), /Remote tag/);
		store.remoteCommit = commit;
		store.release.target_commitish = "8".repeat(40);
		await assert.rejects(publishRelease(options), /Existing release commit/);
		store.release.target_commitish = commit;
		store.release.name = "other";
		await assert.rejects(publishRelease(options), /Existing release name/);
		store.release.name = tag;
		const asset = store.assets.find(entry => entry.name === "manifest.json");
		const assetPath = join(store.storage, `${asset.id}`);
		await writeFile(assetPath, "corrupt public bytes");
		await assert.rejects(publishRelease(options), /Existing release asset conflicts/);
		await assert.rejects(verifyPublicRelease(files, store.base, context), /Public asset conflicts/);
		assert.equal(store.writes, writes, "Conflicts must never mutate a release");
		await writeFile(assetPath, files.get("manifest.json"));
		await writeFile(join(output, "SHA256SUMS"), "corrupt checksums\n");
		await assert.rejects(publishRelease(options), /SHA256SUMS/);
		assert.equal(store.writes, writes);
	} finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("closure rejects corrupt source bytes and unsafe tar entries before publication", { timeout: 120000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "fork-release-invalid-"));
	try {
		const { input, manifest } = await fixture(root);
		const context = { tag, commit, base: "https://github.com/owner/fork/releases/download/cpi-1.1.1-7/" };
		const artifact = manifest.artifacts[0];
		await writeFile(join(input, artifact.filename), "corrupt");
		await assert.rejects(closeArtifacts(input, join(root, "bad-hash"), context), { code: "ERR_ASSERTION" });
		for (const [name, type] of [["package/../../escape", "file"], ["package/link", "symlink"]]) {
			const pack = tar.pack();
			const chunks = [];
			const compressed = pack.pipe(createGzip());
			compressed.on("data", chunk => chunks.push(chunk));
			const done = new Promise((resolve, reject) => { compressed.on("end", resolve); compressed.on("error", reject); });
			pack.entry({ name, type, linkname: "/tmp/escape" }, type === "file" ? "unsafe" : "");
			pack.finalize();
			await done;
			const bytes = Buffer.concat(chunks);
			artifact.sha256 = sha256(bytes);
			artifact.integrity = integrity(bytes);
			artifact.filename = `${artifact.sha256}.tgz`;
			await writeFile(join(input, artifact.filename), bytes);
			await writeFile(join(input, "manifest.json"), jsonBytes(manifest));
			await assert.rejects(closeArtifacts(input, join(root, `bad-${type}`), context), /Unsafe archive path|Archive links/);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
