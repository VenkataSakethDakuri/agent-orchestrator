export type DaytonaKeyValidationResult = { ok: true } | { ok: false; error: string };

export type CloudWorkspaceProvisionInput = {
	repository: string;
	githubPat: string;
};

export type CloudWorkspaceConnection = {
	repository: string;
	projectId: string;
	sandboxId: string;
	apiBaseUrl: string;
	expiresAt: string;
};

export type CloudWorkspaceProgress =
	| {
			state: "creating" | "starting" | "preparing" | "waiting_for_codex" | "starting_ao";
			message: string;
			codexOutput?: string;
	  }
	| {
			state: "connected";
			message: string;
			connection: CloudWorkspaceConnection;
	  }
	| {
			state: "error";
			message: string;
	  };

export type CloudWorkspaceProvisionResult =
	| { ok: true; connection: CloudWorkspaceConnection }
	| { ok: false; error: string };
