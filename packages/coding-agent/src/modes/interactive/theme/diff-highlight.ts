import { colorToOkhsl, okhslColor } from "@earendil-works/pi-tui";
import type { HighlightTheme } from "../../../utils/syntax-highlight.ts";
import type { Theme } from "./theme.ts";

export type DiffTone = "added" | "removed";

export function diffHighlightTheme(theme: Theme, tone: DiffTone): HighlightTheme {
	const token = tone === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	const base = colorToOkhsl(theme.colors[token]);
	const direction = theme.appearance === "dark" ? 1 : -1;
	const formatter = (hue: number, lightness: number, bold = false, italic = false) => {
		const color = okhslColor(base.h + hue, base.s, Math.max(0, Math.min(1, base.l + direction * lightness)));
		return (text: string) => theme.style(text, { fg: color, bold, italic });
	};
	const plain = (text: string) => theme.fg(token, text);
	const keyword = formatter(-14, 0.07, true);
	const title = formatter(14, 0.04, true);
	const string = formatter(22, 0.025);
	const number = formatter(-22, 0.05);
	const comment = formatter(0, 0, false, true);
	return {
		default: plain,
		keyword,
		name: keyword,
		built_in: title,
		class: title,
		type: title,
		function: title,
		title,
		literal: number,
		number,
		regexp: string,
		string,
		comment,
		doctag: comment,
		meta: comment,
		variable: plain,
		params: plain,
		attr: plain,
		subst: plain,
		operator: formatter(-7, 0.025, true),
		punctuation: plain,
		tag: plain,
		emphasis: formatter(0, 0, false, true),
		strong: formatter(0, 0, true),
		link: plain,
	};
}
