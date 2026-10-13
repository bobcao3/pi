import { readFile, rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import { formatCodemodeOutput } from "../src/extensions/codemode/output.ts";
import type { CodemodeToolDetails } from "../src/extensions/codemode/tool.ts";
import { createMcpResultSchema } from "../src/extensions/mcp/tools.ts";
import { createHarness, getToolResult } from "./suite/harness.ts";

const image = "iVBORw0KGgo=";

test("output replay uses emitted types and schemas without changing model content or decoding identical literal strings", async () => {
	const body = '### Result\n{"bounds":{"width":390}}\n```js\nconst path = "C:\\\\tmp";\n```';
	const value = {
		content: [
			{ type: "text", text: body },
			{ type: "resource_link", name: "report", uri: "file:///report.json" },
			{ type: "image", data: image, mimeType: "image/png" },
		],
		structuredContent: { width: 390 },
		isError: true,
	} as const;
	const displayed = `[MCP error]\n${body}\nreport: file:///report.json\n[image image/png]\n{\n  "width": 390\n}`;
	const schema = createMcpResultSchema(undefined);
	const harness = await createHarness({
		initialActiveToolNames: ["codemode"],
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "browser",
					label: "Browser",
					description: "Return an MCP result",
					exposure: "codemode",
					parameters: Type.Object({}),
					outputSchema: schema,
					execute: async () => ({ content: [], details: undefined, structuredContent: value }),
				});
			},
		],
	});
	const files = new Set<string>();
	const run = async (prefix = "") => {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `${prefix}
				const response = await tools.browser({});
				text(response);
				image("data:image/png;base64,${image}");
				text(JSON.stringify(response));
				console.log("debug");
				return response;
			`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Run the script");
		const output = getToolResult(harness, "codemode");
		const details = output.details as unknown as CodemodeToolDetails;
		if (details.fullOutputPath) files.add(details.fullOutputPath);
		for (const block of output.content) {
			if (block.type !== "text") continue;
			const path = /^\n?\[Image saved to (.+) \(image\/png, \d+B\)\]$/.exec(block.text)?.[1];
			if (path) {
				files.add(path);
				expect((await readFile(path)).toString("base64")).toBe(image);
			}
		}
		return { ...output, details };
	};
	try {
		const output = await run();
		expect(output.isError).toBe(false);
		const serialized = JSON.stringify(value);
		expect(output.content.slice(1)).toEqual([
			{ type: "text", text: "==> text 1/3 <==\n" },
			{ type: "text", text: serialized },
			{ type: "text", text: expect.stringMatching(/^\n\[Image saved to .*\]$/) },
			{ type: "image", data: image, mimeType: "image/png" },
			{ type: "text", text: `==> text 2/3 <==\n${serialized}\n==> text 3/3 <==\n` },
			{ type: "text", text: serialized },
			{ type: "text", text: "\n<console_output>\ndebug\n</console_output>" },
		]);
		const replay = JSON.parse(JSON.stringify(output)) as typeof output;
		expect(replay.details.output?.[2].schema).toEqual(schema);
		expect(replay.details.output?.[5]).toBeUndefined();
		expect(formatCodemodeOutput(serialized, replay.details.output?.[2])).toBe(displayed);
		expect(formatCodemodeOutput(serialized, replay.details.output?.[5])).toBe(serialized);
		expect(formatCodemodeOutput(serialized, replay.details.output?.[6])).toBe(displayed);
		const redacted = JSON.stringify({ content: [{ type: "text", text: "replacement" }] });
		expect(formatCodemodeOutput(redacted, replay.details.output?.[2])).toBe(redacted);
		const truncated = await run('// @options: {"max_output_tokens": 1}\n');
		expect(truncated.details.output).toBeUndefined();
		expect(truncated.details.fullOutputPath).toBeDefined();
		const spilled = await readFile(truncated.details.fullOutputPath!, "utf8");
		expect(spilled.split(serialized)).toHaveLength(4);
		for (const index of [1, 2, 3]) expect(spilled).toContain(`==> text ${index}/3 <==`);
		expect(spilled).toContain("<console_output>\ndebug\n</console_output>");
	} finally {
		harness.cleanup();
		await Promise.all([...files].map((path) => rm(path, { force: true })));
	}
});

test("typed output retains bounded metadata and keeps failed scripts' earlier structured values", async () => {
	const harness = await createHarness({
		initialActiveToolNames: ["codemode"],
		extensionFactories: [createCodemodeExtension()],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: '// @options: {"max_output_tokens": 50000}\nfor (let i = 0; i < 1100; i++) text({index:i}); throw new Error("after output");',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Run the script");
		const output = getToolResult(harness, "codemode");
		const details = output.details as unknown as CodemodeToolDetails;
		expect(output.isError).toBe(true);
		expect(details.outputMetadataLimited).toBe(true);
		expect(Object.keys(details.output ?? {}).length).toBeLessThan(1100);
		expect(details.output?.[2].type).toBe("json");
		expect(output.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("after output") });
	} finally {
		harness.cleanup();
	}
});
