import {
	Daytona,
	DaytonaAuthenticationError,
	DaytonaAuthorizationError,
	DaytonaConnectionError,
	DaytonaError,
	DaytonaTimeoutError,
	Image,
} from "@daytona/sdk";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
	CloudWorkspaceConnection,
	CloudWorkspaceProgress,
	CloudWorkspaceProvisionInput,
	DaytonaKeyValidationResult,
} from "../../shared/cloud";

type CommandResult = { exitCode: number; result: string };

type PtyHandle = {
	waitForConnection(): Promise<void>;
	sendInput(input: string): Promise<void>;
	disconnect(): Promise<void>;
};

export type DaytonaSandbox = {
	id: string;
	name: string;
	state?: string;
	process: {
		executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<CommandResult>;
		createPty(options: {
			id: string;
			cwd?: string;
			envs?: Record<string, string>;
			cols?: number;
			rows?: number;
			onData(data: Uint8Array): void;
		}): Promise<PtyHandle>;
	};
	getSignedPreviewUrl(port: number, expiresInSeconds: number): Promise<{ url: string; token: string }>;
};

type SandboxIterator = AsyncIterableIterator<DaytonaSandbox>;

export type DaytonaClient = {
	list(query?: { limit?: number; name?: string }): SandboxIterator;
	create?(
		params: {
			name: string;
			image: unknown;
			labels: Record<string, string>;
			resources: { cpu: number; memory: number; disk: number };
			autoStopInterval: number;
			autoDeleteInterval: number;
			public: boolean;
		},
		options?: { timeout: number },
	): Promise<DaytonaSandbox>;
	start?(sandbox: DaytonaSandbox, timeout?: number): Promise<void>;
};

type DaytonaClientFactory = (apiKey: string) => DaytonaClient;
type ProgressReporter = (progress: CloudWorkspaceProgress) => void;
type GitHubProfile = { login: string; name: string | null; email: string | null; id: number };

const defaultClientFactory: DaytonaClientFactory = (apiKey) =>
	new Daytona({ apiKey }) as unknown as DaytonaClient;

const CODEX_ENV = { HOME: "/root", CODEX_HOME: "/root/.ao/codex", TERM: "xterm-256color" };
const WORKSPACE_PATH = "/workspace/repository";
const PREVIEW_LIFETIME_SECONDS = 60 * 60;

export class DaytonaSupervisor {
	private client: DaytonaClient | null = null;

	constructor(
		private readonly createClient: DaytonaClientFactory = defaultClientFactory,
		private readonly request: typeof fetch = fetch,
		private readonly createImage: () => unknown = () => Image.fromDockerfile(resolveDockerfilePath()),
	) {}

	async validateApiKey(value: unknown): Promise<DaytonaKeyValidationResult> {
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error("Enter a Daytona API key.");
		}

		this.client = null;
		try {
			const candidate = this.createClient(value.trim());
			const sandboxes = candidate.list({ limit: 1 });
			await sandboxes.next();
			await sandboxes.return?.();
			this.client = candidate;
		} catch (error) {
			throw new Error(validationMessage(error));
		}

