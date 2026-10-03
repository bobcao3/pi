import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CodemodeJsonSchema, CodemodeOutputItem, CodemodeResult } from "@earendil-works/pi-codemode";
import { mcpStructuredContentSchema } from "@earendil-works/pi-codemode/declarations";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import type { CodemodeNestedCall, CodemodeToolDetails } from "./tool.ts";

export interface CodemodeOutputMetadata {
	type: "json";
	textHash: string;
	schema?: CodemodeJsonSchema;
}

export function formatCodemodeOutput(text: string, metadata?: CodemodeOutputMetadata): string {
	if (
		metadata?.type !== "json" ||
		mcpStructuredContentSchema(metadata.schema) === undefined ||
		text.length > 262144 ||
		createHash("sha256").update(text).digest("hex") !== metadata.textHash
	)
		return text;
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) return text;
		const result = value as CallToolResult;
		if (!Array.isArray(result.content)) return text;
		const content = toLlmContent(result);
		if (result.content.length > 0 && result.structuredContent !== undefined) {
			content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
		}
		if (content.some((block) => block.type === "text" && typeof block.text !== "string")) return text;
		return (
			(result.isError === true ? "[MCP error]\n" : "") +
			content.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`)).join("\n")
		);
	} catch {
		return text;
	}
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	const summary =
		calls.length === 0
			? "No tool calls were made."
			: `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
	return `${head}\n\n${summary}`;
}

async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<{
	items: (TextContent | ImageContent)[];
	truncated: boolean;
	fullOutputPath?: string;
}> {
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	const combined = texts.join("\n");
	const budget = maxTokens * 4;
	if (texts.length === 0 || combined.length <= budget) return { items, truncated: false };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / 4)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / 4)} tokens truncated…${tail}`;
	let fullOutputPath: string | undefined;
	try {
		const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
		await writeFile(path, combined);
		fullOutputPath = path;
		text += `\n\n[Full output: ${path} (read with offset/limit)]`;
	} catch (error) {
		text += `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		truncated: true,
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

export async function buildCodemodeOutput(
	result: CodemodeResult,
	calls: readonly CodemodeNestedCall[],
	generatedImages: number,
	maxTokens = 10000,
): Promise<{
	content: (TextContent | ImageContent)[];
	details: Pick<CodemodeToolDetails, "output" | "outputMetadataLimited" | "fullOutputPath">;
}> {
	const output: CodemodeOutputItem[] = [...result.output];
	if (result.ok && result.value !== undefined) {
		output.push(
			typeof result.value === "string"
				? { type: "text", text: result.value }
				: {
						type: "json",
						text: JSON.stringify(result.value) ?? String(result.value),
						...(result.valueSchema === undefined ? {} : { schema: result.valueSchema }),
					},
		);
	} else if (!result.ok) {
		output.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	}
	if (generatedImages > 0 && !output.some((item) => item.type === "image")) {
		output.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generatedImages} image${generatedImages === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	}
	const items: (TextContent | ImageContent)[] = output.map((item) =>
		item.type === "image" ? item : { type: "text", text: item.text },
	);
	const truncated = await truncateOutput(items, maxTokens);
	const details: Pick<CodemodeToolDetails, "output" | "outputMetadataLimited" | "fullOutputPath"> = {};
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	if (!truncated.truncated) {
		const metadata: Record<number, CodemodeOutputMetadata> = {};
		let characters = 262144;
		let count = 0;
		for (const [index, item] of output.entries()) {
			if (item.type !== "json") continue;
			const size = item.text.length + (JSON.stringify(item.schema)?.length ?? 0);
			if (count >= 1024 || size > characters) {
				details.outputMetadataLimited = true;
				continue;
			}
			characters -= size;
			count++;
			metadata[index + 1] = {
				type: "json",
				textHash: createHash("sha256").update(item.text).digest("hex"),
				...(item.schema === undefined ? {} : { schema: item.schema }),
			};
		}
		if (count) details.output = metadata;
	}
	return { content: truncated.items, details };
}
