import { readFile, rm } from "node:fs/promises";
import { type CodemodeJsonSchema, CodemodeSandbox } from "@earendil-works/pi-codemode";
import { expect, test } from "vitest";
import { buildCodemodeOutput, formatCodemodeOutput } from "../src/extensions/codemode/output.ts";
import { createMcpResultSchema } from "../src/extensions/mcp/tools.ts";

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
	};
	const displayed = `[MCP error]\n${body}\nreport: file:///report.json\n[image image/png]\n{\n  "width": 390\n}`;
	const schema = createMcpResultSchema(undefined) as CodemodeJsonSchema;
	const sandbox = new CodemodeSandbox({ tools: [{ name: "browser", outputSchema: schema, execute: () => value }] });
	try {
		const result = await sandbox.execute(`
			const response = await tools.browser({});
			text(response);
			image("data:image/png;base64,${image}");
			text(JSON.stringify(response));
			return response;
		`);
		expect(result.ok).toBe(true);
		const output = await buildCodemodeOutput(result, [], 0);
		const serialized = JSON.stringify(value);
		expect(output.content).toEqual([
			{ type: "text", text: serialized },
			{ type: "image", data: image, mimeType: "image/png" },
			{ type: "text", text: serialized },
			{ type: "text", text: serialized },
		]);
		const replay = JSON.parse(JSON.stringify(output)) as typeof output;
		expect(replay.details.output?.[1].schema).toEqual(schema);
		expect(replay.details.output?.[3]).toBeUndefined();
		expect(formatCodemodeOutput(serialized, replay.details.output?.[1])).toBe(displayed);
		expect(formatCodemodeOutput(serialized, replay.details.output?.[3])).toBe(serialized);
		expect(formatCodemodeOutput(serialized, replay.details.output?.[4])).toBe(displayed);
		const redacted = JSON.stringify({ content: [{ type: "text", text: "replacement" }] });
		expect(formatCodemodeOutput(redacted, replay.details.output?.[1])).toBe(redacted);
		const truncated = await buildCodemodeOutput(result, [], 0, 1);
		expect(truncated.details.output).toBeUndefined();
		expect(truncated.details.fullOutputPath).toBeDefined();
		try {
			expect(await readFile(truncated.details.fullOutputPath!, "utf8")).toBe(
				[serialized, serialized, serialized].join("\n"),
			);
		} finally {
			await rm(truncated.details.fullOutputPath!, { force: true });
		}
	} finally {
		await sandbox.close();
	}
});

test("typed output retains bounded metadata and keeps failed scripts' earlier structured values", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const result = await sandbox.execute(
			'for (let i = 0; i < 1100; i++) text({index:i}); throw new Error("after output");',
		);
		expect(result.ok).toBe(false);
		const output = await buildCodemodeOutput(result, [], 0);
		expect(output.details.outputMetadataLimited).toBe(true);
		expect(Object.keys(output.details.output ?? {}).length).toBeLessThan(output.content.length - 1);
		expect(output.details.output?.[1].type).toBe("json");
		expect(output.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("after output") });
	} finally {
		await sandbox.close();
	}
});
