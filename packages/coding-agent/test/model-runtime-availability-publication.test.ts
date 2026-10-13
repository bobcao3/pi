import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

async function fixture() {
	const providerId = "availability-source";
	const authStarted = deferred();
	const catalogStarted = deferred();
	const catalogReleased = deferred();
	const pending: ServerResponse[] = [];
	let holdAuth = false;
	let holdCatalog = false;
	let authorizationActive = false;
	let authorizationStatus = 200;
	const send = (response: ServerResponse, active: boolean, status = 200) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify({ active }));
	};
	const server = createServer((_request, response) => {
		if (!holdAuth) {
			send(response, authorizationActive, authorizationStatus);
			return;
		}
		pending.push(response);
		authStarted.resolve();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing authorization server address");
	const url = `http://127.0.0.1:${address.port}`;
	const makeProvider = (modelId = "physical", id = providerId): Provider => {
		const { provider } = fauxProvider({ provider: id, models: [{ id: modelId }] });
		return {
			...provider,
			auth: {
				apiKey: {
					name: "Authorization service",
					resolve: async ({ credential, signal }) => {
						const response = await fetch(url, { signal });
						if (!response.ok) throw new Error(`Authorization service returned ${response.status}`);
						const body = (await response.json()) as { active: boolean };
						return body.active
							? { auth: { apiKey: credential?.key }, source: "authorization service" }
							: undefined;
					},
				},
			},
			refreshModels: async () => {
				if (holdCatalog) {
					catalogStarted.resolve();
					await catalogReleased.promise;
				}
			},
		};
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [providerId]: { type: "api_key", key: "stored" } }),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const replyAuth = (active: boolean, status = 200) => {
		holdAuth = false;
		authorizationActive = active;
		authorizationStatus = status;
		for (const response of pending.splice(0)) send(response, active, status);
	};
	onTestFinished(async () => {
		replyAuth(false);
		holdCatalog = false;
		catalogReleased.resolve();
		try {
			await runtime.refresh({ allowNetwork: false });
			await runtime.getAvailable();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	runtime.registerNativeProvider(makeProvider());
	await runtime.refresh({ allowNetwork: false });
	await runtime.getAvailable();
	expect(runtime.hasConfiguredAuth(providerId)).toBe(false);
	const addVirtual = (id: string) => {
		const model = runtime.getPhysicalModel(providerId, "physical");
		if (!model) throw new Error("Missing physical fixture model");
		runtime.registerVirtualModel({
			provider: id,
			id: "auto",
			name: "Auto",
			route: () => ({ model, thinkingLevel: "off" }),
		});
	};
	return {
		runtime,
		providerId,
		makeProvider,
		addVirtual,
		replyAuth,
		blockAuth: () => {
			holdAuth = true;
			return authStarted.promise;
		},
		blockCatalog: () => {
			holdCatalog = true;
			return catalogStarted.promise;
		},
		releaseCatalog: () => {
			holdCatalog = false;
			catalogReleased.resolve();
		},
	};
}

describe("ModelRuntime availability publication after provider composition", () => {
	it("does not let an older full snapshot remove newly registered virtual auth", async () => {
		const { runtime, blockAuth, blockCatalog, addVirtual, replyAuth } = await fixture();
		const started = blockAuth();
		const available = runtime.getAvailable();
		await started;
		blockCatalog();
		addVirtual("routing-only");
		expect(runtime.hasConfiguredAuth("routing-only")).toBe(true);

		replyAuth(false);
		await available;

		expect(runtime.hasConfiguredAuth("routing-only")).toBe(true);
		expect(runtime.getAvailableSnapshot()).toContainEqual(
			expect.objectContaining({ provider: "routing-only", id: "auto" }),
		);
	});

	it("does not let an older provider snapshot remove replacement-provider auth", async () => {
		const { runtime, providerId, makeProvider, blockAuth, blockCatalog, replyAuth } = await fixture();
		const started = blockAuth();
		const refresh = runtime.refresh({ allowNetwork: false, providers: [providerId] });
		await started;
		blockCatalog();
		runtime.registerNativeProvider(makeProvider("replacement"));
		expect(runtime.hasConfiguredAuth(providerId)).toBe(true);

		replyAuth(false);
		await refresh;

		expect(runtime.hasConfiguredAuth(providerId)).toBe(true);
		expect(runtime.getAvailableSnapshot()).toContainEqual(
			expect.objectContaining({ provider: providerId, id: "replacement" }),
		);
	});

	it("allows an older provider snapshot to update an unchanged provider after another provider recomposes", async () => {
		const { runtime, providerId, blockAuth, replyAuth } = await fixture();
		runtime.registerNativeProvider(fauxProvider({ provider: "unrelated" }).provider);
		await runtime.refresh({ allowNetwork: false });
		await runtime.getAvailable();
		const started = blockAuth();
		const refresh = runtime.refresh({ allowNetwork: false, providers: [providerId] });
		await started;
		await runtime.setRuntimeApiKey("unrelated", "unrelated-key");

		replyAuth(true);
		await refresh;

		expect(runtime.hasConfiguredAuth(providerId)).toBe(true);
		expect(runtime.hasConfiguredAuth("unrelated")).toBe(true);
		expect(runtime.getAvailableSnapshot()).toContainEqual(
			expect.objectContaining({ provider: providerId, id: "physical" }),
		);
	});

	it.each([
		{ operation: "full", changed: "other" },
		{ operation: "provider", changed: "same" },
		{ operation: "direct", changed: "other" },
	] as const)(
		"does not publish an obsolete $operation error after $changed-provider composition",
		async ({ operation, changed }) => {
			const { runtime, providerId, blockAuth, blockCatalog, addVirtual, replyAuth } = await fixture();
			const started = blockAuth();
			const request =
				operation === "provider"
					? runtime
							.refresh({ allowNetwork: false, providers: [providerId] })
							.then((result) => result.errors.get(providerId))
					: runtime.getAvailable(operation === "direct" ? providerId : undefined).then(() => undefined);
			const outcome = request.catch((error: unknown) => error);
			await started;
			blockCatalog();
			addVirtual(changed === "same" ? providerId : "routing-only");

			replyAuth(false, 503);
			await expect(outcome).resolves.toBeInstanceOf(Error);
			expect(runtime.getError()).toBeUndefined();
		},
	);

	it("does not publish an older provider error while another provider restores its catalog", async () => {
		const { runtime, providerId, makeProvider, blockAuth, blockCatalog, releaseCatalog, replyAuth } = await fixture();
		runtime.registerNativeProvider(makeProvider("unrelated-model", "unrelated"));
		await runtime.refresh({ allowNetwork: false });
		await runtime.getAvailable();
		const started = blockAuth();
		const refresh = runtime.refresh({ allowNetwork: false, providers: [providerId] });
		await started;
		const restoring = blockCatalog();
		const mutation = runtime.setRuntimeApiKey("unrelated", "unrelated-key");
		void mutation.catch(() => {});
		await restoring;

		replyAuth(false, 503);
		const result = await refresh;

		expect(result.errors.get(providerId)).toBeInstanceOf(Error);
		expect(runtime.getError()).toBeUndefined();
		replyAuth(false);
		releaseCatalog();
		await mutation;
	});
});
