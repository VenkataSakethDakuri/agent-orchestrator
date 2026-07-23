import { describe, expect, it } from "vitest";
import { Route, createProjectConfig } from "../routes/_shell";

describe("shell route loading", () => {
	it("does not rebind the API client to the local daemon during Cloud child navigation", () => {
		expect(Route.options.shouldReload).toBe(false);
	});
});

describe("createProjectConfig", () => {
	it("persists selected worker and orchestrator agents without tracker intake by default", () => {
		expect(
			createProjectConfig({
				workerAgent: "codex",
				orchestratorAgent: "claude-code",
			}),
		).toEqual({
			worker: { agent: "codex" },
			orchestrator: { agent: "claude-code" },
		});
	});

	it("preserves tracker intake alongside selected agent defaults", () => {
		expect(
			createProjectConfig({
				workerAgent: "cursor",
				orchestratorAgent: "opencode",
				trackerIntake: { enabled: true, provider: "github", assignee: "octocat" },
			}),
		).toEqual({
			worker: { agent: "cursor" },
			orchestrator: { agent: "opencode" },
			trackerIntake: { enabled: true, provider: "github", assignee: "octocat" },
		});
	});
});
