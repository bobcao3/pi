import assert from "node:assert/strict";
import { releaseBase } from "./fork-release-contract.mjs";

assert(process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_TYPE === "tag", "Only pushed fork release tags may dispatch pin updates");
const tag = process.env.GITHUB_REF_NAME;
releaseBase(process.env.GITHUB_REPOSITORY, tag);
const token = process.env.CPI_PIN_UPDATE_TOKEN;
assert(token, "The durable release exists, but the generated GitHub App token is unavailable. Configure the pin App Client ID, signing key, and cpi installation.");
const response = await fetch("https://api.github.com/repos/bobcao3/cpi/dispatches", {
	method: "POST",
	headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
	body: JSON.stringify({ event_type: "pi-fork-release", client_payload: { release_tag: tag } }),
	signal: AbortSignal.timeout(60000),
});
assert.equal(response.status, 204, `The durable release exists, but cpi pin dispatch failed (${response.status}). Check the pin App installation on bobcao3/cpi and rerun the sync job.`);
console.log(`Dispatched pi-fork-release for ${tag} to bobcao3/cpi`);
