import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, findNodeAtLocation, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import type { CommandRunner } from "../core/ports.ts";

export interface InstallContext {
	/** Home directory whose harness configuration is modified. */
	home: string;
	/** Root of the installed audit-trail package. */
	packageRoot: string;
	/** External command runner; required by installers that invoke a harness CLI. */
	runner?: CommandRunner;
}

export interface InstallResult {
	harness: string;
	changed: boolean;
	message: string;
}

export interface HarnessInstaller {
	harness: string;
	description: string;
	/**
	 * True for placeholder entries whose adapter has not shipped yet. Shipped
	 * harnesses (the default) must declare capabilities and register a
	 * conformance driver; the registry-completeness test enforces this flag,
	 * not description wording.
	 */
	planned?: boolean;
	install(ctx: InstallContext): Promise<InstallResult>;
}

export function packageRootFromModule(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

const PI_INSTALL_RECORD_VERSION = 1;

interface PiInstallRecord {
	version: typeof PI_INSTALL_RECORD_VERSION;
	/** Exact extension paths this installer is authorized to replace. */
	managedEntries: string[];
}

interface ExistingFile {
	content: string;
	mode: number;
}

async function existingRegularFile(path: string, label: string, manualInstruction: string): Promise<ExistingFile | undefined> {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`Refusing to modify ${label} because ${path} is a symlink (often a declaratively managed setting). ${manualInstruction}`,
			);
		}
		if (!stat.isFile()) {
			throw new Error(`Refusing to modify ${label} because ${path} is not a regular file. ${manualInstruction}`);
		}
		return { content: await readFile(path, "utf8"), mode: stat.mode & 0o777 };
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertDirectoryOrMissing(path: string, label: string): Promise<void> {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Refusing to use ${label} because ${path} is not an installer-owned regular directory.`);
		}
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.audit-trail-${process.pid}-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function parsePiInstallRecord(content: string, recordPath: string): PiInstallRecord {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error(`Refusing to use malformed Pi installer ownership record ${recordPath}; move or remove it explicitly.`);
	}
	if (
		!value ||
		typeof value !== "object" ||
		(value as any).version !== PI_INSTALL_RECORD_VERSION ||
		!Array.isArray((value as any).managedEntries) ||
		(value as any).managedEntries.some((entry: unknown) => typeof entry !== "string" || entry.length === 0) ||
		new Set((value as any).managedEntries).size !== (value as any).managedEntries.length
	) {
		throw new Error(`Refusing to use incompatible Pi installer ownership record ${recordPath}; move or remove it explicitly.`);
	}
	return value as PiInstallRecord;
}

function lineAndColumn(text: string, offset: number): string {
	const lines = text.slice(0, offset).split(/\r\n|\n|\r/);
	return `line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1}`;
}

function parseSettingsTree(text: string, settingsPath: string, manualInstruction: string): Node {
	const errors: ParseError[] = [];
	const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
	if (!root || errors.length) {
		const first = errors[0];
		const detail = first ? `${printParseErrorCode(first.error)} at ${lineAndColumn(text, first.offset)}` : "empty document";
		throw new Error(`Cannot safely edit ${settingsPath}: invalid JSON/JSONC (${detail}). ${manualInstruction}`);
	}
	if (root.type !== "object") {
		throw new Error(`Cannot safely edit ${settingsPath}: the top-level value must be an object. ${manualInstruction}`);
	}
	const extensionProperties = (root.children ?? []).filter(
		(property) => property.type === "property" && property.children?.[0]?.value === "extensions",
	);
	if (extensionProperties.length > 1) {
		throw new Error(`Cannot safely edit ${settingsPath}: duplicate top-level "extensions" properties are ambiguous. ${manualInstruction}`);
	}
	return root;
}

// jsonc-parser publishes SyntaxKind as an ambient const enum, which cannot be
// imported under verbatimModuleSyntax. These are its stable public token codes.
const JSONC_COMMA_TOKEN = 5;
const JSONC_EOF_TOKEN = 17;

function commaOffset(text: string, start: number, end: number): number | undefined {
	const scanner = createScanner(text, false);
	scanner.setPosition(start);
	for (let token = scanner.scan(); token !== JSONC_EOF_TOKEN && scanner.getTokenOffset() < end; token = scanner.scan()) {
		if (token === JSONC_COMMA_TOKEN) return scanner.getTokenOffset();
	}
	return undefined;
}

function lineStart(text: string, offset: number): number {
	return Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
}

function indentationBefore(text: string, offset: number): string | undefined {
	const start = lineStart(text, offset);
	const prefix = text.slice(start, offset);
	return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

function inferredIndent(text: string, root: Node): string {
	for (const property of root.children ?? []) {
		const indentation = indentationBefore(text, property.offset);
		if (indentation) return indentation;
	}
	return "  ";
}

function applyTextEdits(text: string, edits: Array<{ offset: number; length: number; content: string }>): string {
	return edits
		.sort((a, b) => b.offset - a.offset)
		.reduce((result, edit) => `${result.slice(0, edit.offset)}${edit.content}${result.slice(edit.offset + edit.length)}`, text);
}

/** Append an array item or object property without reformatting surrounding bytes. */
function appendContainerValue(text: string, container: Node, serialized: string, fallbackIndent: string): string {
	const closeOffset = container.offset + container.length - 1;
	const children = container.children ?? [];
	const last = children.at(-1);
	const tailStart = last ? last.offset + last.length : container.offset + 1;
	const trailingComma = commaOffset(text, tailStart, closeOffset) !== undefined;
	const closeIndent = indentationBefore(text, closeOffset);
	const multiline = text.slice(container.offset, closeOffset).includes("\n") || text.slice(container.offset, closeOffset).includes("\r");
	const edits: Array<{ offset: number; length: number; content: string }> = [];

	if (multiline && closeIndent !== undefined) {
		const eol = text.includes("\r\n") ? "\r\n" : "\n";
		const childIndent = last ? indentationBefore(text, last.offset) : undefined;
		const indent = childIndent ?? `${closeIndent}${fallbackIndent}`;
		const closeLineStart = lineStart(text, closeOffset);
		edits.push({
			offset: closeLineStart,
			length: 0,
			content: `${indent}${serialized}${trailingComma ? "," : ""}${eol}`,
		});
	} else {
		const characterBeforeClose = text[closeOffset - 1];
		const spacing = characterBeforeClose && /\s/.test(characterBeforeClose) ? "" : last ? " " : "";
		edits.push({ offset: closeOffset, length: 0, content: `${spacing}${serialized}${trailingComma ? "," : ""}` });
	}
	// Add the separator after queuing the value insertion. If an inline
	// container has no trivia before its closer, both edits share an offset;
	// this order makes the comma land before the new value.
	if (last && !trailingComma) edits.push({ offset: last.offset + last.length, length: 0, content: "," });
	return applyTextEdits(text, edits);
}

function readExtensions(text: string, settingsPath: string, manualInstruction: string): { root: Node; node?: Node; values: string[] } {
	const root = parseSettingsTree(text, settingsPath, manualInstruction);
	const node = findNodeAtLocation(root, ["extensions"]);
	if (!node) return { root, values: [] };
	if (node.type !== "array" || (node.children ?? []).some((child) => child.type !== "string")) {
		throw new Error(`Cannot safely edit ${settingsPath}: top-level "extensions" must be an array of strings. ${manualInstruction}`);
	}
	return { root, node, values: (node.children ?? []).map((child) => child.value as string) };
}

function removeExtensionAt(text: string, settingsPath: string, manualInstruction: string, index: number): string {
	const { node, values } = readExtensions(text, settingsPath, manualInstruction);
	if (!node?.children?.[index]) throw new Error(`Internal Pi installer error: extension index ${index} disappeared`);
	const children = node.children;
	const child = children[index];
	const edits = [{ offset: child.offset, length: child.length, content: "" }];
	if (children.length > 1) {
		const delimiter = index < children.length - 1
			? commaOffset(text, child.offset + child.length, children[index + 1].offset)
			: commaOffset(text, children[index - 1].offset + children[index - 1].length, child.offset);
		if (delimiter === undefined) throw new Error(`Internal Pi installer error: could not locate delimiter for extension index ${index}`);
		edits.push({ offset: delimiter, length: 1, content: "" });
	}
	return applyTextEdits(text, edits);
}

function updatePiSettings(
	original: string | undefined,
	settingsPath: string,
	entry: string,
	managedEntries: ReadonlySet<string>,
): { content: string; replaced: string[] } {
	const manualInstruction = `Add ${JSON.stringify(entry)} to the top-level "extensions" array manually.`;
	if (original === undefined) return { content: `${JSON.stringify({ extensions: [entry] }, null, 2)}\n`, replaced: [] };

	let text = original;
	let { root, node, values } = readExtensions(text, settingsPath, manualInstruction);
	if (!node) {
		const indent = inferredIndent(text, root);
		text = appendContainerValue(text, root, `${JSON.stringify("extensions")}: [${JSON.stringify(entry)}]`, indent);
		return { content: text, replaced: [] };
	}

	const currentIndex = values.indexOf(entry);
	const ownedIndexes = values.flatMap((value, index) => managedEntries.has(value) ? [index] : []);
	const replaced = [...new Set(ownedIndexes.map((index) => values[index]).filter((value) => value !== entry))];
	let retainedIndex = currentIndex;
	if (retainedIndex < 0 && ownedIndexes.length) {
		retainedIndex = ownedIndexes[0];
		const child = node.children![retainedIndex];
		text = applyTextEdits(text, [{ offset: child.offset, length: child.length, content: JSON.stringify(entry) }]);
	}

	for (const index of ownedIndexes.filter((index) => index !== retainedIndex).sort((a, b) => b - a)) {
		text = removeExtensionAt(text, settingsPath, manualInstruction, index);
	}
	({ root, node, values } = readExtensions(text, settingsPath, manualInstruction));
	if (!values.includes(entry)) {
		text = appendContainerValue(text, node!, JSON.stringify(entry), inferredIndent(text, root));
	}

	const final = readExtensions(text, settingsPath, manualInstruction).values;
	if (final.filter((value) => value === entry).length !== 1 || final.some((value) => managedEntries.has(value) && value !== entry)) {
		throw new Error("Internal Pi installer error: localized settings edit did not produce the requested ownership state");
	}
	return { content: text, replaced };
}

/** Registers the Pi extension entry point in `~/.pi/agent/settings.json`. */
export const piInstaller: HarnessInstaller = {
	harness: "pi",
	description: "Register the Pi extension in ~/.pi/agent/settings.json",
	async install(ctx) {
		const agentDir = join(ctx.home, ".pi", "agent");
		const settingsPath = join(agentDir, "settings.json");
		const ownershipDir = join(agentDir, "audit-trail");
		const recordPath = join(ownershipDir, "installed.json");
		const entry = join(ctx.packageRoot, "src", "adapters", "pi.ts");
		const manualInstruction = `Add ${JSON.stringify(entry)} to the top-level "extensions" array manually.`;

		// Preflight every path and parse both documents before the first write.
		const settingsFile = await existingRegularFile(settingsPath, "Pi settings", manualInstruction);
		await assertDirectoryOrMissing(ownershipDir, "Pi installer ownership directory");
		const recordFile = await existingRegularFile(
			recordPath,
			"Pi installer ownership record",
			`Move or remove ${recordPath} explicitly before installing.`,
		);
		const previousRecord = recordFile ? parsePiInstallRecord(recordFile.content, recordPath) : undefined;
		const managedEntries = new Set([...(previousRecord?.managedEntries ?? []), entry]);
		const settingsUpdate = updatePiSettings(settingsFile?.content, settingsPath, entry, managedEntries);
		const nextRecord: PiInstallRecord = { version: PI_INSTALL_RECORD_VERSION, managedEntries: [...managedEntries] };
		const recordContent = `${JSON.stringify(nextRecord, null, 2)}\n`;
		const recordChanged = recordFile?.content !== recordContent;
		const settingsChanged = settingsFile?.content !== settingsUpdate.content;
		if (!recordChanged && !settingsChanged) {
			return { harness: "pi", changed: false, message: `already registered in ${settingsPath}: ${entry}` };
		}

		// Record ownership before settings mutation and retain historical paths.
		// If the second atomic rename is interrupted, the next install can still
		// safely reconcile every path involved without guessing ownership.
		if (recordChanged) await writeAtomic(recordPath, recordContent, recordFile?.mode ?? 0o600);
		if (settingsChanged) await writeAtomic(settingsPath, settingsUpdate.content, settingsFile?.mode ?? 0o600);
		return {
			harness: "pi",
			changed: true,
			message: settingsUpdate.replaced.length
				? `registered ${entry} in ${settingsPath}, replacing recorded ${settingsUpdate.replaced.join(", ")}`
				: settingsChanged
					? `registered ${entry} in ${settingsPath}`
					: `recorded ownership of existing registration in ${settingsPath}: ${entry}`,
		};
	},
};

const OPENCODE_MANAGED_MARKER = "audit-trail-managed:v1";
const OPENCODE_COMMAND_MARKER = `<!-- ${OPENCODE_MANAGED_MARKER} -->\n`;

const OPENCODE_COMMANDS: Record<string, string> = {
	"audit-start": `---