		return { ok: true };
	}

	isConfigured(): boolean {
		return this.client !== null;
	}

	async provisionWorkspace(
		input: CloudWorkspaceProvisionInput,
		report: ProgressReporter = () => undefined,
	): Promise<CloudWorkspaceConnection> {
		const client = this.client;
		if (!client) throw new Error("Validate your Daytona API key first.");

		const repository = normalizeRepository(input.repository);
		const githubPat = input.githubPat?.trim();
		if (!githubPat) throw new Error("Enter a GitHub personal access token.");

		const profile = await this.validateGitHubAccess(repository, githubPat);
		const sandboxName = sandboxNameFor(repository);
		let sandbox = await findSandbox(client, sandboxName);

		if (!sandbox) {
			if (!client.create) throw new Error("This Daytona client cannot create sandboxes.");
			report({ state: "creating", message: "Creating the Daytona sandbox. The first build can take a few minutes." });
			sandbox = await client.create(
				{
					name: sandboxName,
					image: this.createImage(),
					labels: { "ao-repository": repository.toLowerCase() },
					resources: { cpu: 4, memory: 8, disk: 10 },
					autoStopInterval: 0,
					autoDeleteInterval: -1,
					public: false,
				},
				{ timeout: 30 * 60 },
			);
		} else if (sandbox.state?.toLowerCase() !== "started") {
			if (!client.start) throw new Error("This Daytona client cannot start sandboxes.");
			report({ state: "starting", message: "Starting the existing Daytona sandbox." });
			await client.start(sandbox, 10 * 60);
		}

		report({ state: "preparing", message: "Preparing the repository inside the sandbox." });
		await this.prepareRepository(sandbox, repository, githubPat, profile);
		await this.ensureCodexLogin(sandbox, report);

		report({ state: "starting_ao", message: "Starting Agent Orchestrator in the sandbox." });
		const projectId = projectIdFor(repository);
		await this.startAo(sandbox, repository, githubPat, projectId);

		const signed = await sandbox.getSignedPreviewUrl(3001, PREVIEW_LIFETIME_SECONDS);
		await this.verifySignedPreview(signed.url);
		const connection: CloudWorkspaceConnection = {
			repository,
			projectId,
			sandboxId: sandbox.id,
			apiBaseUrl: signed.url.replace(/\/+$/, ""),
			expiresAt: new Date(Date.now() + PREVIEW_LIFETIME_SECONDS * 1000).toISOString(),
		};
		report({ state: "connected", message: `Connected to ${repository}.`, connection });
		return connection;
	}

	private async verifySignedPreview(baseUrl: string): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15_000);
		try {
			const response = await this.request(`${baseUrl.replace(/\/+$/, "")}/readyz`, {
				headers: { "X-Daytona-Skip-Preview-Warning": "true" },
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`Daytona preview returned HTTP ${response.status}.`);
			}
			const probe = (await response.json().catch(() => null)) as { status?: unknown } | null;
			if (probe?.status !== "ready") {
				throw new Error("Daytona preview did not return AO readiness.");
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Daytona preview")) throw error;
			throw new Error("Daytona preview could not reach the AO daemon.");
		} finally {
			clearTimeout(timer);
		}
	}

	private async validateGitHubAccess(repository: string, token: string): Promise<GitHubProfile> {
		const headers = {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "agent-orchestrator",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		const [repoResponse, profileResponse] = await Promise.all([
			this.request(`https://api.github.com/repos/${repository}`, { headers }),
			this.request("https://api.github.com/user", { headers }),
		]);
		if (!repoResponse.ok) {
			throw new Error(
				repoResponse.status === 404
					? "The GitHub token cannot access that repository."
					: "Could not validate repository access with GitHub.",
			);
		}
		if (!profileResponse.ok) throw new Error("The GitHub personal access token is invalid.");
		return (await profileResponse.json()) as GitHubProfile;
	}

	private async prepareRepository(
		sandbox: DaytonaSandbox,
		repository: string,
		githubPat: string,
		profile: GitHubProfile,
	): Promise<void> {
		const authorName = profile.name?.trim() || profile.login;
		const authorEmail = profile.email?.trim() || `${profile.id}+${profile.login}@users.noreply.github.com`;
		await execute(
			sandbox,
			[
				"mkdir -p /root/.ao/data /root/.ao/codex /workspace",
				`if [ ! -d ${shellQuote(WORKSPACE_PATH)}/.git ]; then gh repo clone "$AO_REPOSITORY" ${shellQuote(WORKSPACE_PATH)}; fi`,
				`git config --global --add safe.directory ${shellQuote(WORKSPACE_PATH)}`,
				`git -C ${shellQuote(WORKSPACE_PATH)} config user.name ${shellQuote(authorName)}`,
				`git -C ${shellQuote(WORKSPACE_PATH)} config user.email ${shellQuote(authorEmail)}`,
			].join(" && "),
			{ GH_TOKEN: githubPat, AO_REPOSITORY: repository },
			10 * 60,
		);
	}

	private async ensureCodexLogin(sandbox: DaytonaSandbox, report: ProgressReporter): Promise<void> {
		if (await codexLoggedIn(sandbox)) return;

		let output = "";
		const handle = await sandbox.process.createPty({
			id: `ao-codex-login-${Date.now()}`,
			cwd: "/root",
			envs: CODEX_ENV,
			cols: 120,
			rows: 30,
			onData: (data) => {
				output = stripAnsi(`${output}${new TextDecoder().decode(data)}`).slice(-8_000);
				report({
					state: "waiting_for_codex",
					message: "Approve the Codex device code in your browser.",
					codexOutput: output,
				});
			},
		});
		try {
			await handle.waitForConnection();
			await handle.sendInput("codex login --device-auth\n");
			const deadline = Date.now() + 15 * 60 * 1000;
			while (Date.now() < deadline) {
				if (await codexLoggedIn(sandbox)) {
					await handle.sendInput("exit\n").catch(() => undefined);
					return;
				}
				await delay(2_000);
			}
			throw new Error("Codex login timed out. Retry setup and approve the device code.");
		} finally {
			await handle.disconnect().catch(() => undefined);
		}
	}

	private async startAo(
		sandbox: DaytonaSandbox,
		repository: string,
		githubPat: string,
		projectId: string,
	): Promise<void> {
		await execute(
			sandbox,
			[
				'tmux has-session -t ao-daemon 2>/dev/null || tmux new-session -d -s ao-daemon "AO_PORT=3001 AO_DATA_DIR=/root/.ao/data CODEX_HOME=/root/.ao/codex ao daemon"',
				"for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3001/readyz >/dev/null && break; sleep 1; done",
				"curl -fsS http://127.0.0.1:3001/readyz >/dev/null",
				`ao project get ${shellQuote(projectId)} >/dev/null 2>&1 || ao project add --id ${shellQuote(projectId)} --path ${shellQuote(WORKSPACE_PATH)} --worker-agent codex --orchestrator-agent codex`,
			].join(" && "),
			{ GH_TOKEN: githubPat, AO_REPOSITORY: repository },
			90,
		);
	}
}

