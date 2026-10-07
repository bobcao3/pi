import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CodemodeJsonSchema, CodemodeOutputItem } from "@earendil-works/pi-codemode";
import { mcpStructuredContentSchema } from "@earendil-works/pi-codemode/declarations";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import type { CodemodeToolDetails } from "./tool.ts";

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

export function trackCodemodeOutput() {
	const typed = new WeakMap<TextContent, Extract<CodemodeOutputItem, { type: "json" }>>();
	return {
		isStructured(content: TextContent | ImageContent): boolean {
			return content.type === "text" && typed.has(content);
		},
		toContent(item: CodemodeOutputItem): TextContent | ImageContent {
			if (item.type === "image") return item;
			const content: TextContent = { type: "text", text: item.text };
			if (item.type === "json") typed.set(content, item);
			return content;
		},
		collect(
			content: readonly (TextContent | ImageContent)[],
		): Pick<CodemodeToolDetails, "output" | "outputMetadataLimited"> {
			const details: Pick<CodemodeToolDetails, "output" | "outputMetadataLimited"> = {};
			const metadata: Record<number, CodemodeOutputMetadata> = {};
			let characters = 262144;
			let count = 0;
			for (const [index, block] of content.entries()) {
				const item = block.type === "text" ? typed.get(block) : undefined;
				if (!item) continue;
				const size = item.text.length + (JSON.stringify(item.schema)?.length ?? 0);
				if (count >= 1024 || size > characters) {
					details.outputMetadataLimited = true;
					continue;
				}
				characters -= size;
				count++;
				metadata[index] = {
					type: "json",
					textHash: createHash("sha256").update(item.text).digest("hex"),
					...(item.schema === undefined ? {} : { schema: item.schema }),
				};
			}
			if (count) details.output = metadata;
			return details;
		},
	};
}