description: Create a new worktree decision audit
---
${OPENCODE_COMMAND_MARKER}Call the audit_start tool with task: $ARGUMENTS

Report the tool output verbatim. If an audit already exists, do not silently resume or reopen it.
`,
	"audit-resume": `---
description: Explicitly join the matching active worktree audit
---
${OPENCODE_COMMAND_MARKER}Call the audit_resume tool with task: $ARGUMENTS

Report the tool output verbatim. Do not change the task name to bypass an identity error.
`,
	"audit-reopen": `---
description: Explicitly restore the matching closed worktree audit
---
${OPENCODE_COMMAND_MARKER}Call the audit_reopen tool with task: $ARGUMENTS

Report the tool output verbatim. Do not change the task name to bypass an identity error.
`,
	"audit-status": `---
description: Show decision-audit status and unresolved decision IDs
---
${OPENCODE_COMMAND_MARKER}Call the audit_status tool with no arguments and report its output verbatim.
`,
	"audit-review": `---
description: Run an independent review of the active decision audit
---
${OPENCODE_COMMAND_MARKER}Call the audit_review tool. If "$ARGUMENTS" is non-empty, pass it as the model argument (provider/model); otherwise omit model so a cross-provider reviewer is selected automatically. When Anthropic is cross-provider, prefer anthropic/claude-fable-5, then anthropic/claude-opus-5. The review may take several minutes. Report the tool output verbatim.
`,
	"audit-abandon": `---
