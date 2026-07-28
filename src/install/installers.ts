import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallContext {
	/** Home directory whose harness configuration is modified. */
	home: string;
	/** Root of the installed audit-trail package. */
	packageRoot: string;
}

export interface InstallResult {
	harness: string;
	changed: boolean;
	message: string;
}

export interface HarnessInstaller {
	harness: string;
	description: string;
	install(ctx: InstallContext): Promise<InstallResult>;
}

export function packageRootFromModule(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** Registers the Pi extension entry point in `~/.pi/agent/settings.json`. */
export const piInstaller: HarnessInstaller = {
	harness: "pi",
	description: "Register the Pi extension in ~/.pi/agent/settings.json",
	async install(ctx) {
		const settingsPath = join(ctx.home, ".pi", "agent", "settings.json");
		const entry = join(ctx.packageRoot, "src", "adapters", "pi.ts");
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(await readFile(settingsPath, "utf8"));
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
		const extensions = Array.isArray(settings.extensions) ? (settings.extensions as unknown[]) : [];
		// Any audit-trail entry counts, including stale pre-0.4 index.ts paths;
		// appending alongside one would register the extension twice and leave a
		// dangling path for Pi to fail on at startup.
		const isAuditTrailEntry = (item: unknown): item is string =>
			typeof item === "string" && /(pi-)?audit-trail.*\/(index\.ts|src\/adapters\/pi\.ts)$/.test(item);
		const current = extensions.filter(isAuditTrailEntry);
		if (current.length === 1 && current[0] === entry) {
			return { harness: "pi", changed: false, message: `already registered in ${settingsPath}: ${entry}` };
		}
		settings.extensions = [...extensions.filter((item) => !isAuditTrailEntry(item)), entry];
		await mkdir(dirname(settingsPath), { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 1)}\n`, "utf8");
		const replaced = current.filter((item) => item !== entry);
		return {
			harness: "pi",
			changed: true,
			message: replaced.length
				? `registered ${entry} in ${settingsPath}, replacing stale ${replaced.join(", ")}`
				: `registered ${entry} in ${settingsPath}`,
		};
	},
};

const OPENCODE_COMMANDS: Record<string, string> = {
	"audit-start": `---
description: Start or resume the worktree's decision audit
---
Call the audit_start tool with task: $ARGUMENTS

Report the tool output verbatim. If it fails, report the error instead of retrying with a different task name.
`,
	"audit-status": `---
description: Show decision-audit status and unresolved decision IDs
---
Call the audit_status tool with no arguments and report its output verbatim.
`,
	"audit-review": `---
description: Run an independent review of the active decision audit
---
Call the audit_review tool. If "$ARGUMENTS" is non-empty, pass it as the model argument (provider/model); otherwise omit model so a cross-provider reviewer is selected automatically. The review may take several minutes. Report the tool output verbatim.
`,
	"audit-publish": `---
description: Publish the audit to the current branch's pull request
---
Call the audit_publish tool. If "$ARGUMENTS" is non-empty, pass it as the selector argument (PR number or URL); otherwise omit selector to target the current checked-out branch's PR. Report the tool output verbatim.
`,
	"audit-close": `---
description: Close the audit once resolved and reviewed
---
Call the audit_close tool with no arguments and report its output verbatim. If it reports blockers, list them and do not attempt to work around them.
`,
};

function opencodePluginShim(packageRoot: string): string {
	return `// Managed by \`audit-trail install opencode\`; edits are overwritten on reinstall.\nexport { AuditTrailPlugin } from ${JSON.stringify(join(packageRoot, "src", "adapters", "opencode.ts"))};\n`;
}

/**
 * Installs the OpenCode plugin shim and /audit-* command templates under
 * `~/.config/opencode`. Only files this package owns are written — OpenCode
 * auto-loads everything in `plugins/` and `commands/` — so repeated installs
 * are safe by construction and unrelated user configuration (opencode.json,
 * other plugins/commands) is never touched. Reinstalling regenerates the shim
 * from the current packageRoot, replacing a stale one from a prior install
 * location.
 */
export const opencodeInstaller: HarnessInstaller = {
	harness: "opencode",
	description: "Install the OpenCode plugin shim and /audit-* commands under ~/.config/opencode",
	async install(ctx) {
		const configDir = join(ctx.home, ".config", "opencode");
		const managed = new Map<string, string>([
			[join(configDir, "plugins", "audit-trail.ts"), opencodePluginShim(ctx.packageRoot)],
			...Object.entries(OPENCODE_COMMANDS).map(
				([name, content]): [string, string] => [join(configDir, "commands", `${name}.md`), content],
			),
		]);
		const written: string[] = [];
		for (const [path, content] of managed) {
			let existing: string | undefined;
			try {
				existing = await readFile(path, "utf8");
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
			if (existing === content) continue;
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
			written.push(path);
		}
		if (!written.length) {
			return { harness: "opencode", changed: false, message: `already installed under ${configDir}` };
		}
		return {
			harness: "opencode",
			changed: true,
			message: `wrote ${written.length} file${written.length === 1 ? "" : "s"} under ${configDir} (plugin shim and /audit-* commands)`,
		};
	},
};

function plannedInstaller(harness: string, issue: string): HarnessInstaller {
	return {
		harness,
		description: `${harness} support ships in ${issue}`,
		async install() {
			return { harness, changed: false, message: `${harness} support ships in ${issue}; nothing installed` };
		},
	};
}

/** Harness registry; later issues replace planned entries with real installers. */
export const installers: readonly HarnessInstaller[] = [
	piInstaller,
	plannedInstaller("claude", "issue #7"),
	plannedInstaller("codex", "issue #8"),
	opencodeInstaller,
];

export function selectInstallers(target: string): readonly HarnessInstaller[] {
	if (target === "all") return installers;
	const match = installers.find((installer) => installer.harness === target);
	if (!match) {
		throw new Error(
			`Unknown harness: ${target}. Expected one of: ${[...installers.map((i) => i.harness), "all"].join(", ")}`,
		);
	}
	return [match];
}
