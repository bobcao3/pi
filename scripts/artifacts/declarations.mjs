import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const declaration = /\.d\.(?:ts|mts|cts)$/;
const generated = /\.d\.(?:ts|mts|cts)(?:\.map)?$/;
const nativeOrder = [
	"chord", "tui", "telemetry", "codemode", "mcp", "ai", "durable", "agent",
	"protocol", "client", "server", "coding-agent",
];

async function json(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function compile(compiler, workspace, args, capture = false) {
	const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json", ...args], {
		cwd: workspace.folder,
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
		timeout: 180000,
		maxBuffer: 32 * 1024 * 1024,
		// The release must not enable a development-only source export condition.
		env: { ...process.env, NODE_OPTIONS: "" },
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Declaration compiler failed for ${workspace.manifest.name}${
			capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : " (see compiler diagnostics above)"
		}`, { cause: result.error });
	}
	return result.stdout;
}

async function clearDeclarations(directory) {
	let entries;
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid declaration directory: ${directory}`);
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Declaration output contains a symlink: ${path}`);
		if (entry.isDirectory()) await clearDeclarations(path);
		else if (entry.isFile() && generated.test(entry.name)) await rm(path);
	}
}

async function validateDeclarations(directory, root) {
	let count = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Declaration output contains a symlink: ${path}`);
		if (entry.isDirectory()) count += await validateDeclarations(path, root);
		else if (entry.isFile() && declaration.test(entry.name)) {
			let text = await readFile(path, "utf8");
			if (entry.name.endsWith(".models.d.ts")) {
				text = text.replace(/import values from ("[^"\n]+\.json");/g, "import type values from $1;");
				await writeFile(path, text);
			}
			if (text.includes(root) || /sourceMappingURL=/.test(text)) {
				throw new Error(`Declaration contains a checkout reference or source map: ${path}`);
			}
			count++;
		}
	}
	return count;
}

export async function emitDeclarations(root, selectedWorkspaces) {
	root = await realpath(root);
	const rootManifest = await json(join(root, "package.json"));
	const compilerFolder = join(root, "node_modules", "typescript");
	const compilerManifest = await json(join(compilerFolder, "package.json"));
	if (compilerManifest.version !== rootManifest.devDependencies?.typescript) {
		throw new Error("The installed TypeScript compiler does not match the reviewed root dependency");
	}
	const compiler = join(compilerFolder, compilerManifest.bin.tsc);
	const workspaces = new Map();
	for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const folder = join(root, "packages", entry.name);
		let manifest;
		try { manifest = await json(join(folder, "package.json")); }
		catch (error) { if (error.code === "ENOENT") continue; throw error; }
		if (workspaces.has(manifest.name)) throw new Error(`Duplicate workspace: ${manifest.name}`);
		workspaces.set(manifest.name, { folder, original: entry.name, manifest });
	}
	const selected = new Set();
	for (const workspace of selectedWorkspaces) {
		const local = workspaces.get(workspace.manifest.name);
		if (!local || resolve(workspace.folder) !== local.folder || workspace.original !== basename(local.folder)) {
			throw new Error(`Invalid selected workspace: ${workspace.manifest.name}`);
		}
		selected.add(workspace.manifest.name);
	}
	const ordered = [];
	const completed = new Set();
	const visiting = new Set();
	async function visit(name) {
		if (completed.has(name)) return;
		if (visiting.has(name)) throw new Error(`Declaration build dependency cycle: ${[...visiting, name].join(" -> ")}`);
		const workspace = workspaces.get(name);
		if (!workspace) return;
		visiting.add(name);
		const configPath = join(workspace.folder, "tsconfig.build.json");
		try { await lstat(configPath); }
		catch (error) {
			if (error.code === "ENOENT") throw new Error(`Missing native declaration config: ${configPath}`);
			throw error;
		}
		const config = JSON.parse(compile(compiler, workspace, ["--showConfig"], true));
		const output = resolve(workspace.folder, config.compilerOptions.outDir);
		if (output !== join(workspace.folder, "dist") || config.compilerOptions.declarationDir) {
			throw new Error(`Native declaration config must emit into package dist: ${configPath}`);
		}
		const dependencies = new Set(Object.keys({
			...workspace.manifest.dependencies,
			...workspace.manifest.optionalDependencies,
			...workspace.manifest.peerDependencies,
			...workspace.manifest.devDependencies,
		}));
		for (const key of Object.keys(config.compilerOptions.paths ?? {})) {
			const packageName = key.startsWith("@") ? key.split("/").slice(0, 2).join("/") : key.split("/")[0];
			dependencies.add(packageName);
		}
		const locals = [...dependencies].filter((dependency) => workspaces.has(dependency));
		locals.sort((a, b) => nativeOrder.indexOf(workspaces.get(a).original) - nativeOrder.indexOf(workspaces.get(b).original));
		for (const dependency of locals) await visit(dependency);
		visiting.delete(name);
		completed.add(name);
		ordered.push({ workspace, output });
	}
	const requested = [...selected].sort((a, b) => nativeOrder.indexOf(workspaces.get(a).original) - nativeOrder.indexOf(workspaces.get(b).original));
	for (const name of requested) await visit(name);

	// The helper removes every old header before compiling any package to prevent stale resolution.
	for (const { output } of ordered) await clearDeclarations(output);
	const directories = new Map();
	try {
		for (const { workspace, output } of ordered) {
			console.log(`Emitting release declarations: ${workspace.manifest.name}`);
			compile(compiler, workspace, [
				"--declaration", "true", "--emitDeclarationOnly", "true", "--noEmit", "false",
				"--declarationMap", "false", "--sourceMap", "false", "--inlineSourceMap", "false",
				"--inlineSources", "false", "--noEmitOnError", "true", "--incremental", "false",
			]);
			if (await validateDeclarations(output, root) === 0) {
				throw new Error(`The compiler emitted no SDK declarations for ${workspace.manifest.name}`);
			}
			if (selected.has(workspace.manifest.name)) directories.set(workspace.manifest.name, output);
		}
	} catch (error) {
		for (const { output } of ordered) await clearDeclarations(output);
		throw error;
	}
	return directories;
}
