import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function createTool(): ToolDefinition {
	return {
		name: "html_tree_tool",
		label: "html_tree_tool",
		description: "tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		renderTree: () => [
			{
				id: "root<&",
				label: "Root <script>",
				summary: "Summary & more",
				metadata: ["meta > value"],
				defaultOpen: true,
				content: { text: "body <b>unsafe</b>", format: "code", language: 'ts"x' },
				children: [{ id: "child", label: "Child", content: { text: "plain & text" } }],
			},
		],
	};
}

describe("tool tree HTML rendering", () => {
	test("renders escaped semantic native details without call header duplication", () => {
		initTheme("dark");
		const tool = createTool();
		const renderer = createToolHtmlRenderer({
			getToolRenderers: () => tool,
			theme,
			cwd: process.cwd(),
		});

		expect(renderer.hasTreeRenderer("html_tree_tool")).toBe(true);
		expect(renderer.renderCall("call-1", "html_tree_tool", { path: "<unsafe>" })).toBeUndefined();
		const rendered = renderer.renderResult(
			"call-1",
			"html_tree_tool",
			[{ type: "text", text: "done" }],
			undefined,
			false,
		);

		expect(rendered?.collapsed).toBeUndefined();
		expect(rendered?.expanded).toContain("<details");
		expect(rendered?.expanded).toContain("<summary>");
		expect(rendered?.expanded).toContain("Root &lt;script&gt;");
		expect(rendered?.expanded).toContain("Summary &amp; more");
		expect(rendered?.expanded).toContain("meta &gt; value");
		expect(rendered?.expanded).toContain("body &lt;b&gt;unsafe&lt;/b&gt;");
		expect(rendered?.expanded).not.toContain("<script>");
		expect(rendered?.expanded).not.toContain("tool-header");
	});
});
