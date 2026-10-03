import type { JsonValue } from "@earendil-works/pi-ai";
import { type CodemodeJsonSchema, mcpStructuredContentSchema } from "@earendil-works/pi-codemode";
import type { TSchema } from "typebox";

export function getStructuredToolOutput(
	schema: TSchema | undefined,
	value: JsonValue | undefined,
): JsonValue | undefined {
	if (schema === undefined) return undefined;
	if (mcpStructuredContentSchema(schema as CodemodeJsonSchema) === undefined) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return Object.getOwnPropertyDescriptor(value, "structuredContent")?.value as JsonValue | undefined;
}
