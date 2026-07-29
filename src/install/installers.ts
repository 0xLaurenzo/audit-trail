import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
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

const OPENCODE_MANAGED_MARKER = "audit-trail-managed:v1";
const OPENCODE_COMMAND_MARKER = `<!-- ${OPENCODE_MANAGED_MARKER} -->\n`;

const OPENCODE_COMMANDS: Record<string, string> = {
	"audit-start": `---
description: Start or resume the worktree's decision audit
---
${OPENCODE_COMMAND_MARKER}Call the audit_start tool with task: $ARGUMENTS

Report the tool output verbatim. If it fails, report the error instead of retrying with a different task name.
`,
	"audit-status": `---
description: Show decision-audit status and unresolved decision IDs
---
${OPENCODE_COMMAND_MARKER}Call the audit_status tool with no arguments and report its output verbatim.
`,
	"audit-review": `---
description: Run an independent review of the active decision audit
---
${OPENCODE_COMMAND_MARKER}Call the audit_review tool. If "$ARGUMENTS" is non-empty, pass it as the model argument (provider/model); otherwise omit model so a cross-provider reviewer is selected automatically. The review may take several minutes. Report the tool output verbatim.
`,
	"audit-publish": `---
description: Publish the audit to the current branch's pull request
---
${OPENCODE_COMMAND_MARKER}Call the audit_publish tool. If "$ARGUMENTS" is non-empty, pass it as the selector argument (PR number or URL); otherwise omit selector to target the current checked-out branch's PR. Report the tool output verbatim.
`,
	"audit-close": `---
description: Close the audit once resolved and reviewed
---
${OPENCODE_COMMAND_MARKER}Call the audit_close tool with no arguments and report its output verbatim. If it reports blockers, list them and do not attempt to work around them.
`,
};

function opencodePluginShim(packageRoot: string): string {
	return `// ${OPENCODE_MANAGED_MARKER}\n// Managed by \`audit-trail install opencode\`; edits are overwritten on reinstall.\nexport { AuditTrailPlugin } from ${JSON.stringify(join(packageRoot, "src", "adapters", "opencode.ts"))};\n`;
}

/**
 * Recognize current managed files and the exact pre-marker files emitted by
 * the unreleased initial OpenCode installer. Arbitrary same-name files are
 * unowned collisions and must never be overwritten.
 */
function isManagedOpencodeFile(path: string, existing: string, desired: string): boolean {
	if (existing.includes(OPENCODE_MANAGED_MARKER)) return true;
	if (path.endsWith("/plugins/audit-trail.ts")) {
		return existing.startsWith("// Managed by `audit-trail install opencode`;");
	}
	return existing === desired.replace(OPENCODE_COMMAND_MARKER, "");
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
		// Preflight every target before writing any of them: one unowned
		// collision must not leave a partial installation behind.
		const pending: [string, string][] = [];
		const collisions: string[] = [];
		for (const [path, content] of managed) {
			let existing: string | undefined;
			try {
				existing = await readFile(path, "utf8");
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
			if (existing === content) continue;
			if (existing !== undefined && !isManagedOpencodeFile(path, existing, content)) {
				collisions.push(path);
				continue;
			}
			pending.push([path, content]);
		}
		if (collisions.length) {
			throw new Error(
				`Refusing to overwrite OpenCode files not managed by audit-trail:\n${collisions.map((path) => `- ${path}`).join("\n")}\nMove or remove the conflicting files, then run the installer again.`,
			);
		}
		for (const [path, content] of pending) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		}
		if (!pending.length) {
			return { harness: "opencode", changed: false, message: `already installed under ${configDir}` };
		}
		return {
			harness: "opencode",
			changed: true,
			message: `wrote ${pending.length} file${pending.length === 1 ? "" : "s"} under ${configDir} (plugin shim and /audit-* commands)`,
		};
	},
};

/**
 * Symlinks the package into Claude Code's skills directory, where any folder
 * with .claude-plugin/plugin.json loads as a plugin (audit-trail@skills-dir)
 * on the next session — discovered in place, with no marketplace and no
 * Claude-managed registry mutation. One symlink keeps installation idempotent
 * and structurally unable to touch unrelated Claude configuration. Because a
 * symlink cannot prove who created it, every different or non-symlink target is
 * a collision; package-location upgrades require explicit removal of the old
 * link before reinstalling.
 */
export const claudeInstaller: HarnessInstaller = {
	harness: "claude",
	description: "Symlink the plugin into ~/.claude/skills (loads as audit-trail@skills-dir)",
	async install(ctx) {
		const manifestPath = join(ctx.packageRoot, ".claude-plugin", "plugin.json");
		let manifestName: unknown;
		try {
			manifestName = JSON.parse(await readFile(manifestPath, "utf8"))?.name;
		} catch (error: any) {
			throw new Error(`Package is missing a readable Claude plugin manifest at ${manifestPath}: ${error?.message ?? error}`);
		}
		if (manifestName !== "audit-trail") {
			throw new Error(`Unexpected plugin name in ${manifestPath}: ${String(manifestName)}`);
		}
		const linkPath = join(ctx.home, ".claude", "skills", "audit-trail");
		let existing;
		try {
			existing = await lstat(linkPath);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (existing) {
			if (!existing.isSymbolicLink()) {
				throw new Error(
					`Refusing to replace ${linkPath}: it is not a symlink managed by audit-trail. Move or remove it, then run the installer again.`,
				);
			}
			const currentTarget = resolve(dirname(linkPath), await readlink(linkPath));
			if (currentTarget === resolve(ctx.packageRoot)) {
				return { harness: "claude", changed: false, message: `already linked: ${linkPath} -> ${ctx.packageRoot}` };
			}
			throw new Error(
				`Refusing to replace ${linkPath}: it points at a different target (${currentTarget}), and symlink ownership cannot be proven. Remove it explicitly, then run the installer again.`,
			);
		}
		await mkdir(dirname(linkPath), { recursive: true });
		await symlink(ctx.packageRoot, linkPath, "dir");
		return {
			harness: "claude",
			changed: true,
			message: `linked ${linkPath} -> ${ctx.packageRoot}; Claude Code loads it as audit-trail@skills-dir on the next session`,
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
	claudeInstaller,
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
