import type { JsonValue } from "@earendil-works/pi-ai";
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import type { TSchema } from "typebox";

export function isMcpToolOutputSchema(schema: CodemodeJsonSchema | undefined): boolean {
	const properties = (typeof schema === "object" ? schema?.properties : undefined) as
		| Record<string, { type?: string; items?: { type?: string } }>
		| undefined;
	return (
		properties?.content?.type === "array" &&
		properties.content.items?.type === "object" &&
		properties.isError?.type === "boolean"
	);
}

export function getStructuredToolOutput(
	schema: TSchema | undefined,
	value: JsonValue | undefined,
): JsonValue | undefined {
	if (schema === undefined) return undefined;
	if (!isMcpToolOutputSchema(schema as CodemodeJsonSchema)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return Object.getOwnPropertyDescriptor(value, "structuredContent")?.value as JsonValue | undefined;
}
