import { type Component, Markdown, type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";

export interface CollapsibleMarkdownOptions {
	/** Markdown source. */
	markdown: string;
	/** Visual lines shown while collapsed. */
	collapsedLines: number;
	paddingX: number;
	paddingY: number;
	theme: MarkdownTheme;
	expanded: boolean;
	/** Styled hint for the number of visual lines the preview hides. */
	formatHint: (hidden: number) => string;
}

/**
 * Markdown that hides everything past `collapsedLines` visual lines until expanded, matching how collapsed
 * tool output reveals itself through `setExpanded`. The startup changelog uses it so a version jump cannot
 * fill the first screen.
 */
export class CollapsibleMarkdown implements Component {
	private readonly markdown: Markdown;
	private readonly options: CollapsibleMarkdownOptions;
	private expanded: boolean;

	constructor(options: CollapsibleMarkdownOptions) {
		this.options = options;
		this.expanded = options.expanded;
		this.markdown = new Markdown(options.markdown, options.paddingX, options.paddingY, options.theme);
	}

	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.invalidate();
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		if (this.expanded || lines.length <= this.options.collapsedLines) {
			return lines;
		}
		const hidden = lines.length - this.options.collapsedLines;
		return [
			...lines.slice(0, this.options.collapsedLines),
			truncateToWidth(this.options.formatHint(hidden), width, "..."),
		];
	}
}
