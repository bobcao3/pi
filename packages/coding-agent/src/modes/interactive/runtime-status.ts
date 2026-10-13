import type { RuntimeActivity, RuntimeSnapshot } from "@earendil-works/pi-agent-core";

const INTERVAL_MS = 100;
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

export function formatRuntimeStatus(snapshot: RuntimeSnapshot, now = performance.now()): string | undefined {
	const current = snapshot.active.at(-1);
	const request = snapshot.request;
	let label: string;
	if (current?.phase === "api") {
		const age = now - (request?.lastEventAt ?? current.startedAt);
		if (request?.mode && !request.finished && age < 2000) {
			const speed =
				request.charsPerSecond === undefined ? "rate unavailable" : `${request.charsPerSecond.toFixed(0)} ch/s`;
			label = `${request.mode} · ${speed} · ${seconds(now - request.startedAt)}`;
		} else {
			label = `${request?.mode ? "Waiting for API stream" : "Waiting for API response"} · ${seconds(age)}`;
		}
	} else if (current?.phase === "tool") {
		return undefined;
	} else if (current) {
		label = `Waiting on harness · ${current.label} · ${seconds(now - current.startedAt)}`;
	} else if (snapshot.running) {
		label = "Preparing next step";
	} else if (snapshot.awaitingEvent) {
		label = "Waiting for your input or an event";
	} else {
		return undefined;
	}
	if (request?.finished && request.averageTps !== undefined)
		label += ` · last ${request.averageTps.toFixed(0)} tok/s avg`;
	if (snapshot.droppedScopes) label += " · activity limit reached";
	return label;
}

export class RuntimeStatusView {
	private readonly activity: RuntimeActivity;
	private readonly update: (message: string | undefined, immediate: boolean) => void;
	private readonly unsubscribe: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastTick = performance.now();
	private stalledUntil = 0;
	private stallMs = 0;
	private signature = "";
	private message: string | undefined;

	constructor(activity: RuntimeActivity, update: (message: string | undefined, immediate: boolean) => void) {
		this.activity = activity;
		this.update = update;
		this.unsubscribe = activity.subscribe(() => this.refresh());
		this.refresh();
	}

	private refresh(): void {
		const now = performance.now();
		const snapshot = this.activity.snapshot(now, false);
		const block = snapshot.lastBlock;
		const needsTimer =
			snapshot.running ||
			snapshot.active.length > 0 ||
			(snapshot.awaitingEvent && ((block !== undefined && now - block.at < 3000) || now < this.stalledUntil));
		if (needsTimer && !this.timer) {
			this.lastTick = now;
			this.timer = setInterval(() => {
				const time = performance.now();
				const delay = time - this.lastTick - INTERVAL_MS;
				this.lastTick = time;
				if (delay > 150) {
					this.stallMs = delay;
					this.stalledUntil = time + 3000;
				}
				this.refresh();
			}, INTERVAL_MS);
			this.timer.unref?.();
		} else if (!needsTimer && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		let message = formatRuntimeStatus(snapshot, now);
		if (message && block && now - block.at < 3000) message += ` · event loop blocked ${seconds(block.durationMs)}`;
		else if (message && now < this.stalledUntil) message += ` · UI stalled ${seconds(this.stallMs)}`;
		const current = snapshot.active.at(-1);
		const signature = current ? `${current.phase}:${current.label}` : snapshot.running ? "running" : "resting";
		const immediate =
			signature !== this.signature &&
			!!current &&
			(current.phase === "tool" ||
				/Prepare|context|transcript|credentials|turn_end|agent_end|message_end|tool_result|Before tool|After tool|Finish turn|input/.test(
					current.label,
				));
		this.signature = signature;
		if (message === this.message) return;
		this.message = message;
		this.update(message, immediate);
	}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
