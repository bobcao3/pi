import { expect, test } from "vitest";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeSandboxBaseOptions,
	InlineCodemodeSandbox,
	loadQuickJSWasm,
	RemoteCodemodeSandbox,
	serveCodemodeRemote,
} from "../src/index.ts";

function makeSandbox(backend: string, options: CodemodeSandboxBaseOptions) {
	if (backend === "worker") return new CodemodeSandbox(options);
	if (backend === "inline") return new InlineCodemodeSandbox({ ...options, wasm: loadQuickJSWasm() });
	return new RemoteCodemodeSandbox({
		...options,
		remote: () => ({
			execute: (request, exchange) =>
				serveCodemodeRemote(
					structuredClone(request),
					async (messages) => structuredClone(await exchange(structuredClone(messages))),
					{ wasm: loadQuickJSWasm() },
				),
		}),
	});
}

test.each(["worker", "inline", "remote"])(
	"%s output retains each tool schema without attributing schemas to strings, copies, or mutations",
	async (backend) => {
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
		const sandbox = makeSandbox(backend, {
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
			expect(result.ok, JSON.stringify(result)).toBe(true);
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
	},
);

test.each(["worker", "inline", "remote"])(
	"%s untransportable schema metadata does not prevent a tool from executing or discard its typed output",
	async (backend) => {
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.self = cyclic;
		for (const schema of [cyclic, { type: "object", description: "x".repeat(300000) }]) {
			const sandbox = makeSandbox(backend, {
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
				expect(result, JSON.stringify(result)).toMatchObject({
					ok: true,
					value: { accepted: true },
					calls: [{ name: "value", status: "ok" }],
				});
				expect(result.output).toEqual([{ type: "json", text: '{"accepted":true}' }]);
			} finally {
				await sandbox.close();
			}
		}
	},
);
