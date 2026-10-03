import type { Component } from "@earendil-works/pi-tui";
import type { UsageTotals } from "./usage-totals.ts";

export interface FooterContent {
	project: string;
	model: string;
	thinkingLevel?: string;
	routedModel?: { id: string; thinkingLevel?: string };
	provider: string | undefined;
	usage: Readonly<UsageTotals>;
	cacheHitRate: number | undefined;
	contextWindow: number;
	contextPercent: number | null;
	experimental: boolean;
}

export interface ReadonlyFooter extends Component {
	getContent(): FooterContent;
}
