import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.ts";

const exec_file = promisify(execFile);
const environment_prefix = APP_NAME.toUpperCase();
const temp_module = new URL("../src/utils/temp-paths.ts", import.meta.url).href;
const output_module = new URL("../src/utils/output-files.ts", import.meta.url).href;

describe("temporary scratch and retained output paths", () => {
	test.each(["configured", "relative", "tilde", "default"])(
		"captures %s roots at module load and retains private output after child exit",
		async (variant) => {
			const workspace = await mkdtemp(join(tmpdir(), "pi-temp-paths-test-"));
			try {
				const env = { ...process.env };
				delete env[`${environment_prefix}_TEMP_DIR`];
				delete env[`${environment_prefix}_OUTPUT_DIR`];
				const scratch_root = join(workspace, "scratch");
				const output_root = join(workspace, "retained");
				if (variant !== "default") {
					env[`${environment_prefix}_TEMP_DIR`] = variant === "relative" ? "scratch" : scratch_root;
					env[`${environment_prefix}_OUTPUT_DIR`] = variant === "relative" ? "retained" : output_root;
				}
				if (variant === "tilde") {
					env.HOME = workspace;
					env.USERPROFILE = workspace;
					env[`${environment_prefix}_TEMP_DIR`] = "~/scratch";
					env[`${environment_prefix}_OUTPUT_DIR`] = "~/retained";
				}
				const script = join(workspace, "probe.mjs");
				await writeFile(
					script,
					`
import { finished } from 'node:stream/promises';
import { createTempDirectory, getTempDir, getOutputDir } from ${JSON.stringify(temp_module)};
import { writeOutputFile, createOutputFileStream } from ${JSON.stringify(output_module)};
process.env[${JSON.stringify(`${environment_prefix}_TEMP_DIR`)}] = 'changed-scratch';
process.env[${JSON.stringify(`${environment_prefix}_OUTPUT_DIR`)}] = 'changed-output';
process.chdir(${JSON.stringify(tmpdir())});
const scratch = createTempDirectory('operation-');
const files = await Promise.all(Array.from({length: 12}, (_, index) => writeOutputFile('retained', '.txt', 'private-' + index)));
const {path, stream} = createOutputFileStream('streamed', '.bin');
stream.write(Buffer.from([0, 255]));
stream.end(Buffer.from([10, 42]));
await finished(stream);
console.log(JSON.stringify({scratch, files, streamed: path, tempRoot: getTempDir(), outputRoot: getOutputDir()}));
`,
				);
				const { stdout } = await exec_file(process.execPath, [script], { cwd: workspace, env, timeout: 10000 });
				const result = JSON.parse(stdout) as {
					scratch: string;
					files: string[];
					streamed: string;
					tempRoot: string;
					outputRoot: string;
				};
				const expected_temp = variant === "default" ? tmpdir() : scratch_root;
				const expected_output = variant === "default" ? tmpdir() : output_root;
				try {
					expect(result.tempRoot).toBe(resolve(expected_temp));
					expect(result.outputRoot).toBe(resolve(expected_output));
					expect(dirname(result.scratch)).toBe(resolve(expected_temp));
					expect((await stat(result.scratch)).isDirectory()).toBe(true);
					expect(new Set([...result.files, result.streamed]).size).toBe(13);
					for (const [index, path] of result.files.entries()) {
						expect(dirname(path)).toBe(resolve(expected_output));
						expect(await readFile(path, "utf8")).toBe(`private-${index}`);
					}
					expect(dirname(result.streamed)).toBe(resolve(expected_output));
					expect(await readFile(result.streamed)).toEqual(Buffer.from([0, 255, 10, 42]));
					if (process.platform !== "win32") {
						for (const path of [...result.files, result.streamed]) {
							expect((await stat(path)).mode & 0o777).toBe(0o600);
						}
						expect((await stat(result.scratch)).mode & 0o777).toBe(0o700);
						if (variant !== "default") {
							expect((await stat(scratch_root)).mode & 0o777).toBe(0o700);
							expect((await stat(output_root)).mode & 0o777).toBe(0o700);
						}
					}
				} finally {
					await Promise.all(
						[...result.files, result.streamed, result.scratch].map((path) =>
							rm(path, { recursive: true, force: true }),
						),
					);
				}
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});