description: Archive an unpublishable audit as abandoned without closing it as complete
---
${OPENCODE_COMMAND_MARKER}Call the audit_abandon tool. Parse "$ARGUMENTS" as the exact task name and a required --reason <text>; pass them as task and reason. Report the tool output verbatim.
`,
	"audit-rollover": `---
description: Archive a rebase-diverged audit and start a linked successor
---
${OPENCODE_COMMAND_MARKER}Call the audit_rollover tool. Parse "$ARGUMENTS" as the exact task name, a required --reason <text>, and an optional --name <successor-task>; pass them as task, reason, and name. Report the tool output verbatim, including the range-diff instruction.
`,
	"audit-publish": `---
description: Publish the audit to the current branch's pull request
---
${OPENCODE_COMMAND_MARKER}Call the audit_publish tool. Parse "$ARGUMENTS" as an optional PR number/URL and optional --set <comment-set-id>. Pass them as selector and commentSetId; omit absent values so the current branch and sole owned set are selected automatically. Report the tool output verbatim.
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

const CODEX_PLUGIN_ENTRY = {
	name: "audit-trail",
	source: { source: "local", path: "./plugins/audit-trail" },
	policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
	category: "Developer Tools",
};

/** Install the package as a local Codex plugin through the personal marketplace. */
export const codexInstaller: HarnessInstaller = {
	harness: "codex",
	description: "Install the Codex plugin through the personal local marketplace",
	async install(ctx) {
		if (!ctx.runner) throw new Error("Codex installation requires a command runner");
		const manifestPath = join(ctx.packageRoot, ".codex-plugin", "plugin.json");
		let manifest: any;
		try {
			manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		} catch (error: any) {
			throw new Error(`Package is missing a readable Codex plugin manifest at ${manifestPath}: ${error?.message ?? error}`);
		}
		if (manifest?.name !== "audit-trail") throw new Error(`Unexpected plugin name in ${manifestPath}: ${String(manifest?.name)}`);

		const probe = await ctx.runner.exec("codex", ["--version"], { timeout: 15_000 });
		if (probe.code !== 0) throw new Error(`codex CLI is unavailable: ${probe.stderr.trim() || `exit ${probe.code}`}`);

		const linkPath = join(ctx.home, "plugins", "audit-trail");
		const marketplacePath = join(ctx.home, ".agents", "plugins", "marketplace.json");
		let linkChanged = false;
		let existingLink;
		try {
			existingLink = await lstat(linkPath);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (existingLink) {
			if (!existingLink.isSymbolicLink()) {
				throw new Error(`Refusing to replace ${linkPath}: it is not a symlink managed by audit-trail.`);
			}
			const target = resolve(dirname(linkPath), await readlink(linkPath));
			if (target !== resolve(ctx.packageRoot)) {
				throw new Error(`Refusing to replace ${linkPath}: it points at a different target (${target}).`);
			}
		} else {
			linkChanged = true;
		}

		let marketplace: any = {
			name: "personal",
			interface: { displayName: "Personal" },
			plugins: [],
		};
		let marketplaceExists = false;
		try {
			marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
			marketplaceExists = true;
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw new Error(`Cannot read ${marketplacePath}: ${error?.message ?? error}`);
		}
		if (typeof marketplace?.name !== "string" || !marketplace.name || !Array.isArray(marketplace.plugins)) {
			throw new Error(`Unexpected personal marketplace structure in ${marketplacePath}`);
		}
		const existingEntry = marketplace.plugins.find((entry: any) => entry?.name === "audit-trail");
		if (
			existingEntry &&
			(existingEntry?.source?.source !== CODEX_PLUGIN_ENTRY.source.source ||
				existingEntry?.source?.path !== CODEX_PLUGIN_ENTRY.source.path)
		) {
			throw new Error(`Refusing to replace the unrelated audit-trail entry in ${marketplacePath}`);
		}
		const marketplaceChanged = !existingEntry || JSON.stringify(existingEntry) !== JSON.stringify(CODEX_PLUGIN_ENTRY);
		const nextMarketplace = marketplaceChanged
			? {
					...marketplace,
					plugins: [
						...marketplace.plugins.filter((entry: any) => entry?.name !== "audit-trail"),
						CODEX_PLUGIN_ENTRY,
					],
				}
			: marketplace;

		// All ownership and structure checks complete before the first write.
		if (linkChanged) {
			await mkdir(dirname(linkPath), { recursive: true });
			await symlink(ctx.packageRoot, linkPath, "dir");
		}
		if (marketplaceChanged || !marketplaceExists) {
			await mkdir(dirname(marketplacePath), { recursive: true });
			await writeFile(marketplacePath, `${JSON.stringify(nextMarketplace, null, 2)}\n`, "utf8");
		}
		const added = await ctx.runner.exec("codex", ["plugin", "add", `audit-trail@${marketplace.name}`], {
			timeout: 60_000,
		});
		if (added.code !== 0) throw new Error(added.stderr.trim() || `codex plugin add exited ${added.code}`);
		return {
			harness: "codex",
			changed: linkChanged || marketplaceChanged,
			message: `${linkChanged || marketplaceChanged ? "installed" : "already installed"} audit-trail@${marketplace.name}; start a new Codex thread, open /hooks, and trust the plugin hooks`,
		};
	},
};

function plannedInstaller(harness: string, issue: string): HarnessInstaller {
	return {
		harness,
		description: `${harness} support ships in ${issue}`,
		planned: true,
		async install() {
			return { harness, changed: false, message: `${harness} support ships in ${issue}; nothing installed` };
		},
	};
}

/** Harness registry; later issues replace planned entries with real installers. */
export const installers: readonly HarnessInstaller[] = [
	piInstaller,
	claudeInstaller,
	codexInstaller,
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
