import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createScanner, findNodeAtLocation, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import type { CommandRunner } from "../core/ports.ts";
import { REVIEW_MODEL_ALLOWLIST_TEXT } from "../core/reviewer-candidates.ts";

export interface InstallContext {
	/** Home directory whose harness configuration is modified. */
	home: string;
	/** CODEX_HOME from the native runner's environment; omitted for its default. */
	codexHome?: string;
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
	prepare(ctx: InstallContext, uninstall: boolean): Promise<() => Promise<InstallResult>>;
	install(ctx: InstallContext): Promise<InstallResult>;
}

function installer(spec: Omit<HarnessInstaller, "install">): HarnessInstaller {
	return { ...spec, async install(ctx) { return (await spec.prepare(ctx, false))(); } };
}

// Paths are installer constants relative to the selected home, not receipt data.
async function checkParents(home: string, path: string): Promise<void> {
	const parent = dirname(path);
	if (parent === resolve(home)) return;
	if (parent === dirname(parent)) throw new Error("Installer path outside home directory");
	await checkParents(home, parent);
	await assertDirectoryOrMissing(parent, "configuration directory");
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
		const bytes = await readFile(path);
		if (!isUtf8(bytes)) throw new Error(`Refusing to modify non-UTF-8 ${label} at ${path}. ${manualInstruction}`);
		return { content: bytes.toString("utf8"), mode: stat.mode & 0o777 };
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
		(value as any).managedEntries.some((entry: unknown) => typeof entry !== "string" || !isAbsolute(entry) || !entry.endsWith("/src/adapters/pi.ts")) ||
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
	const { node } = readExtensions(text, settingsPath, manualInstruction);
	return removeArrayItem(text, node, index);
}

