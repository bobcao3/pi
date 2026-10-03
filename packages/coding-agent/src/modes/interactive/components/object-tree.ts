import {
	type Component,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { highlightCode, type Theme } from "../theme/theme.ts";
import {
	type ObjectTreeNode,
	parseTreeOutput,
	tree_color,
	tree_compact,
	tree_preview,
	tree_scalar,
	tree_snapshot,
	tree_text,
} from "./object-tree-data.ts";

export { parseTreeOutput } from "./object-tree-data.ts";
export interface ObjectTreeState {
	open?: Map<string, boolean>;
	pages?: Map<string, number>;
	expanded?: boolean;
}
export interface ObjectTreeOptions {
	label: string;
	value: unknown;
	preview?: unknown;
	prefix?: string;
	suffix?: string;
	expanded?: boolean;
	parseText?: boolean;
	language?: string;
	state?: ObjectTreeState;
	invalidate?: () => void;
}
interface TreeRow {
	x: number;
	action: () => void;
}
interface Branch {
	node: ObjectTreeNode;
	label: string;
	guide: string;
	last: boolean;
	alignment: number;
}
const PAGE_SIZE = 32;
const ROW_LIMIT = 256;

export class ObjectTreeComponent implements Component {
	private options: ObjectTreeOptions;
	private theme: Theme;
	private state: ObjectTreeState;
	private root: ObjectTreeNode;
	private preview: ObjectTreeNode;
	private rows = new Map<number, TreeRow>();
	private highlighted?: string[];

	constructor(options: ObjectTreeOptions, theme: Theme) {
		this.options = options;
		this.theme = theme;
		this.state = options.state ?? {};
		this.state.open ??= new Map();
		this.state.pages ??= new Map();
		if (this.state.expanded !== options.expanded) {
			this.state.open.clear();
			this.state.expanded = options.expanded;
		}
		const value =
			options.parseText && typeof options.value === "string" ? parseTreeOutput(options.value) : options.value;
		this.root = tree_snapshot(value);
		this.preview = options.preview === undefined ? this.root : tree_snapshot(options.preview);
	}

	invalidate(): void {
		this.highlighted = undefined;
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean; render?: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const row = this.rows.get(event.y);
		if (row && event.x === row.x) {
			row.action();
			this.options.invalidate?.();
			return { handled: true };
		}
		return { handled: true, render: false };
	}

	private is_open(path: string): boolean {
		return this.state.open?.get(path) ?? (path === "" && !!this.options.expanded);
	}

	private toggle(path: string): void {
		const open = this.is_open(path);
		if (this.state.open!.size >= 4096) this.state.open!.clear();
		this.state.open!.set(path, !open);
	}

	private children(node: ObjectTreeNode, guide: string): Branch[] {
		const count = this.state.pages!.get(node.path) ?? PAGE_SIZE;
		const compact = node.children.slice(0, count).map((child) => tree_compact(child, node));
		const alignment = Math.min(32, Math.max(0, ...compact.map((child) => visibleWidth(child.label))));
		const branches = compact.map(({ node: child, label }, index) => ({
			node: child,
			label,
			guide,
			alignment,
			last: index === compact.length - 1 && count >= node.children.length && !node.limited,
		}));
		if (count < node.children.length || node.limited) {
			branches.push({ node, label: "", guide, alignment: -1, last: true });
		}
		return branches;
	}

	render(width: number): string[] {
		this.rows.clear();
		if (width <= 0) return [];
		const theme = this.theme;
		const dim = (text: string) => tree_color(theme, "dim", text);
		const prefix = this.options.prefix ?? "";
		const anchor = visibleWidth(prefix);
		const open = this.is_open("");
		const title =
			prefix +
			dim(open ? "▾ " : "▸ ") +
			theme.fg("toolTitle", tree_text(this.options.label.slice(0, 1024)).replace(/\n/g, "\\n"));
		const tail = this.options.suffix
			? dim(` · ${tree_text(this.options.suffix.slice(0, 1024)).replace(/\n/g, "\\n")}`)
			: "";
		const suffix = visibleWidth(title) + visibleWidth(tail) <= width ? tail : "";
		const available = Math.max(0, width - visibleWidth(suffix));
		const preview = open ? "" : ` ${tree_preview(this.preview, theme)}`;
		const lines = [truncateToWidth(truncateToWidth(title + preview, available, "…") + suffix, width, "")];
		if (anchor < available) this.rows.set(0, { x: anchor, action: () => this.toggle("") });
		if (!open) return lines;
		const guide = " ".repeat(anchor);
		if (!this.root.children.length) {
			this.string_lines(this.root, `${guide}│ `, width, lines, this.options.language);
			return lines;
		}
		const stack = this.children(this.root, guide).reverse();
		while (stack.length && lines.length < ROW_LIMIT) {
			const branch = stack.pop()!;
			const { node, label, guide, last, alignment } = branch;
			const stem = guide + (last ? "└─ " : "├─ ");
			const next = guide + (last ? "   " : "│  ");
			if (alignment < 0) {
				const count = this.state.pages!.get(node.path) ?? PAGE_SIZE;
				const more = count < node.children.length;
				if (more)
					this.rows.set(lines.length, {
						x: visibleWidth(stem),
						action: () => this.state.pages!.set(node.path, count + PAGE_SIZE),
					});
				lines.push(
					truncateToWidth(
						dim(
							stem +
								(more
									? `▸ ${node.children.length - count}${node.limited ? "+" : ""} more items`
									: "… display limit"),
						),
						width,
						"…",
					),
				);
				continue;
			}
			const expandable =
				node.children.length > 0 ||
				node.limited ||
				(node.kind === "string" &&
					(node.value.length > 80 ||
						node.value.includes("\n") ||
						visibleWidth(stem + label) + visibleWidth(tree_scalar(node, theme)) + 2 > width));
			const opened = expandable && this.is_open(node.path);
			const marker = expandable ? (opened ? "▾ " : "▸ ") : "";
			const padding = expandable ? "" : " ".repeat(Math.min(12, Math.max(0, alignment - visibleWidth(label))));
			const key = tree_color(theme, "syntaxVariable", label);
			const value = opened
				? ""
				: node.children.length
					? ` ${tree_preview(node, theme)}`
					: ` ${tree_scalar(node, theme)}`;
			if (expandable && visibleWidth(stem) < width)
				this.rows.set(lines.length, { x: visibleWidth(stem), action: () => this.toggle(node.path) });
			lines.push(truncateToWidth(dim(stem + marker) + key + dim(`:${padding}`) + value, width, "…"));
			if (opened) {
				if (node.children.length) stack.push(...this.children(node, next).reverse());
				else this.string_lines(node, `${next}│ `, width, lines);
			}
		}
		if (stack.length) lines.push(truncateToWidth(dim(`${guide}└─ … display limit`), width, ""));
		return lines;
	}

	private string_lines(node: ObjectTreeNode, prefix: string, width: number, lines: string[], language?: string): void {
		const room = width - visibleWidth(prefix);
		if (room <= 0) {
			lines.push(truncateToWidth(tree_color(this.theme, "dim", `${prefix}…`), width, ""));
			return;
		}
		const text = node.kind === "string" ? node.value : node.value || (node.kind === "array" ? "[]" : "{}");
		if (language) this.highlighted ??= highlightCode(text, language);
		const source = language ? this.highlighted! : text.split("\n");
		let limited = node.limited;
		outer: for (const line of source) {
			for (const chunk of wrapTextWithAnsi(line, room)) {
				if (lines.length >= ROW_LIMIT) {
					limited = true;
					break outer;
				}
				lines.push(
					tree_color(this.theme, "dim", prefix) +
						(language ? this.theme.style(chunk, { dim: true }) : tree_color(this.theme, "syntaxString", chunk)),
				);
			}
		}
		if (limited) lines.push(truncateToWidth(tree_color(this.theme, "dim", `${prefix}… display limit`), width, ""));
	}
}
