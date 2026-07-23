import { Check, Cloud, FolderGit2, KeyRound, LoaderCircle } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { CloudWorkspaceConnection, CloudWorkspaceProgress } from "../../shared/cloud";
import { aoBridge } from "../lib/bridge";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type SetupStep = "daytona" | "repository" | "github" | "codex";

const steps = [
	{ id: "daytona", label: "Daytona", icon: Cloud },
	{ id: "repository", label: "Repository", icon: FolderGit2 },
	{ id: "github", label: "GitHub", icon: KeyRound },
] as const;

export function normalizeGitHubRepository(input: string): string | null {
	let value = input.trim();
	if (!value) return null;

	if (value.startsWith("git@github.com:")) {
		value = value.slice("git@github.com:".length);
	} else if (/^https?:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			if (url.hostname.toLowerCase() !== "github.com") return null;
			value = url.pathname;
		} catch {
			return null;
		}
	}

	value = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}

export function CloudWorkspaceSetup({
	resetSignal = 0,
	onConnected = () => undefined,
}: {
	resetSignal?: number;
	onConnected?: (connection: CloudWorkspaceConnection) => void;
}) {
	const [step, setStep] = useState<SetupStep>("daytona");
	const [daytonaApiKey, setDaytonaApiKey] = useState("");
	const [repository, setRepository] = useState("");
	const [githubPat, setGithubPat] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isWorking, setIsWorking] = useState(false);
	const [progress, setProgress] = useState<CloudWorkspaceProgress | null>(null);

	useEffect(() => aoBridge.cloud.onProgress(setProgress), []);

	useEffect(() => {
		setStep("daytona");
		setDaytonaApiKey("");
		setRepository("");
		setGithubPat("");
		setError(null);
		setIsWorking(false);
		setProgress(null);
	}, [resetSignal]);

	const currentIndex = steps.findIndex((item) => item.id === step);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);

		if (step === "daytona") {
			if (!daytonaApiKey.trim()) {
				setError("Enter a Daytona API key.");
				return;
			}
			setIsWorking(true);
			try {
				const result = await aoBridge.cloud.validateDaytonaKey(daytonaApiKey);
				if (!result.ok) {
					setError(result.error);
					return;
				}
				setDaytonaApiKey("");
				setStep("repository");
			} catch (validationError) {
				setError(
					validationError instanceof Error
						? validationError.message
						: "Could not validate the Daytona API key.",
				);
			} finally {
				setIsWorking(false);
			}
			return;
		}

		if (step === "repository") {
			const normalized = normalizeGitHubRepository(repository);
			if (!normalized) {
				setError("Enter a GitHub repository such as owner/repository.");
				return;
			}
			setRepository(normalized);
			setStep("github");
			return;
		}

		if (!githubPat.trim()) {
			setError("Enter a GitHub personal access token.");
			return;
		}

		setStep("codex");
		setIsWorking(true);
		setProgress({ state: "preparing", message: "Validating GitHub access." });
		const request = aoBridge.cloud.provisionWorkspace({ repository, githubPat });
		setGithubPat("");
		try {
			const result = await request;
			if (!result.ok) {
				setError(result.error);
				return;
			}
			onConnected(result.connection);
		} catch (provisionError) {
			setError(provisionError instanceof Error ? provisionError.message : "Could not create the cloud workspace.");
		} finally {
			setIsWorking(false);
		}
	}

	function goBack() {
		setError(null);
		if (step === "repository") setStep("daytona");
		if (step === "github") setStep("repository");
	}

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
			<section className="w-full max-w-xl rounded-xl border border-border bg-background p-6 shadow-sm">
				<div className="mb-6 flex items-start gap-3">
					<div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-weak text-accent">
						<Cloud aria-hidden="true" className="size-5" />
					</div>
					<div>
						<h1 className="text-lg font-semibold text-foreground">New cloud workspace</h1>
						<p className="mt-1 text-sm text-passive">Connect one GitHub repository to one Daytona sandbox.</p>
					</div>
				</div>

				<ol aria-label="Cloud setup progress" className="mb-7 grid grid-cols-3 gap-2">
					{steps.map((item, index) => {
						const complete = step === "codex" || index < currentIndex;
						const active = item.id === step;
						const Icon = item.icon;
						return (
							<li
								className={cn(
									"flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
									active && "border-accent bg-accent-weak text-foreground",
									complete && "border-border bg-surface text-foreground",
									!active && !complete && "border-border text-passive",
								)}
								key={item.id}
							>
								{complete ? <Check aria-hidden="true" className="size-3.5" /> : <Icon aria-hidden="true" className="size-3.5" />}
								<span>{item.label}</span>
							</li>
						);
					})}
				</ol>

				{step === "codex" ? (
					<div className="rounded-lg border border-border bg-surface p-5">
						<div className="flex items-center gap-2">
							{isWorking ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-accent" /> : null}
							<h2 className="text-base font-semibold text-foreground">
								{progress?.state === "waiting_for_codex" ? "Approve Codex login" : "Creating cloud workspace"}
							</h2>
						</div>
						<p className="mt-2 text-sm leading-6 text-passive">
							{progress?.message ?? "Electron is preparing Daytona."}
						</p>
						{progress?.state === "waiting_for_codex" && progress.codexOutput ? (
							<pre className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs text-foreground">
								{progress.codexOutput}
							</pre>
						) : null}
						{error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
						{!isWorking ? (
							<Button className="mt-4" onClick={() => setStep("daytona")} type="button" variant="outline">
								Start over
							</Button>
						) : null}
					</div>
				) : (
					<form onSubmit={submit}>
						{step === "daytona" ? (
							<SetupField
								autoComplete="off"
								description="Used by Electron to create or reuse your sandbox. It is never sent into the sandbox."
								label="Daytona API key"
								disabled={isWorking}
								onChange={setDaytonaApiKey}
								placeholder="dtn_..."
								type="password"
								value={daytonaApiKey}
							/>
						) : null}

						{step === "repository" ? (
							<SetupField
								autoComplete="url"
								description="Use owner/repository or paste a GitHub URL. The repository becomes the cloud workspace identity."
								label="GitHub repository"
								onChange={setRepository}
								placeholder="owner/repository"
								value={repository}
							/>
						) : null}

						{step === "github" ? (
							<SetupField
								autoComplete="off"
								description={`Used for clone, push and pull requests in ${repository}.`}
								label="GitHub personal access token"
								onChange={setGithubPat}
								placeholder="github_pat_..."
								type="password"
								value={githubPat}
							/>
						) : null}

						{error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

						<div className="mt-6 flex items-center justify-between">
							{step === "daytona" ? <span /> : (
								<Button onClick={goBack} type="button" variant="ghost">
									Back
								</Button>
							)}
							<Button disabled={isWorking} type="submit">
								{isWorking ? "Validating..." : step === "github" ? "Create cloud workspace" : "Continue"}
							</Button>
						</div>
					</form>
				)}
			</section>
		</div>
	);
}

function SetupField({
	autoComplete,
	description,
	disabled = false,
	label,
	onChange,
	placeholder,
	type = "text",
	value,
}: {
	autoComplete: string;
	description: string;
	disabled?: boolean;
	label: string;
	onChange: (value: string) => void;
	placeholder: string;
	type?: "password" | "text";
	value: string;
}) {
	const id = label.toLowerCase().replaceAll(" ", "-");
	return (
		<div>
			<Label htmlFor={id}>{label}</Label>
			<p className="mb-3 mt-1 text-sm leading-5 text-passive">{description}</p>
			<Input
				autoComplete={autoComplete}
				autoFocus
				disabled={disabled}
				id={id}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				type={type}
				value={value}
			/>
		</div>
	);
}
