import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../theme/theme.ts";

export interface ObjectTreeNode {
	path: string;
	key: string;
	kind: "object" | "array" | "string" | "number" | "boolean" | "null" | "notice";
	value: string;
	children: ObjectTreeNode[];
	limited: boolean;
}

export function tree_text(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\t/g, "  ");
}

export function parseTreeOutput(text: string): unknown {
	if (text.length > 262144) return text;
	try {
		return JSON.parse(text);
	} catch {}
	const lines = text.split("\n").filter((line) => line.trim());
	if (lines.length > 1 && lines.length <= 2048) {
		try {
			return lines.map((line) => JSON.parse(line));
		} catch {}
	}
	return text;
}

export function tree_snapshot(input: unknown): ObjectTreeNode {
	const root: ObjectTreeNode = { path: "", key: "", kind: "null", value: "null", children: [], limited: false };
	const queue = [{ input, node: root, depth: 0 }];
	const seen = new WeakMap<object, string>();
	let characters = 262144;
	let properties = 0;
	for (let index = 0; index < queue.length; index++) {
		const { input: value, node, depth } = queue[index];
		if (value === null) continue;
		if (typeof value === "string") {
			node.kind = "string";
			const length = Math.min(value.length, 65536, characters);
			node.value = tree_text(value.slice(0, length));
			node.limited = length < value.length;
			characters -= length;
		} else if (typeof value === "number" || typeof value === "boolean") {
			node.kind = typeof value as "number" | "boolean";
			node.value = String(value);
		} else if (typeof value !== "object") {
			node.kind = "notice";
			node.value = `[${typeof value}]`;
		} else if (seen.has(value) || depth >= 32) {
			node.kind = "notice";
			node.value = seen.has(value) ? `[reference: ${seen.get(value) || "/"}]` : "[depth limit]";
		} else {
			seen.set(value, node.path);
			node.kind = Array.isArray(value) ? "array" : "object";
			node.value = node.kind === "array" ? "[]" : "{}";
			const mime = Object.getOwnPropertyDescriptor(value, "mimeType")?.value;
			const image =
				Object.getOwnPropertyDescriptor(value, "type")?.value === "image" &&
				typeof mime === "string" &&
				mime.startsWith("image/");
			for (const key in value) {
				if (++properties > 8192) {
					node.limited = true;
					break;
				}
				if (!Object.hasOwn(value, key)) continue;
				if (queue.length >= 2048 || node.children.length >= 512 || characters <= 0) {
					node.limited = true;
					break;
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable) continue;
				if (key.length > 256 || key.length > characters) {
					node.limited = true;
					break;
				}
				characters -= key.length;
				const child: ObjectTreeNode = {
					path: `${node.path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
					key,
					kind: "null",
					value: "null",
					children: [],
					limited: false,
				};
				node.children.push(child);
				if (!("value" in descriptor) || (image && key === "data")) {
					child.kind = "notice";
					child.value = image && key === "data" ? "[image data]" : "[accessor]";
				} else queue.push({ input: descriptor.value, node: child, depth: depth + 1 });
			}
		}
	}
	return root;
}

export function tree_key(key: string, parent: ObjectTreeNode, first = false): string {
	if (parent.kind === "array" && /^\d+$/.test(key)) return `[${key}]`;
	if (/^[A-Za-z_$][\w$-]*$/.test(key)) return `${first ? "" : "."}${key}`;
	return `[${JSON.stringify(key).replace(/[\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`)}]`;
}

export function tree_compact(node: ObjectTreeNode, parent: ObjectTreeNode): { node: ObjectTreeNode; label: string } {
	let label = tree_key(node.key, parent, true);
	for (let depth = 0; depth < 32 && node.children.length === 1 && !node.limited; depth++) {
		const child = node.children[0];
		label += tree_key(child.key, node);
		node = child;
	}
	return { node, label };
}

export function tree_color(theme: Theme, color: ThemeColor, text: string): string {
	return theme.style(text, { fg: color, dim: true });
}

export function tree_scalar(node: ObjectTreeNode, theme: Theme): string {
	let value = node.value;
	if (node.kind === "string") {
		value = value.split("\n", 1)[0];
		const truncated = value.length > 80 || node.value.includes("\n") || node.limited;
		value = value.slice(0, 80) + (truncated ? "…" : "");
		const bare =
			/^[A-Za-z_][A-Za-z0-9_./:@+-]*$/.test(value) && !/^(null|true|false|yes|no|on|off|nan|infinity)$/i.test(value);
		return tree_color(theme, "syntaxString", bare ? value : JSON.stringify(value));
	}
	return tree_color(
		theme,
		node.kind === "number" ? "syntaxNumber" : node.kind === "notice" ? "muted" : "syntaxKeyword",
		tree_text(value).replace(/\n/g, "\\n"),
	);
}

export function tree_preview(node: ObjectTreeNode, theme: Theme): string {
	if (!node.children.length) return tree_scalar(node, theme);
	const fields = node.children.slice(0, 4).map((child) => {
		const compact = tree_compact(child, node);
		const value = compact.node.children.length
			? tree_color(theme, "dim", compact.node.kind === "array" ? "[…]" : "{…}")
			: tree_scalar(compact.node, theme);
		return tree_color(theme, "syntaxVariable", compact.label) + tree_color(theme, "dim", "=") + value;
	});
	if (node.children.length > 4 || node.limited) fields.push(tree_color(theme, "dim", "…"));
	return fields.join(" ");
}
