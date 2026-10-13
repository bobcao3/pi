import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const stable = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const tagPattern = new RegExp(`^cpi-(${stable})-([1-9]\\d*)$`);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function releaseVersion(base, tag, runId) {
	assert.match(base, new RegExp(`^${stable}$`), "Package version must be stable semver");
	if (!tag) {
		assert.match(runId ?? "", /^[1-9]\d*$/, "GITHUB_RUN_ID must be positive");
		return `${base}-cpi.${runId}`;
	}
	const match = tagPattern.exec(tag);
	assert(match, "Release tag must match cpi-<base-semver>-<positive numeric serial>");
	assert.equal(match[1], base, "Release tag base must match packages/coding-agent/package.json");
	return `${base}-cpi.${match[5]}`;
}

export function releaseBase(repository, tag) {
	assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
	assert(tagPattern.test(tag), "Invalid fork release tag");
	return `https://github.com/${repository}/releases/download/${tag}/`;
}

export function validateManifest(manifest, { tag, commit, base }) {
	assert.equal(manifest.format, 1);
	assert.match(commit, /^[a-f0-9]{40}$/);
	assert.equal(manifest.forkRevision, commit, "Artifact source does not match the pushed commit");
	assert.equal(manifest.version, releaseVersion(tagPattern.exec(tag)?.[1] ?? "", tag));
	assert.match(manifest.upstreamRevision, /^[a-f0-9]{40}$/);
	assert.match(manifest.rootLockSha256, /^[a-f0-9]{64}$/);
	assert.match(manifest.modelsSha256, /^[a-f0-9]{64}$/);
	assert.match(manifest.modelCatalogRevision, /^sha256-[a-f0-9]{64}$/);
	assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0 && manifest.artifacts.length < 32);
	const names = new Set();
	const files = new Map();
	for (const artifact of manifest.artifacts) {
		assert.match(artifact.name, /^@earendil-works\/[\w.-]+$/);
		assert(!names.has(artifact.name), "Duplicate artifact package");
		names.add(artifact.name);
		assert.equal(artifact.version, manifest.version);
		for (const entry of [artifact, artifact.source]) {
			assert(entry, "Every closed artifact must retain raw provenance");
			assert.match(entry.sha256, /^[a-f0-9]{64}$/);
			assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
			const filename = `${entry.sha256}.tgz`;
			assert.equal(entry.url, new URL(filename, base).href, "Artifact URL must belong to the immutable tag release");
			if (entry === artifact) assert.equal(entry.filename, filename);
			if (files.has(filename)) assert.equal(files.get(filename).integrity, entry.integrity);
			files.set(filename, { sha256: entry.sha256, integrity: entry.integrity });
		}
	}
	for (const artifact of manifest.artifacts) {
		for (const [name, value] of Object.entries(artifact.dependencies ?? {})) {
			if (names.has(name)) assert.equal(value, manifest.artifacts.find(entry => entry.name === name).url);
			else if (name.startsWith("@earendil-works/")) assert.equal(value, manifest.upstreamPackages?.[name]);
		}
	}
	return files;
}

export function validateExistingRelease(release, tag, commit) {
	assert.equal(release.tag_name, tag, "Existing release tag conflicts");
	assert.equal(release.name, tag, "Existing release name conflicts");
	assert.equal(release.target_commitish, commit, "Existing release commit conflicts; use a new release tag");
	assert.equal(release.prerelease, false, "Existing release type conflicts");
}

export async function readBundle(directory, context) {
	const manifestBytes = await readFile(join(directory, "manifest.json"));
	const manifest = JSON.parse(manifestBytes);
	const archives = validateManifest(manifest, context);
	const files = new Map();
	for (const [name, expected] of archives) {
		const bytes = await readFile(join(directory, name));
		assert(bytes.length <= 64 * 1024 * 1024);
		assert.equal(sha256(bytes), expected.sha256);
		assert.equal(integrity(bytes), expected.integrity);
		files.set(name, bytes);
	}
	for (const name of ["manifest.json", "raw-manifest.json", "verification.json"]) {
		const bytes = name === "manifest.json" ? manifestBytes : await readFile(join(directory, name));
		assert(bytes.length < 1024 * 1024);
		files.set(name, bytes);
	}
	const raw = JSON.parse(files.get("raw-manifest.json"));
	const expectedRaw = structuredClone(manifest);
	delete expectedRaw.closure;
	for (const artifact of expectedRaw.artifacts) {
		const original = raw.artifacts.find(entry => entry.name === artifact.name);
		assert(original, "Raw manifest package missing");
		assert.equal(original.sha256, artifact.source.sha256);
		assert.equal(original.integrity, artifact.source.integrity);
		Object.assign(artifact, original);
		delete artifact.url;
		delete artifact.source;
	}
	assert.deepEqual(expectedRaw, raw, "Raw source provenance changed");
	const report = JSON.parse(files.get("verification.json"));
	assert.equal(report.version, manifest.version);
	assert.equal(report.forkRevision, context.commit);
	assert.equal(report.npm, "passed");
	assert.equal(report.bun, "passed");
	const sums = Buffer.from([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(""));
	assert.deepEqual(await readFile(join(directory, "SHA256SUMS")), sums, "SHA256SUMS disagrees with release bytes");
	files.set("SHA256SUMS", sums);
	return files;
}

export async function download(url, headers = {}, allowMissing = false) {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
	if (allowMissing && response.status === 404) return undefined;
	assert(response.ok, `Download failed: ${response.status} ${url}`);
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		assert((size += chunk.length) <= 64 * 1024 * 1024, "Download exceeds release asset limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

export async function verifyPublicRelease(files, base, context) {
	for (const [name, expected] of files) {
		const bytes = await download(new URL(name, base));
		assert.equal(sha256(bytes), sha256(expected), `Public asset conflicts: ${name}`);
		if (name === "manifest.json") validateManifest(JSON.parse(bytes), context);
	}
}
