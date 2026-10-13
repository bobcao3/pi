export const COMPACT_WIDTH_THRESHOLD = 80;

export function isCompactWidth(width: number): boolean {
	return width < COMPACT_WIDTH_THRESHOLD;
}
