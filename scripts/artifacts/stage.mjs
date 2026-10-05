import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { transform } from "esbuild";
import { parse } from "es-module-lexer";
const excluded = new Set([
	"node_modules", "dist", ".git", ".jj", "test", "tests", "__tests__", "coverage",
	".cache", ".artifacts", "artifacts", ".turbo", "test-results", "playwright-report", ".zig-cache", "zig-out",
]);
const limits = { files: 50000, bytes: 512 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, installMs: 300000 };
let files = 0;
let bytes = 0;
const started = Date.now();
const deadline = started + 600000;

function inside(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function bounded(size = 0) {
	if (++files > limits.files || (bytes += size) > limits.bytes || size > limits.fileBytes || Date.now() > deadline) {
		throw new Error("Artifact staging exceeded the file, byte, or time limit");
	}
}

function emitted(path) {
	return path.replace(/^src\//, "dist/").replace(/\.(ts|tsx|mts|cts)$/, (_, ext) => ext === "mts" ? ".mjs" : ext === "cts" ? ".cjs" : ".js");
}

export function manifestPaths(value) {
	if (typeof value === "string") {
		if (/\.d\.(ts|mts|cts)$/.test(value)) return value;
		return value.replace(/^(\.\/)?src\//, "$1dist/").replace(/dist\/bundle\/(cli|rpc-entry)\.js$/, "dist/$1.js").replace(/\.(ts|tsx|mts|cts)$/, (_, ext) => ext === "mts" ? ".mjs" : ext === "cts" ? ".cjs" : ".js");
	}
	if (Array.isArray(value)) return value.map(manifestPaths);
	if (!value || typeof value !== "object") return value;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "source") continue;
		const rewritten = manifestPaths(entry);
		if (rewritten !== undefined) result[key] = rewritten;
	}
	return Object.keys(result).length ? result : undefined;
}

async function rewriteModules(code, sourcePath, outputPath, packageRoot) {
	const [imports] = parse(code);
	const edits = [];
	for (const imported of imports) {
		if (!imported.n || !/^\.\.?\//.test(imported.n)) continue;
		const target = resolve(dirname(sourcePath), imported.n);
		if (!inside(packageRoot, target)) throw new Error(`Cross-package relative import: ${sourcePath}: ${imported.n}`);
		const targetPath = emitted(relative(packageRoot, target).split(sep).join("/"));
		let specifier = relative(dirname(outputPath), join(packageRoot, targetPath)).split(sep).join("/");
		if (!specifier.startsWith(".")) specifier = `./${specifier}`;
		if (specifier !== imported.n) edits.push({ start: imported.s, end: imported.e, text: imported.d >= 0 ? JSON.stringify(specifier) : specifier });
	}
	for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
	return code;
}

export async function stageTree(source, destination, packageRoot, rel = "", allowedRoot) {
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (!rel && allowedRoot && !allowedRoot.has(entry.name)) continue;
		if (/^\.env(?:$|\.(?!example$))/.test(entry.name) || entry.name === "auth.json") throw new Error(`Private configuration in release inputs: ${join(source, entry.name)}`);
		if (excluded.has(entry.name) || /(?:\.|-)(?:test|spec)(?:\.|-)/.test(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
		const path = join(source, entry.name);
		const local = rel ? `${rel}/${entry.name}` : entry.name;
		if (packageRoot.endsWith("/coding-agent") && ["src/client", "src/experimental", "src/cli/experimental"].includes(local)) continue;
		if (local === "package.json" || local === "scripts" || /^(?:tsconfig|vitest|vite)\b/.test(local)) continue;
		if (entry.isSymbolicLink()) throw new Error(`Source symlinks are unsupported: ${path}`);
		if (entry.isDirectory()) {
			bounded();
			await stageTree(path, destination, packageRoot, local);
			continue;
		}
		if (!entry.isFile()) throw new Error(`Unsupported source file: ${path}`);
		const info = await stat(path);
		bounded(info.size);
		const compile = /\.(ts|tsx|mts|cts)$/.test(local) && !/\.d\.(ts|mts|cts)$/.test(local) && /^(src|extensions|skills)\//.test(local);
		const outputRel = compile ? emitted(local) : local.replace(/^src\//, "dist/");
		const output = join(destination, outputRel);
		await mkdir(dirname(output), { recursive: true });
		if (compile || /\.(js|mjs|cjs)$/.test(local)) {
			let code = await readFile(path, "utf8");
			if (compile) {
				const result = await transform(code, {
					loader: local.endsWith("tsx") ? "tsx" : "ts", format: local.endsWith("cts") ? "cjs" : "esm",
					target: "node22.19", sourcefile: local, sourcemap: false, legalComments: "none",
					tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
				});
				code = result.code;
			}
			code = await rewriteModules(code, path, join(packageRoot, outputRel), packageRoot);
			if (code.includes(packageRoot)) throw new Error(`Development checkout reference: ${path}`);
			await writeFile(output, code);
		} else await copyFile(path, output);
		await chmod(output, info.mode & 0o777);
	}
}

