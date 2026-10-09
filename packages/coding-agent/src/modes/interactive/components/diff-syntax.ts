import * as Diff from "diff";
import { highlightCode, type Theme } from "../theme/theme.ts";

export interface DiffLine {
	prefix: string;
	lineNum: string;
	content: string;
}

export function highlightDiffLines(
	lines: Array<DiffLine | null>,
	language: string | undefined,
	theme: Theme,
): string[] {
	const result = new Array<string>(lines.length);
	let start = 0;
	while (start < lines.length) {
		if (!lines[start]) {
			start++;
			continue;
		}
		let end = start;
		while (end < lines.length && lines[end]) end++;
		for (const [prefix, tone] of [
			["-", "removed"],
			["+", "added"],
		] as const) {
			const indices: number[] = [];
			for (let i = start; i < end; i++) {
				if (lines[i]!.prefix !== (prefix === "-" ? "+" : "-")) indices.push(i);
			}
			const source = indices.map((i) => lines[i]!.content).join("\n");
			const styled = highlightCode(source, language, { theme, diff: tone });
			for (let i = 0; i < indices.length; i++) {
				const index = indices[i];
				if (lines[index]!.prefix === prefix) result[index] = styled[i];
			}
		}
		start = end;
	}
	return result;
}

function invertParts(styled: string, parts: Diff.Change[], removed: boolean): string {
	const ranges: Array<[number, number]> = [];
	let offset = 0;
	let first = true;
	for (const part of parts) {
		if (removed ? part.added : part.removed) continue;
		if (removed ? part.removed : part.added) {
			const whitespace = first ? (part.value.match(/^\s*/)?.[0].length ?? 0) : 0;
			first = false;
			if (whitespace < part.value.length) ranges.push([offset + whitespace, offset + part.value.length]);
		}
		offset += part.value.length;
	}
	let result = "";
	let position = 0;
	let range = 0;
	for (const chunk of styled.split(/(\x1b\[[\d;]*m)/)) {
		if (chunk.startsWith("\x1b")) {
			result += chunk;
			continue;
		}
		for (const char of chunk) {
			if (ranges[range]?.[0] === position) result += "\x1b[7m";
			result += char;
			position += char.length;
			if (ranges[range]?.[1] === position) {
				result += "\x1b[27m";
				range++;
			}
		}
	}
	return result;
}

export function highlightChangedWords(
	oldContent: string,
	newContent: string,
	removed: string,
	added: string,
): [string, string] {
	if (oldContent.length + newContent.length > 16_000) return [removed, added];
	const parts = Diff.diffWordsWithSpace(oldContent, newContent);
	return [invertParts(removed, parts, true), invertParts(added, parts, false)];
}
