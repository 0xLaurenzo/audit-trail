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
		const existing = extensions.find(
			(item) =>
				typeof item === "string" && (item === entry || /(pi-)?audit-trail.*\/src\/adapters\/pi\.ts$/.test(item)),
		);
		if (existing) {
			return { harness: "pi", changed: false, message: `already registered in ${settingsPath}: ${existing}` };
		}
		settings.extensions = [...extensions, entry];
		await mkdir(dirname(settingsPath), { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 1)}\n`, "utf8");
		return { harness: "pi", changed: true, message: `registered ${entry} in ${settingsPath}` };
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
	plannedInstaller("claude", "issue #6"),
	plannedInstaller("codex", "issue #7"),
	plannedInstaller("opencode", "issue #8"),
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
