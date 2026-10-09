import { getKeybindings } from "../keybindings.ts";
import { type Component, dispatchMouseEvent, type TuiMouseEvent, type TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export type TreeStatus = "queued" | "running" | "success" | "warning" | "error" | "cancelled" | "paused" | "detached";

export interface TreeNode {
	id: string;
	label: string;
	summary?: string;
	metadata?: readonly string[];
	status?: TreeStatus;
	children?: readonly TreeNode[];
	body?: Component;
	defaultOpen?: boolean;
}

export interface TreeState {
	open: Map<string, boolean>;
	shownChildren: Map<string, number>;
	selectedId?: string;
	expanded?: boolean;
	frame?: number;
}

export interface TreeViewTheme {
	guide?: (text: string) => string;
	status?: (text: string, status: TreeStatus) => string;
	selected?: (text: string) => string;
}

export interface TreeViewOptions {
	state?: TreeState;
	theme?: TreeViewTheme;
	requestRender?: () => void;
	onCancel?: () => void;
	onSelectionChange?: (id: string) => void;
}

type RowKind = "header" | "body" | "more";

interface FlatNode {
	node: TreeNode;
	depth: number;
	ancestorLast: boolean[];
	childIndex: number;
	childCount: number;
	parentId?: string;
}

interface HitRow {
	kind: RowKind;
	id: string;
	y: number;
	markerStart: number;
	markerEnd: number;
	body?: Component;
	bodyY?: number;
	bodyWidth?: number;
	bodyHeight?: number;
}

const MAX_NODES = 2000;
const MAX_DEPTH = 48;
const MAX_ROWS = 4000;
const CHILD_PAGE = 200;
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_TEXT: Record<TreeStatus, string> = {
	queued: "◌",
	running: RUNNING_FRAMES[0]!,
	success: "✓",
	warning: "!",
	error: "×",
	cancelled: "⊘",
	paused: "Ⅱ",
	detached: "↗",
};

const emptyTheme: Required<TreeViewTheme> = {
	guide: (text) => text,
	status: (text) => text,
	selected: (text) => text,
};

export class TreeView implements Component {
	private roots: readonly TreeNode[];
	private readonly state: TreeState;
	private readonly theme: Required<TreeViewTheme>;
	private readonly requestRender?: () => void;
	private readonly onCancel?: () => void;
	private readonly onSelectionChange?: (id: string) => void;
	private flat: FlatNode[] = [];
	private ids = new Map<string, TreeNode>();
	private parents = new Map<string, string>();
	private hitRows: HitRow[] = [];
	private rowPositions = new Map<string, number>();
	private renderedWidth?: number;
	private renderedLines?: string[];

	constructor(roots: readonly TreeNode[], options: TreeViewOptions = {}) {
		this.roots = roots;
		this.state = options.state ?? { open: new Map(), shownChildren: new Map() };
		this.theme = { ...emptyTheme, ...options.theme };
		this.requestRender = options.requestRender;
		this.onCancel = options.onCancel;
		this.onSelectionChange = options.onSelectionChange;
		this.rebuildIndex();
		this.ensureSelection();
	}

	update(roots: readonly TreeNode[]): void {
		const oldParents = this.parents;
		const oldRows = this.visibleHeaderIds();
		const oldSelected = this.state.selectedId;
		this.roots = roots;
		this.rebuildIndex();
		this.pruneState();
		if (oldSelected && !this.ids.has(oldSelected))
			this.state.selectedId = this.replacementSelection(oldSelected, oldParents, oldRows);
		this.ensureSelection();
		this.invalidate();
		this.requestRender?.();
	}

	setExpanded(expanded: boolean): void {
		if (this.state.expanded === expanded) return;
		this.state.expanded = expanded;
		this.state.open.clear();
		this.changed();
	}

	setFrame(frame: number): void {
		if (this.state.frame === frame) return;
		this.state.frame = frame;
		this.invalidateHeaders();
		this.requestRender?.();
	}

	reveal(id: string): void {
		if (!this.ids.has(id)) return;
		let child = id;
		let parent = this.parents.get(id);
		while (parent) {
			const children = this.ids.get(parent)?.children ?? [];
			const index = children.findIndex((node) => node.id === child);
			if (index >= this.shownCount(parent, children.length)) this.state.shownChildren.set(parent, index + 1);
			this.state.open.set(parent, true);
			child = parent;
			parent = this.parents.get(parent);
		}
		this.select(id);
		this.changed();
	}

	getSelectedId(): string | undefined {
		return this.state.selectedId;
	}

	getRowPosition(id: string): number | undefined {
		if (!this.renderedLines) this.render(this.renderedWidth ?? 80);
		return this.rowPositions.get(id);
	}

	getState(): TreeState {
		return this.state;
	}

	invalidate(): void {
		this.renderedWidth = undefined;
		this.renderedLines = undefined;
		for (const node of this.ids.values()) node.body?.invalidate();
	}

	private invalidateHeaders(): void {
		this.renderedWidth = undefined;
		this.renderedLines = undefined;
	}

	render(width: number): string[] {
		if (this.renderedLines && this.renderedWidth === width) return this.renderedLines;
		const safeWidth = Math.max(0, width);
		if (safeWidth === 0) {
			this.renderedWidth = width;
			this.renderedLines = [];
			return this.renderedLines;
		}
		this.flat = this.buildFlat();
		this.hitRows = [];
		this.rowPositions = new Map();
		const lines: string[] = [];
		for (const flat of this.flat) {
			if (!this.renderNode(flat, safeWidth, lines)) break;
		}
		this.renderedWidth = width;
		this.renderedLines = lines;
		return this.renderedLines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.tree.cancel")) {
			this.onCancel?.();
			return;
		}
		const rows = this.visibleHeaderIds();
		const index = Math.max(0, rows.indexOf(this.state.selectedId ?? ""));
		if (kb.matches(data, "tui.tree.up")) this.select(rows[Math.max(0, index - 1)]);
		else if (kb.matches(data, "tui.tree.down")) this.selectNext(rows, index);
		else if (kb.matches(data, "tui.tree.open")) this.openOrSelectChild();
		else if (kb.matches(data, "tui.tree.close")) this.closeSelected();
		else if (kb.matches(data, "tui.tree.toggle")) this.toggleSelected();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" || event.type === "drag" || event.type === "move") return undefined;
		const hit = this.hitRows.find((row) => event.y === row.y);
		if (!hit) return undefined;
		if (hit.kind === "body" && hit.body && hit.bodyY !== undefined && hit.bodyWidth !== undefined) {
			if (event.x < hit.markerEnd || event.x >= hit.markerEnd + hit.bodyWidth) return undefined;
			const result = dispatchMouseEvent(hit.body, {
				...event,
				x: event.x - hit.markerEnd,
				y: hit.bodyY,
				width: hit.bodyWidth,
				height: hit.bodyHeight ?? event.height,
			});
			if (!result) return undefined;
			return { ...result, focus: result.focus && Boolean(this.onCancel) };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		if (hit.kind === "more") {
			if (event.type === "click") this.showMore(hit.id);
			return { handled: true, render: event.type === "click", focus: Boolean(this.onCancel) };
		}
		const onMarker = event.x >= hit.markerStart && event.x < hit.markerEnd;
		if (onMarker) {
			if (event.type === "click") this.toggle(hit.id);
			return { handled: true, focus: Boolean(this.onCancel) };
		}
		if (event.type === "press") return undefined;
		if (event.type === "click") this.select(hit.id);
		return { handled: true, focus: Boolean(this.onCancel) };
	}

	private rebuildIndex(): void {
		this.ids = new Map();
		this.parents = new Map();
		const active = new Set<TreeNode>();
		const stack = [...this.roots].reverse().map((node) => ({ node, depth: 0, enter: true }));
		let count = 0;
		while (stack.length > 0) {
			const item = stack.pop()!;
			if (!item.enter) {
				active.delete(item.node);
				continue;
			}
			if (active.has(item.node)) throw new Error(`TreeView cycle at ${item.node.id}`);
			if (this.ids.has(item.node.id)) throw new Error(`TreeView duplicate id ${item.node.id}`);
			if (++count > MAX_NODES) throw new Error(`TreeView node limit ${MAX_NODES} exceeded`);
			if (item.depth > MAX_DEPTH) throw new Error(`TreeView depth limit ${MAX_DEPTH} exceeded`);
			active.add(item.node);
			this.ids.set(item.node.id, item.node);
			stack.push({ node: item.node, depth: item.depth, enter: false });
			const children = item.node.children ?? [];
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i]!;
				this.parents.set(child.id, item.node.id);
				stack.push({ node: child, depth: item.depth + 1, enter: true });
			}
		}
	}

	private buildFlat(): FlatNode[] {
		const result: FlatNode[] = [];
		const stack = [...this.roots].reverse().map((node, index) => ({
			node,
			depth: 0,
			ancestorLast: [] as boolean[],
			childIndex: this.roots.length - 1 - index,
			childCount: this.roots.length,
		}));
		while (stack.length > 0 && result.length < MAX_ROWS) {
			const item = stack.pop()!;
			result.push({
				node: item.node,
				depth: item.depth,
				ancestorLast: item.ancestorLast,
				childIndex: item.childIndex,
				childCount: item.childCount,
				parentId: this.parents.get(item.node.id),
			});
			if (!this.isOpen(item.node)) continue;
			const children = item.node.children ?? [];
			const shown = this.shownCount(item.node.id, children.length);
			const hasMore = shown < children.length;
			for (let i = shown - 1; i >= 0; i--) {
				const ancestorLast =
					item.depth === 0 ? [] : [...item.ancestorLast, item.childIndex === item.childCount - 1];
				stack.push({
					node: children[i]!,
					depth: item.depth + 1,
					ancestorLast,
					childIndex: i,
					childCount: hasMore ? shown + 1 : shown,
				});
			}
		}
		return result;
	}

	private renderNode(flat: FlatNode, width: number, lines: string[]): boolean {
		const y = lines.length;
		const node = flat.node;
		const status = this.statusCell(node);
		const maxGuides = Math.max(0, Math.floor(Math.max(0, width - 4) / 2));
		const ancestors = flat.ancestorLast.slice(Math.max(0, flat.ancestorLast.length - maxGuides));
		const guide = this.theme.guide(ancestors.map((last) => (last ? "  " : "│ ")).join(""));
		const branch = this.theme.guide(flat.depth === 0 ? "" : flat.childIndex === flat.childCount - 1 ? "└─" : "├─");
		const continuation = this.theme.guide(
			flat.depth === 0 ? "" : flat.childIndex === flat.childCount - 1 ? "  " : "│ ",
		);
		const marker = this.canExpand(node) ? (this.isOpen(node) ? "▾ " : "▸ ") : "  ";
		const rawPrefix = status + guide + branch + marker;
		const prefix = this.prefix(rawPrefix, width);
		const markerStart = visibleWidth(status + guide + branch);
		const markerEnd = markerStart + 2;
		const text = [node.label, node.summary, ...(node.metadata ?? [])]
			.filter((part) => part && part.length > 0)
			.join(" · ")
			.replace(/[\r\n\t]+/g, " ");
		const contentWidth = Math.max(1, width - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, contentWidth);
		for (let i = 0; i < wrapped.length; i++) {
			if (lines.length >= MAX_ROWS - 1) {
				this.renderNotice(width, lines);
				return false;
			}
			const linePrefix = i === 0 ? prefix : this.prefix("  " + guide + continuation + "  ", width);
			const line = this.fit(linePrefix + wrapped[i]!, width);
			lines.push(node.id === this.state.selectedId ? this.theme.selected(line) : line);
			this.hitRows.push({
				kind: "header",
				id: node.id,
				y: y + i,
				markerStart: i === 0 ? markerStart : -1,
				markerEnd: i === 0 ? markerEnd : -1,
			});
		}
		this.rowPositions.set(node.id, y);
		if (!this.isOpen(node)) return true;
		if (!this.renderBody(flat, width, lines)) return false;
		return this.renderMore(flat, width, lines);
	}

	private renderBody(flat: FlatNode, width: number, lines: string[]): boolean {
		if (!flat.node.body) return true;
		const guide = this.theme.guide([...flat.ancestorLast, true].map((last) => (last ? "  " : "│ ")).join(""));
		const prefix = this.prefix("  " + guide + "  ", width);
		const bodyWidth = Math.max(0, width - visibleWidth(prefix));
		const bodyLines = flat.node.body.render(bodyWidth);
		for (let i = 0; i < bodyLines.length; i++) {
			if (lines.length >= MAX_ROWS - 1) {
				this.renderNotice(width, lines);
				return false;
			}
			const y = lines.length;
			lines.push(this.fit(prefix + bodyLines[i]!, width));
			this.hitRows.push({
				kind: "body",
				id: flat.node.id,
				y,
				markerStart: 0,
				markerEnd: visibleWidth(prefix),
				body: flat.node.body,
				bodyY: i,
				bodyWidth,
				bodyHeight: bodyLines.length,
			});
		}
		return true;
	}

	private renderMore(flat: FlatNode, width: number, lines: string[]): boolean {
		const children = flat.node.children ?? [];
		const shown = this.shownCount(flat.node.id, children.length);
		if (shown >= children.length) return true;
		if (lines.length >= MAX_ROWS - 1) {
			this.renderNotice(width, lines);
			return false;
		}
		const guide = this.theme.guide([...flat.ancestorLast, true].map((last) => (last ? "  " : "│ ")).join(""));
		const text = `${children.length - shown} more`;
		const line = this.fit(this.prefix("  " + guide + "  ", width) + text, width);
		this.hitRows.push({
			kind: "more",
			id: flat.node.id,
			y: lines.length,
			markerStart: 0,
			markerEnd: visibleWidth(line),
		});
		lines.push(line);
		return true;
	}

	private renderNotice(width: number, lines: string[]): void {
		lines.push(this.fit("… more rows", width));
	}

	private prefix(prefix: string, width: number): string {
		return truncateToWidth(prefix, Math.max(0, width - 1), "");
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}

	private statusCell(node: TreeNode): string {
		if (!node.status) return "  ";
		const raw =
			node.status === "running"
				? RUNNING_FRAMES[Math.abs(this.state.frame ?? 0) % RUNNING_FRAMES.length]!
				: STATUS_TEXT[node.status];
		return this.theme.status(this.fit(raw, 1), node.status) + " ";
	}

	private isOpen(node: TreeNode): boolean {
		return this.state.open.get(node.id) ?? this.state.expanded ?? Boolean(node.defaultOpen);
	}

	private canExpand(node: TreeNode): boolean {
		return Boolean(node.body || (node.children && node.children.length > 0));
	}

	private shownCount(id: string, total: number): number {
		return Math.min(total, this.state.shownChildren.get(id) ?? CHILD_PAGE);
	}

	private showMore(id: string): void {
		const node = this.ids.get(id);
		const total = node?.children?.length ?? 0;
		this.state.shownChildren.set(id, Math.min(total, this.shownCount(id, total) + CHILD_PAGE));
		this.changed();
	}

	private selectNext(rows: string[], index: number): void {
		if (index < rows.length - 1) {
			this.select(rows[index + 1]);
			return;
		}
		const selected = this.state.selectedId;
		if (!selected) return;
		const parent = this.parents.get(selected);
		if (!parent) return;
		const node = this.ids.get(parent);
		const total = node?.children?.length ?? 0;
		if (this.shownCount(parent, total) >= total) return;
		this.showMore(parent);
		this.select(this.visibleHeaderIds()[index + 1]);
	}

	private openOrSelectChild(): void {
		const node = this.selectedNode();
		if (!node || !this.canExpand(node)) return;
		if (!this.isOpen(node)) {
			this.setSelectedOpen(true);
			return;
		}
		this.select(node.children?.[0]?.id);
	}

	private setSelectedOpen(open: boolean): void {
		const node = this.selectedNode();
		if (!node || !this.canExpand(node)) return;
		this.state.open.set(node.id, open);
		if (!open) this.moveSelectionToVisibleAncestor(node.id);
		this.changed();
	}

	private closeSelected(): void {
		const node = this.selectedNode();
		if (node && this.isOpen(node) && this.canExpand(node)) this.setSelectedOpen(false);
		else if (this.state.selectedId) this.select(this.parents.get(this.state.selectedId));
	}

	private toggleSelected(): void {
		if (this.state.selectedId) this.toggle(this.state.selectedId);
	}

	private toggle(id: string): void {
		const node = this.ids.get(id);
		if (!node || !this.canExpand(node)) return;
		const open = !this.isOpen(node);
		this.state.open.set(id, open);
		if (!open) this.moveSelectionToVisibleAncestor(id);
		this.changed();
	}

	private moveSelectionToVisibleAncestor(id: string): void {
		let selected = this.state.selectedId;
		while (selected) {
			const parent = this.parents.get(selected);
			if (parent === id) {
				this.state.selectedId = id;
				this.onSelectionChange?.(id);
				return;
			}
			selected = parent;
		}
	}

	private pruneState(): void {
		for (const id of this.state.open.keys()) if (!this.ids.has(id)) this.state.open.delete(id);
		for (const id of this.state.shownChildren.keys()) if (!this.ids.has(id)) this.state.shownChildren.delete(id);
	}

	private replacementSelection(
		oldSelected: string,
		oldParents: Map<string, string>,
		oldRows: string[],
	): string | undefined {
		let ancestor = oldParents.get(oldSelected);
		while (ancestor) {
			if (this.ids.has(ancestor)) return ancestor;
			ancestor = oldParents.get(ancestor);
		}
		const index = oldRows.indexOf(oldSelected);
		for (let offset = 1; index >= 0 && offset < oldRows.length; offset++) {
			const next = oldRows[index + offset];
			if (next && this.ids.has(next)) return next;
			const previous = oldRows[index - offset];
			if (previous && this.ids.has(previous)) return previous;
		}
		return undefined;
	}

	private selectedNode(): TreeNode | undefined {
		return this.state.selectedId ? this.ids.get(this.state.selectedId) : undefined;
	}

	private select(id: string | undefined): void {
		if (!id || this.state.selectedId === id || !this.ids.has(id)) return;
		this.state.selectedId = id;
		this.onSelectionChange?.(id);
		this.changed();
	}

	private visibleHeaderIds(): string[] {
		return this.buildFlat().map((item) => item.node.id);
	}

	private ensureSelection(): void {
		if (this.state.selectedId && this.ids.has(this.state.selectedId)) return;
		this.state.selectedId = this.roots[0]?.id;
	}

	private changed(): void {
		this.invalidate();
		this.requestRender?.();
	}
}
