import { isCompactWidth } from "../responsive.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export interface GutterTextRow {
	text: string;
	gutter?: string;
	continuationGutter?: string;
	compactGutter?: string;
}

export class GutterText implements Component {
	private readonly rows: readonly GutterTextRow[];
	private readonly wrap: boolean;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(rows: readonly GutterTextRow[], wrap = true) {
		this.rows = rows;
		this.wrap = wrap;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const compact = isCompactWidth(width);
		const gutterWidth = Math.min(
			width - 1,
			this.rows.reduce(
				(max, row) => Math.max(max, visibleWidth(compact ? (row.compactGutter ?? "") : (row.gutter ?? ""))),
				0,
			),
		);
		const lines: string[] = [];
		for (const row of this.rows) {
			const hasGutter = row.gutter !== undefined;
			const bodyWidth = hasGutter ? width - gutterWidth : width;
			const wrapped = this.wrap ? wrapTextWithAnsi(row.text, bodyWidth) : [row.text];
			for (let index = 0; index < wrapped.length; index++) {
				const firstGutter = compact ? row.compactGutter : row.gutter;
				const continuation = compact ? "" : row.continuationGutter;
				const gutter = (index === 0 ? firstGutter : continuation) ?? "";
				const prefix = hasGutter ? truncateToWidth(gutter, gutterWidth, "") : "";
				const padding = hasGutter ? " ".repeat(Math.max(0, gutterWidth - visibleWidth(prefix))) : "";
				const body = truncateToWidth(wrapped[index], bodyWidth, "");
				const line = prefix + padding + body;
				lines.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
			}
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
