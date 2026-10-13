import { type Component, GutterText, type GutterTextRow } from "@earendil-works/pi-tui";
import { theme as activeTheme, getLanguageFromPath, type Theme } from "../theme/theme.ts";
import { type DiffLine, highlightChangedWords, highlightDiffLines } from "./diff-syntax.ts";

export interface RenderDiffOptions {
	filePath?: string;
	language?: string;
	theme?: Theme;
	lineNumbers?: boolean | number;
}

type DiffOptions = RenderDiffOptions & {
	wrap?: boolean;
	visibleLines?: readonly (number | null)[];
};

function parseDiffLine(line: string, lineNumbers: boolean | number = true): DiffLine | null {
	if (
		/^(---(?: |$)|\+\+\+(?: |$)|@@|diff |index )/.test(line) ||
		line.startsWith("\\") ||
		/^[ \t]*(\.{3}|…)$/.test(line)
	) {
		return null;
	}
	const first = line[0];
	if (first !== "+" && first !== "-" && first !== " ") return null;
	if (typeof lineNumbers === "number") {
		return { prefix: first, lineNum: line.slice(1, lineNumbers - 1), content: line.slice(lineNumbers) };
	}
	if (lineNumbers !== false) {
		const match = line.match(/^([+\- ])(\s*\d+) (.*)$/);
		if (match) return { prefix: match[1], lineNum: match[2], content: match[3] };
	}
	return { prefix: first, lineNum: "", content: line.slice(1) };
}

function diffRow(row: DiffLine, body: string, theme: Theme): GutterTextRow {
	const context = row.prefix === " ";
	const color = context ? "toolDiffContext" : row.prefix === "-" ? "toolDiffRemoved" : "toolDiffAdded";
	const style = { fg: color, ...(!context ? { dim: true } : {}) } as const;
	const marker = `${row.prefix}${row.lineNum}`;
	return {
		gutter: theme.style(`${marker}${row.lineNum ? " " : ""}`, style),
		compactGutter: theme.style(`${row.prefix}${row.lineNum ? " " : ""}`, style),
		text: context ? theme.fg("toolDiffContext", row.content) : body,
	};
}

function diffRows(diffText: string, options: RenderDiffOptions = {}): GutterTextRow[] {
	if (
		typeof options.lineNumbers === "number" &&
		(!Number.isInteger(options.lineNumbers) || options.lineNumbers < 2 || options.lineNumbers > 100)
	) {
		throw new Error("Diff gutter width must be an integer between 2 and 100");
	}
	const lines = diffText.split("\n");
	const theme = options.theme ?? activeTheme;
	const rows = lines.map((line) => parseDiffLine(line.replace(/\t/g, "   "), options.lineNumbers));
	const syntax = highlightDiffLines(
		rows,
		options.language ?? (options.filePath ? getLanguageFromPath(options.filePath) : undefined),
		theme,
	);
	const result: GutterTextRow[] = lines.map((line, i) => {
		const row = rows[i];
		if (!row) return { text: theme.fg("toolDiffContext", line.replace(/\t/g, "   ")) };
		return diffRow(row, syntax[i], theme);
	});

	for (let i = 0; i < rows.length - 1; i++) {
		if (
			rows[i]?.prefix === "-" &&
			rows[i + 1]?.prefix === "+" &&
			rows[i - 1]?.prefix !== "-" &&
			rows[i + 2]?.prefix !== "+"
		) {
			const removed = rows[i]!;
			const added = rows[i + 1]!;
			const changed = highlightChangedWords(removed.content, added.content, syntax[i], syntax[i + 1]);
			result[i] = diffRow(removed, changed[0], theme);
			result[i + 1] = diffRow(added, changed[1], theme);
			i++;
		}
	}
	return result;
}

/** Render a diff with grammar-preserving syntax and changed-word highlighting. */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const rows = diffRows(diffText, options);
	return rows.map((row) => `${row.gutter ?? ""}${row.text}`).join("\n");
}

export class Diff implements Component {
	private readonly diffText: string;
	private readonly options: DiffOptions;
	private cached: GutterText | undefined;

	constructor(diffText: string, options: DiffOptions = {}) {
		this.diffText = diffText;
		this.options = options;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (!this.cached) {
			const rows = diffRows(this.diffText, this.options);
			const theme = this.options.theme ?? activeTheme;
			const visibleRows = this.options.visibleLines?.map((index) => {
				if (index === null) return { text: theme.fg("dim", "…") };
				if (!Number.isInteger(index) || index < 0 || index >= rows.length)
					throw new Error("Diff preview line index is out of bounds");
				return rows[index];
			});
			this.cached = new GutterText(visibleRows ?? rows, this.options.wrap);
		}
		return this.cached.render(width);
	}
}
