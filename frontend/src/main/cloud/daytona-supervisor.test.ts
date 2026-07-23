// @vitest-environment node
import {
	DaytonaAuthenticationError,
	DaytonaConnectionError,
} from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { DaytonaSupervisor, type DaytonaClient, type DaytonaSandbox } from "./daytona-supervisor";

function iteratorThat(
	result: IteratorResult<DaytonaSandbox> = { done: true, value: undefined },
): AsyncIterableIterator<DaytonaSandbox> {
	return {
		next: vi.fn().mockResolvedValue(result),
		return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
		throw: vi.fn(),
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

describe("DaytonaSupervisor", () => {
	it("validates with one read-only list request and retains the client in main memory", async () => {
		const iterator = iteratorThat();
		const client: DaytonaClient = { list: vi.fn(() => iterator) };
		const createClient = vi.fn(() => client);
		const supervisor = new DaytonaSupervisor(createClient);

		await expect(supervisor.validateApiKey("  dtn_test  ")).resolves.toEqual({ ok: true });

		expect(createClient).toHaveBeenCalledWith("dtn_test");
		expect(client.list).toHaveBeenCalledWith({ limit: 1 });
		expect(iterator.next).toHaveBeenCalledTimes(1);
		expect(supervisor.isConfigured()).toBe(true);
	});

	it("rejects an empty key without creating a client", async () => {
		const createClient = vi.fn();
		const supervisor = new DaytonaSupervisor(createClient);

		await expect(supervisor.validateApiKey("  ")).rejects.toThrow("Enter a Daytona API key.");
		expect(createClient).not.toHaveBeenCalled();
	});

	it("returns a safe authentication error without exposing the SDK message", async () => {
		const iterator = iteratorThat();
		vi.mocked(iterator.next).mockRejectedValue(new DaytonaAuthenticationError("secret-bearing SDK response", 401));
		const supervisor = new DaytonaSupervisor(() => ({ list: () => iterator }));

		await expect(supervisor.validateApiKey("dtn_bad")).rejects.toThrow(
			"Daytona API key is invalid or does not have access.",
		);
		expect(supervisor.isConfigured()).toBe(false);
	});

	it("clears a previously validated client when replacement validation fails", async () => {
		const validIterator = iteratorThat();
		const invalidIterator = iteratorThat();
		vi.mocked(invalidIterator.next).mockRejectedValue(new DaytonaAuthenticationError("invalid", 401));
		const createClient = vi
			.fn((_apiKey: string): DaytonaClient => ({ list: () => validIterator }))
			.mockReturnValueOnce({ list: () => validIterator })
			.mockReturnValueOnce({ list: () => invalidIterator });
		const supervisor = new DaytonaSupervisor(createClient);

		await supervisor.validateApiKey("dtn_valid");
		expect(supervisor.isConfigured()).toBe(true);
		await expect(supervisor.validateApiKey("dtn_invalid")).rejects.toThrow(
			"Daytona API key is invalid or does not have access.",
		);
		expect(supervisor.isConfigured()).toBe(false);
	});

	it("distinguishes a connection failure from an invalid key", async () => {
		const iterator = iteratorThat();
		vi.mocked(iterator.next).mockRejectedValue(new DaytonaConnectionError("offline"));
		const supervisor = new DaytonaSupervisor(() => ({ list: () => iterator }));

		await expect(supervisor.validateApiKey("dtn_test")).rejects.toThrow(
			"Could not reach Daytona. Check your connection and try again.",
		);
	});
	it("creates and bootstraps a workspace without putting the PAT in shell commands", async () => {
		const executeCommand = vi.fn(async (command: string) => ({
			exitCode: 0,
			result: command === "codex login status" ? "Logged in" : "ok",
		}));
		const sandbox: DaytonaSandbox = {
			id: "sandbox-1",
			name: "ao-acme-widget-0357f45766",
			state: "started",
			process: {
				executeCommand,
				createPty: vi.fn(),
			},
			getSignedPreviewUrl: vi.fn().mockResolvedValue({
				url: "https://3001-signed.proxy.daytona.work",
				token: "signed",
			}),
		};
		const client: DaytonaClient = {
			list: vi.fn(() => iteratorThat()),
			create: vi.fn().mockResolvedValue(sandbox),
			start: vi.fn(),
		};
		const request = vi.fn(async (url: string | URL | Request) => {
			const target = String(url);
			const body = target.endsWith("/user")
				? { login: "octo", name: null, email: null, id: 7 }
				: target.endsWith("/readyz")
					? { status: "ready" }
					: {};
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch;
		const image = { kind: "dockerfile" };
		const supervisor = new DaytonaSupervisor(() => client, request, () => image);
		const progress = vi.fn();

		await supervisor.validateApiKey("dtn_test");
		const connection = await supervisor.provisionWorkspace(
			{ repository: "acme/widget", githubPat: "github_pat_secret" },
			progress,
		);

		expect(client.create).toHaveBeenCalledWith(
			expect.objectContaining({ image, resources: { cpu: 4, memory: 8, disk: 10 }, public: false }),
			{ timeout: 1800 },
		);
		expect(connection).toMatchObject({
			repository: "acme/widget",
			sandboxId: "sandbox-1",
			apiBaseUrl: "https://3001-signed.proxy.daytona.work",
		});
		expect(request).toHaveBeenCalledWith(
			"https://3001-signed.proxy.daytona.work/readyz",
			expect.objectContaining({ headers: { "X-Daytona-Skip-Preview-Warning": "true" } }),
		);
		expect(executeCommand.mock.calls.map(([command]) => command).join("\n")).not.toContain("github_pat_secret");
		expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ state: "connected", connection }));
	});
});
