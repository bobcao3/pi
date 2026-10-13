import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentEvent } from "./types.ts";

export type RuntimePhase = "harness" | "api" | "tool";
export interface RuntimeScope {
	id: number;
	phase: RuntimePhase;
	label: string;
	startedAt: number;
}
export interface RuntimeTiming {
	phase: RuntimePhase;
	label: string;
	count: number;
	totalMs: number;
	maxMs: number;
	maxSyncMs?: number;
}
export interface RuntimeSnapshot {
	active: readonly RuntimeScope[];
	running: boolean;
	awaitingEvent: boolean;
	request?: {
		startedAt: number;
		lastEventAt?: number;
		mode?: "Thinking" | "Writing reply" | "Writing tool call";
		charsPerSecond?: number;
		finished: boolean;
		averageTps?: number;
	};
	timings: readonly RuntimeTiming[];
	droppedScopes: number;
	lastBlock?: { label: string; durationMs: number; at: number };
}

export class RuntimeActivity {
	private readonly active = new Map<number, RuntimeScope>();
	private readonly timings = new Map<string, RuntimeTiming>();
	private readonly listeners = new Set<() => void>();
	private sequence = 0;
	private running = false;
	private awaitingEvent = false;
	private droppedScopes = 0;
	private request: RuntimeSnapshot["request"];
	private samples: { at: number; chars: number }[] = [];
	private firstDeltaAt: number | undefined;
	private lastBlock: RuntimeSnapshot["lastBlock"];

	subscribe(listener: () => void): () => void {
		if (this.listeners.size >= 32) throw new Error("Runtime activity listener limit exceeded");
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	begin(phase: RuntimePhase, label: string): () => void {
		if (this.active.size >= 1024) {
			this.droppedScopes++;
			return () => {};
		}
		const scope = { id: ++this.sequence, phase, label: label.slice(0, 512), startedAt: performance.now() };
		this.active.set(scope.id, scope);
		this.changed();
		return () => {
			if (!this.active.delete(scope.id)) return;
			const elapsed = performance.now() - scope.startedAt;
			const key = `${phase}:${scope.label}`;
			const timing = this.timings.get(key) ?? { phase, label: scope.label, count: 0, totalMs: 0, maxMs: 0 };
			timing.count++;
			timing.totalMs += elapsed;
			timing.maxMs = Math.max(timing.maxMs, elapsed);
			if (!this.timings.has(key) && this.timings.size >= 128) this.timings.delete(this.timings.keys().next().value!);
			this.timings.set(key, timing);
			this.changed();
		};
	}

	requestStarted(): void {
		this.request = { startedAt: performance.now(), finished: false };
		this.samples = [];
		this.firstDeltaAt = undefined;
		this.awaitingEvent = false;
		this.changed();
	}

	streamEvent(event: AssistantMessageEvent): void {
		if (!this.request) return;
		const now = performance.now();
		this.request.lastEventAt = now;
		if (event.type === "thinking_start" || event.type === "thinking_delta") this.request.mode = "Thinking";
		if (event.type === "text_start" || event.type === "text_delta") this.request.mode = "Writing reply";
		if (event.type === "toolcall_start" || event.type === "toolcall_delta") this.request.mode = "Writing tool call";
		if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
			this.firstDeltaAt ??= now;
			let chars = 0;
			for (const _character of event.delta) chars++;
			const last = this.samples.at(-1);
			if (last && now - last.at < 100) last.chars += chars;
			else this.samples.push({ at: now, chars });
			if (this.samples.length > 32) this.samples.shift();
		}
		if (event.type === "done" || event.type === "error") {
			this.request.finished = true;
			const message = event.type === "done" ? event.message : event.error;
			const duration = message.durationMs ?? now - this.request.startedAt;
			if (duration > 0 && message.usage.output > 0)
				this.request.averageTps = (message.usage.output * 1000) / duration;
		}
		this.changed();
	}

	handleEvent(event: AgentEvent): void {
		if (event.type === "agent_start") {
			this.running = true;
			this.awaitingEvent = false;
		}
		if (
			event.type === "tool_execution_end" &&
			!event.isError &&
			event.result?.terminate &&
			event.result.awaitingEvent
		)
			this.awaitingEvent = true;
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		)
			this.awaitingEvent = false;
		this.changed();
	}

	finishRun(): void {
		this.running = false;
		this.changed();
	}

	recordBlock(label: string, durationMs: number): void {
		if (durationMs <= 150) return;
		const current = [...this.active.values()].at(-1);
		if (current) {
			const key = `${current.phase}:${current.label}`;
			const timing = this.timings.get(key) ?? {
				phase: current.phase,
				label: current.label,
				count: 0,
				totalMs: 0,
				maxMs: 0,
			};
			timing.maxSyncMs = Math.max(timing.maxSyncMs ?? 0, durationMs);
			if (!this.timings.has(key) && this.timings.size >= 128) this.timings.delete(this.timings.keys().next().value!);
			this.timings.set(key, timing);
		}
		const now = performance.now();
		if (!this.lastBlock || now - this.lastBlock.at > 10)
			this.lastBlock = { label: label.slice(0, 512), durationMs, at: now };
		this.changed();
	}

	snapshot(now = performance.now(), includeTimings = true): RuntimeSnapshot {
		const request = this.request ? { ...this.request } : undefined;
		if (request && !request.finished && this.firstDeltaAt !== undefined) {
			const chars = this.samples.reduce((sum, sample) => sum + (now - sample.at <= 2000 ? sample.chars : 0), 0);
			request.charsPerSecond = (chars * 1000) / Math.max(100, Math.min(2000, now - this.firstDeltaAt));
		}
		return {
			active: [...this.active.values()],
			running: this.running,
			awaitingEvent: this.awaitingEvent,
			request,
			timings: includeTimings ? [...this.timings.values()].map((timing) => ({ ...timing })) : [],
			droppedScopes: this.droppedScopes,
			lastBlock: this.lastBlock ? { ...this.lastBlock } : undefined,
		};
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}

export async function runActivity<T>(
	activity: RuntimeActivity | undefined,
	phase: RuntimePhase,
	label: string,
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const finish = activity?.begin(phase, label);
	try {
		const started = performance.now();
		let result: T | PromiseLike<T>;
		try {
			result = run();
		} finally {
			activity?.recordBlock(label, performance.now() - started);
		}
		return await result;
	} finally {
		finish?.();
	}
}
