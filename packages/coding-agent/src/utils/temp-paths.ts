import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME, expandTildePath } from "../config.ts";

const environment_prefix = APP_NAME.toUpperCase();
const temp_override = process.env[`${environment_prefix}_TEMP_DIR`];
const output_override = process.env[`${environment_prefix}_OUTPUT_DIR`];
const temp_root = temp_override ? resolve(expandTildePath(temp_override)) : tmpdir();
const output_root = output_override ? resolve(expandTildePath(output_override)) : tmpdir();

export function getTempDir(): string {
	if (temp_override) mkdirSync(temp_root, { recursive: true, mode: 0o700 });
	return temp_root;
}

export function getOutputDir(): string {
	if (output_override) mkdirSync(output_root, { recursive: true, mode: 0o700 });
	return output_root;
}

export function createTempDirectory(prefix: string): string {
	return mkdtempSync(join(getTempDir(), prefix));
}
