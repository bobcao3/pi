import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { download, readBundle, releaseBase, releaseVersion, sha256, validateExistingRelease, verifyPublicRelease } from "./fork-release-contract.mjs";

export async function publishRelease({ directory, repository, tag, commit, token, apiBase = "https://api.github.com", base = releaseBase(repository, tag) }) {
	assert(token, "Tag publication requires GITHUB_TOKEN with contents: write");
	const context = { tag, commit, base };
	const files = await readBundle(directory, context);
	const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
	const root = `${apiBase.replace(/\/$/, "")}/repos/${repository}`;
	async function api(path, method = "GET", body, allowMissing = false) {
		const response = await fetch(`${root}${path}`, {
			method, headers: { ...headers, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
		});
		if (allowMissing && response.status === 404) return undefined;
		assert(response.ok, `GitHub release API failed: ${method} ${path}: ${response.status}`);
		const bytes = await response.text();
		assert(bytes.length < 1024 * 1024, "GitHub API response exceeds limit");
		return bytes ? JSON.parse(bytes) : undefined;
	}
	async function checkTag() {
		let object = (await api(`/git/ref/tags/${tag}`)).object;
		for (let depth = 0; object.type === "tag" && depth < 4; depth++) object = (await api(`/git/tags/${object.sha}`)).object;
		assert.equal(object.type, "commit", "Release tag nesting exceeds limit");
		assert.equal(object.sha, commit, "Remote tag no longer matches the pushed commit");
	}
	await checkTag();
	let release = await api(`/releases/tags/${tag}`, "GET", undefined, true);
	if (release) validateExistingRelease(release, tag, commit);
	else release = await api("/releases", "POST", { tag_name: tag, target_commitish: commit, name: tag, draft: true, prerelease: false, body: "Verified fork package archives with immutable dependency URLs and source provenance." });
	validateExistingRelease(release, tag, commit);
	const assets = await api(`/releases/${release.id}/assets?per_page=100`);
	assert(Array.isArray(assets) && assets.length < 100, "Release asset listing exceeds limit");
	const existing = new Set();
	for (const asset of assets) {
		assert(!existing.has(asset.name), "Duplicate existing release asset");
		existing.add(asset.name);
		assert(files.has(asset.name), `Unexpected existing release asset: ${asset.name}; use a new release tag`);
		const bytes = await download(`${root}/releases/assets/${asset.id}`, { ...headers, accept: "application/octet-stream" });
		assert.equal(sha256(bytes), sha256(files.get(asset.name)), `Existing release asset conflicts: ${asset.name}; assets never overwrite`);
	}
	const uploadBase = new URL(release.upload_url.split("{")[0]);
	assert(uploadBase.origin === "https://uploads.github.com" || uploadBase.origin === new URL(apiBase).origin, "Unexpected upload origin");
	for (const [name, bytes] of files) {
		if (existing.has(name)) continue;
		const url = new URL(uploadBase);
		url.searchParams.set("name", name);
		const response = await fetch(url, {
			method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes,
			signal: AbortSignal.timeout(60000),
		});
		assert(response.ok, `Upload failed for ${name}: ${response.status}; rerun to compare existing bytes`);
	}
	await checkTag();
	if (release.draft) release = await api(`/releases/${release.id}`, "PATCH", { draft: false });
	validateExistingRelease(release, tag, commit);
	assert.equal(release.draft, false);
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await verifyPublicRelease(files, base, context);
			console.log(`Verified public release ${tag} at ${base}`);
			return;
		} catch (error) {
			if (attempt === 4) throw error;
			await setTimeout(5000);
		}
	}
}

async function main() {
	const [command, directory] = process.argv.slice(2);
	const base = JSON.parse(await readFile("packages/coding-agent/package.json", "utf8")).version;
	const tag = process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
	if (command === "version") {
		assert.equal(process.argv.length, 3);
		console.log(releaseVersion(base, tag, process.env.GITHUB_RUN_ID));
	} else if (command === "publish") {
		assert.equal(process.argv.length, 4);
		assert(tag, "Only pushed release tags may publish");
		releaseVersion(base, tag);
		await publishRelease({ directory: resolve(directory), repository: process.env.GITHUB_REPOSITORY, tag, commit: process.env.GITHUB_SHA, token: process.env.GITHUB_TOKEN });
	} else throw new Error("Usage: publish-fork-release.mjs version | publish DIRECTORY");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