async function findSandbox(client: DaytonaClient, name: string): Promise<DaytonaSandbox | null> {
	const sandboxes = client.list({ name, limit: 10 });
	for await (const sandbox of sandboxes) {
		if (sandbox.name === name) return sandbox;
	}
	return null;
}

async function execute(
	sandbox: DaytonaSandbox,
	command: string,
	env?: Record<string, string>,
	timeout?: number,
): Promise<string> {
	const result = await sandbox.process.executeCommand(command, undefined, env, timeout);
	if (result.exitCode !== 0) {
		throw new Error(`Sandbox setup failed: ${result.result.trim() || `command exited ${result.exitCode}`}`);
	}
	return result.result;
}

async function codexLoggedIn(sandbox: DaytonaSandbox): Promise<boolean> {
	const result = await sandbox.process.executeCommand("codex login status", undefined, CODEX_ENV, 20).catch(() => null);
	if (!result || result.exitCode !== 0) return false;
	const status = result.result.toLowerCase();
	return status.includes("logged in") && !status.includes("not logged in");
}

function normalizeRepository(value: unknown): string {
	if (typeof value !== "string") throw new Error("Enter a GitHub repository such as owner/repository.");
	const repository = value.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error("Enter a GitHub repository such as owner/repository.");
	}
	return repository;
}

function sandboxNameFor(repository: string): string {
	const readable = repository.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38);
	return `ao-${readable}-${shortHash(repository.toLowerCase())}`;
}

function projectIdFor(repository: string): string {
	return `cloud-${shortHash(repository)}`;
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stripAnsi(value: string): string {
	return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveDockerfilePath(): string {
	const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
	const candidates = [
		process.env.AO_DAYTONA_DOCKERFILE,
		electronProcess.resourcesPath ? path.join(electronProcess.resourcesPath, "Dockerfile") : undefined,
		path.join(process.cwd(), "cloud-agents", "daytona", "Dockerfile"),
		path.join(process.cwd(), "..", "cloud-agents", "daytona", "Dockerfile"),
	].filter((candidate): candidate is string => Boolean(candidate));
	const found = candidates.find(existsSync);
	if (!found) throw new Error("The Daytona sandbox image definition is missing from this app build.");
	return found;
}

function validationMessage(error: unknown): string {
	if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaAuthorizationError) {
		return "Daytona API key is invalid or does not have access.";
	}
	if (error instanceof DaytonaConnectionError || error instanceof DaytonaTimeoutError) {
		return "Could not reach Daytona. Check your connection and try again.";
	}
	if (error instanceof DaytonaError) {
		return "Daytona rejected the API key. Check it and try again.";
	}
	return "Could not validate the Daytona API key.";
}
