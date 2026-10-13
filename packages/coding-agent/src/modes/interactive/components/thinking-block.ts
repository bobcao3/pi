import { Box, HStack, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

export class ThinkingBlock extends Box {
	constructor(
		text: string,
		hidden: boolean,
		label: string,
		markdown_theme: MarkdownTheme,
		streaming: boolean,
		transformers: readonly MarkdownTransformer[],
	) {
		super(0, 0);
		const body = hidden
			? new Text(theme.fg("thinkingText", label), 0, 0)
			: new Markdown(
					text,
					0,
					0,
					{ ...markdown_theme, italic: (value) => value },
					{ color: (value) => theme.fg("thinkingText", value) },
					{ transform: createMarkdownTransform("assistant-thinking", streaming, transformers) },
				);
		this.addChild(
			new HStack([
				{ component: new Text(theme.fg("thinkingText", "💡"), 0, 0), basis: 3, shrink: 0 },
				{ component: body, basis: 0, grow: 1 },
			]),
		);
	}
}
