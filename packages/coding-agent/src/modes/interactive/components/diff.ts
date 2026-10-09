import { theme as activeTheme, getLanguageFromPath, type Theme } from "../theme/theme.ts";
import { type DiffLine, highlightChangedWords, highlightDiffLines } from "./diff-syntax.ts";

export interface RenderDiffOptions {
	filePath?: string;
	language?: string;
	theme?: Theme;
	lineNumbers?: boolean | number;
}

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

function changedLine(row: DiffLine, body: string, theme: Theme): string {
	const color = row.prefix === "-" ? "toolDiffRemoved" : "toolDiffAdded";
	const prefix = `${row.prefix}${row.lineNum}${row.lineNum ? " " : ""}`;
	return theme.style(prefix, { fg: color, dim: true }) + body;
}

/** Render a diff with grammar-preserving syntax and changed-word highlighting. */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
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
	const result = lines.map((line, i) => {
		const row = rows[i];
		if (!row) return theme.fg("toolDiffContext", line.replace(/\t/g, "   "));
		return row.prefix === " "
			? theme.fg("toolDiffContext", line.replace(/\t/g, "   "))
			: changedLine(row, syntax[i], theme);
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
			result[i] = changedLine(removed, changed[0], theme);
			result[i + 1] = changedLine(added, changed[1], theme);
			i++;
		}
	}
	return result.join("\n");
}