function removeArrayItem(text: string, node: Node | undefined, index: number): string {
	if (!node?.children?.[index]) throw new Error(`Array item ${index} disappeared`);
	const children = node.children;
	const child = children[index];
	const edits = [{ offset: child.offset, length: child.length, content: "" }];
	if (children.length === 1) {
		const comma = commaOffset(text, child.offset + child.length, node.offset + node.length - 1);
		if (comma !== undefined) edits.push({ offset: comma, length: 1, content: "" });
	} else {
		const delimiter = index < children.length - 1
			? commaOffset(text, child.offset + child.length, children[index + 1].offset)
			: commaOffset(text, children[index - 1].offset + children[index - 1].length, child.offset);
		if (delimiter === undefined) throw new Error(`Could not locate delimiter for array index ${index}`);
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
export const piInstaller = installer({
	harness: "pi",
	description: "Register the Pi extension in ~/.pi/agent/settings.json",
	async prepare(ctx, uninstall) {
		const agentDir = join(ctx.home, ".pi", "agent");
		const settingsPath = join(agentDir, "settings.json");
		const ownershipDir = join(agentDir, "audit-trail");
		const recordPath = join(ownershipDir, "installed.json");
		const entry = join(ctx.packageRoot, "src", "adapters", "pi.ts");
		const manualInstruction = `Add ${JSON.stringify(entry)} to the top-level "extensions" array manually.`;

		await checkParents(ctx.home, settingsPath);
		// Preflight every path and parse both documents before the first write.
		const settingsFile = await existingRegularFile(settingsPath, "Pi settings", manualInstruction);
		await assertDirectoryOrMissing(ownershipDir, "Pi installer ownership directory");
		const recordFile = await existingRegularFile(
			recordPath,
			"Pi installer ownership record",
			`Move or remove ${recordPath} explicitly before installing.`,
		);
		const previousRecord = recordFile ? parsePiInstallRecord(recordFile.content, recordPath) : undefined;
		if (uninstall) {
			let content = settingsFile?.content;
			if (previousRecord && content !== undefined) {
				const { values } = readExtensions(content, settingsPath, manualInstruction);
				for (let i = values.length - 1; i >= 0; i--) {
					if (previousRecord.managedEntries.includes(values[i])) content = removeExtensionAt(content, settingsPath, manualInstruction, i);
				}
			}
			return async () => {
				if (content !== undefined && content !== settingsFile?.content) await writeAtomic(settingsPath, content, settingsFile!.mode);
				if (recordFile) await rm(recordPath);
				return { harness: "pi", changed: !!recordFile, message: recordFile ? "unregistered" : "not managed" };
			};
		}
		const managedEntries = new Set([...(previousRecord?.managedEntries ?? []), entry]);
		const settingsUpdate = updatePiSettings(settingsFile?.content, settingsPath, entry, managedEntries);
		const nextRecord: PiInstallRecord = { version: PI_INSTALL_RECORD_VERSION, managedEntries: [...managedEntries] };
		const recordContent = `${JSON.stringify(nextRecord, null, 2)}\n`;
		const recordChanged = recordFile?.content !== recordContent;
		const settingsChanged = settingsFile?.content !== settingsUpdate.content;
		return async () => {
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
		};
	},
});

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
${OPENCODE_COMMAND_MARKER}Call the audit_review tool without a model so Audit Trail selects automatically from its maintained allowlist (${REVIEW_MODEL_ALLOWLIST_TEXT}). If "$ARGUMENTS" explicitly pins a model, pass it as provider/model; unsupported families are rejected. The review may take several minutes. Report the tool output verbatim.
`,
	"audit-abandon": `---
description: Archive an unpublishable audit as abandoned without closing it as complete
---
${OPENCODE_COMMAND_MARKER}Call the audit_abandon tool. Parse "$ARGUMENTS" as the exact task name and a required --reason <text>; pass them as task and reason. Report the tool output verbatim.
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
	if (path.endsWith("/plugins/audit-trail.ts")) {
		if (existing.startsWith(`// ${OPENCODE_MANAGED_MARKER}\n`)) return true;
		const suffix = existing.match(/export \{ AuditTrailPlugin \} from ("[^\n]+");\n$/)?.[1];
		if (!suffix) return false;
		try {
			const entry = JSON.parse(suffix);
			const shim = opencodePluginShim(resolve(dirname(entry), "../.."));
			return existing === shim.slice(shim.indexOf("\n") + 1);
		} catch { return false; }
	}
	// Only the description may vary between versions of the generated header.
	const header = desired.slice(0, desired.indexOf(OPENCODE_COMMAND_MARKER) + OPENCODE_COMMAND_MARKER.length);
	const normalizeDescription = (text: string) => text.replace(/^(---\ndescription: )[^\n]+\n/, "$1\n");
	return existing === desired.replace(OPENCODE_COMMAND_MARKER, "") ||
		normalizeDescription(existing).startsWith(normalizeDescription(header));
}

export const opencodeInstaller = installer({
	harness: "opencode",
	description: "Install the OpenCode plugin shim and /audit-* commands under ~/.config/opencode",
	async prepare(ctx, uninstall) {
		const configDir = join(ctx.home, ".config", "opencode");
		const managed = new Map<string, string>([
			[join(configDir, "plugins", "audit-trail.ts"), opencodePluginShim(ctx.packageRoot)],
			...Object.entries(OPENCODE_COMMANDS).map(
				([name, content]): [string, string] => [join(configDir, "commands", `${name}.md`), content],
			),
		]);
		const pending: Array<() => Promise<void>> = [];
		const collisions: string[] = [];
		for (const [path, content] of managed) {
			await checkParents(ctx.home, path);
			const file = await existingRegularFile(path, "OpenCode file", "Move the collision explicitly.");
			if (file && !isManagedOpencodeFile(path, file.content, content)) {
				collisions.push(path);
				continue;
			}
			if (uninstall && file) pending.push(() => rm(path));
			if (!uninstall && file?.content !== content) pending.push(() => writeAtomic(path, content, file?.mode ?? 0o644));
		}
		if (collisions.length) throw new Error(`Refusing to overwrite OpenCode files not managed by audit-trail: ${collisions.join(", ")}`);
		return async () => {
			for (const apply of pending) await apply();
			return { harness: "opencode", changed: !!pending.length, message: pending.length ? `updated ${pending.length} files under ${configDir}` : uninstall ? "not installed" : "already installed" };
		};
	},
});

const CODEX_PLUGIN_ENTRY = {
	name: "audit-trail",
	source: { source: "local", path: "./plugins/audit-trail" },
	policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
	category: "Developer Tools",
};

function parseDocument(content: string, path: string): any {
	try { return JSON.parse(content); }
	catch { throw new Error(`Invalid JSON in ${path}; resolve the collision manually.`); }
}

function rejectDuplicateKeys(node: Node, path: string): void {
	const children = node.children ?? [];
	if (node.type === "object" && new Set(children.map(p => p.children![0].value)).size !== children.length) {
		throw new Error(`Ambiguous duplicate keys in ${path}`);
	}
	for (const child of children) rejectDuplicateKeys(child, path);
}

async function codexProfile(ctx: InstallContext): Promise<string> {
	const selected = ctx.codexHome || join(ctx.home, ".codex");
	if (!ctx.codexHome) await assertDirectoryOrMissing(selected, "default Codex profile");
	let bytes: Buffer;
	try {
		bytes = await realpath(selected, { encoding: "buffer" });
	} catch (error: any) {
		// Only the implicit default may be created by Codex on first use.
		if (ctx.codexHome || error.code !== "ENOENT") throw error;
		bytes = Buffer.concat([await realpath(ctx.home, { encoding: "buffer" }), Buffer.from("/.codex")]);
	}
	if (!isUtf8(bytes)) throw new Error("Cannot record a non-UTF-8 Codex profile");
	const physical = bytes.toString("utf8");
	await assertDirectoryOrMissing(physical, "resolved Codex profile");
	return physical;
}

function pluginInstaller(harness: "claude" | "codex"): HarnessInstaller {
	return installer({
		harness,
		description: `Register the ${harness} plugin`,
		async prepare(ctx, uninstall) {
			const codex = harness === "codex";
			const link = codex ? join(ctx.home, "plugins/audit-trail") : join(ctx.home, ".claude/skills/audit-trail");
			const receipt = join(ctx.home, ".local/state/audit-trail", `${harness}.json`);
			await checkParents(ctx.home, link);
			await checkParents(ctx.home, receipt);
			if (!uninstall) {
				const manifest = JSON.parse(await readFile(join(ctx.packageRoot, `.${harness}-plugin/plugin.json`), "utf8"));
				if (manifest?.name !== "audit-trail") throw new Error(`Unexpected plugin name in ${harness} manifest`);
			}
			const file = await existingRegularFile(receipt, "plugin ownership record", "Resolve the collision manually.");
			const previous = file && parseDocument(file.content, receipt);
			if (file && (previous?.version !== 1 || typeof previous.target !== "string" || !isAbsolute(previous.target) ||
				(codex && (typeof previous.market !== "string" || !previous.market)))) throw new Error(`Malformed ownership record: ${receipt}`);
			if (uninstall && !file) return async () => ({ harness, changed: false, message: "not managed" });
			const target = resolve(ctx.packageRoot);
			let current: Buffer | undefined;
			try {
				current = await readlink(link, { encoding: "buffer" });
			} catch (error: any) {
				if (error.code === "EINVAL") throw new Error(`Refusing to replace ${link}: not a symlink`);
				if (error.code !== "ENOENT") throw error;
			}
			if (current && !current.equals(Buffer.from(previous?.target ?? target))) {
				throw new Error(`Refusing to replace ${link}: ownership cannot be proven`);
			}
			const currentTarget = current?.equals(Buffer.from(target));
			const marketplacePath = join(ctx.home, ".agents/plugins/marketplace.json");
			let market: string | undefined;
			let profile: string | undefined;
			let updateMarket: (() => Promise<void>) | undefined;
			if (codex) {
				profile = await codexProfile(ctx);
				if (previous && previous.profile !== profile) throw new Error("Codex profile differs from installer receipt; select the original CODEX_HOME.");
				if (!ctx.runner || (await ctx.runner.exec("codex", ["--version"], { timeout: 15000 })).code !== 0) throw new Error("codex CLI is unavailable");
				await checkParents(ctx.home, marketplacePath);
				const existing = await existingRegularFile(marketplacePath, "Codex marketplace", "Resolve the collision manually.");
				const doc = existing ? parseDocument(existing.content, marketplacePath) : { name: previous?.market ?? "personal", interface: { displayName: "Personal" }, plugins: [] };
				if (typeof doc?.name !== "string" || !doc.name || !Array.isArray(doc.plugins) || (previous && previous.market !== doc.name)) {
					throw new Error(`Unexpected personal marketplace structure or identity in ${marketplacePath}`);
				}
				const original = existing?.content ?? JSON.stringify(doc, null, 2) + "\n";
				const root = parseTree(original)!;
				rejectDuplicateKeys(root, marketplacePath);
				const plugins = findNodeAtLocation(root, ["plugins"])!;
				market = doc.name;
				const matches = doc.plugins.filter((entry: any) => entry?.name === "audit-trail");
				if (matches.length > 1 || (matches.length && !isDeepStrictEqual(matches[0], CODEX_PLUGIN_ENTRY))) {
					throw new Error(`Refusing to replace the unrelated audit-trail entry in ${marketplacePath}`);
				}
				if (uninstall ? matches.length : !matches.length) {
					const updated = uninstall
						? removeArrayItem(original, plugins, doc.plugins.indexOf(matches[0]))
						: appendContainerValue(original, plugins, JSON.stringify(CODEX_PLUGIN_ENTRY), inferredIndent(original, root));
					updateMarket = () => writeAtomic(marketplacePath, updated, existing?.mode ?? 0o600);
				}
			}
			const native = async (verb: "add" | "remove") => {
				const result = await ctx.runner!.exec("codex", ["plugin", verb, `audit-trail@${market}`], { timeout: 60000 });
				if (result.code !== 0) throw new Error(`codex plugin ${verb} exited ${result.code}`);
			};
			return async () => {
				if (uninstall && codex) await native("remove");
				if (current && (uninstall || !currentTarget)) await rm(link);
				if (!uninstall) {
					if (previous?.target !== target) await writeAtomic(receipt, JSON.stringify({ version: 1, target, market, profile }) + "\n", 0o600);
					if (!currentTarget) {
						await mkdir(dirname(link), { recursive: true });
						await symlink(target, link, "dir");
					}
				}
				await updateMarket?.();
				if (!uninstall && codex) await native("add");
				if (uninstall) await rm(receipt);
				const changed = uninstall || previous?.target !== target || !currentTarget || !!updateMarket;
				return { harness, changed, message: uninstall ? "unregistered" : codex ? `registered audit-trail@${market}; start a new thread and trust /hooks` : changed ? `linked ${link}` : "already linked" };
			};
		},
	});
}

export const claudeInstaller = pluginInstaller("claude");
export const codexInstaller = pluginInstaller("codex");

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
