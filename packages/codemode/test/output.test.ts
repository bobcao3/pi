import { expect, test } from "vitest";
import { type CodemodeJsonSchema, CodemodeSandbox } from "../src/index.ts";

test("typed output retains each tool schema across the worker without attributing schemas to strings, copies, or mutations", async () => {
	const firstSchema = {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			isError: { type: "boolean" },
			_meta: { type: "object" },
		},
	};
	const secondSchema = { type: "object", additionalProperties: true };
	const value = { content: [{ type: "text", text: "first line\nsecond line" }] };
	const sandbox = new CodemodeSandbox({
		tools: [
			{ name: "first", outputSchema: firstSchema, execute: () => value },
			{ name: "second", outputSchema: secondSchema, execute: () => value },
		],
	});
	try {
		const result = await sandbox.execute(`
			const [first, second] = await Promise.all([tools.first(), tools.second()]);
			text(first);
			text(JSON.stringify(first));
			text(second);
			text({...first});
			first.content[0].text = "changed";
			text(first);
			text(null); text(false); text([1, "2"]);
			return second;
		`);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toEqual(value);
		expect(result.valueSchema).toEqual(secondSchema);
		expect(result.output).toEqual([
			{ type: "json", text: JSON.stringify(value), schema: firstSchema },
			{ type: "text", text: JSON.stringify(value) },
			{ type: "json", text: JSON.stringify(value), schema: secondSchema },
			{ type: "json", text: JSON.stringify(value) },
			{ type: "json", text: '{"content":[{"type":"text","text":"changed"}]}' },
			{ type: "json", text: "null" },
			{ type: "json", text: "false" },
			{ type: "json", text: '[1,"2"]' },
		]);
	} finally {
		await sandbox.close();
	}
});

test("untransportable schema metadata does not prevent a tool from executing or discard its typed output", async () => {
	const cyclic: Record<string, unknown> = { type: "object" };
	cyclic.self = cyclic;
	for (const schema of [cyclic, { type: "object", description: "x".repeat(300000) }]) {
		const sandbox = new CodemodeSandbox({
			tools: [
				{
					name: "value",
					outputSchema: schema as CodemodeJsonSchema,
					execute: () => ({ accepted: true }),
				},
			],
		});
		try {
			const result = await sandbox.execute("const value = await tools.value(); text(value); return value;");
			expect(result).toMatchObject({
				ok: true,
				value: { accepted: true },
				calls: [{ name: "value", status: "ok" }],
			});
			expect(result.output).toEqual([{ type: "json", text: '{"accepted":true}' }]);
		} finally {
			await sandbox.close();
		}
	}
});
