import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanCell } from "./paths.ts";
import { directMutationQueue, type MutationQueue } from "./ports.ts";
import {
	AUDIT_HEADER,
	CONFIDENCE_VALUES,
	ORIGIN_VALUES,
	RESULT_VALUES,
	type AuditRow,
	type ConfidenceValue,
	type NewAuditRow,
	type OriginValue,
	type ResultValue,
} from "./types.ts";

/**
 * Atomic replacement write (temp file + rename in the same directory). The
 * audit log must never be truncated in place: a crash mid-write would destroy
 * previously committed rows, and lock-free readers (status, publish) must
 * always observe a complete file, never a torn write.
 */
async function writeFileAtomic(path: string, data: string): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	await writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
	await rename(temp, path);
}

export function parseRows(text: string, source = "audit TSV"): AuditRow[] {
	const lines = text.split(/\r?\n/).filter(Boolean);
	if (lines.length === 0) return [];
	if (lines[0] !== AUDIT_HEADER) throw new Error(`Unexpected audit header in ${source}`);

	return lines.slice(1).map((line, index) => {
		const cells = line.split("\t");
		if (cells.length !== 13) throw new Error(`Malformed audit row ${index + 2} in ${source}`);
		if (!ORIGIN_VALUES.includes(cells[5] as OriginValue)) {
			throw new Error(`Invalid decision origin at line ${index + 2} in ${source}`);
		}
		return {
			id: cells[0],
			ts: cells[1],
			session: cells[2],
			entry: cells[3],
			phase: cells[4],
			origin: cells[5] as OriginValue,
			decision: cells[6],
			why: cells[7],
			alternatives: cells[8],
			confidence: cells[9] as ConfidenceValue,
			evidence: cells[10],
			result: cells[11] as ResultValue,
			supersedes: cells[12],
		};
	});
}

export function serializeRow(row: AuditRow): string {
	return [
		row.id,
		row.ts,
		row.session,
		row.entry,
		row.phase,
		row.origin,
		row.decision,
		row.why,
		row.alternatives,
		row.confidence,
		row.evidence,
		row.result,
		row.supersedes,
	]
		.map(cleanCell)
		.join("\t");
}

export async function readRows(logPath: string): Promise<AuditRow[]> {
	try {
		return parseRows(await readFile(logPath, "utf8"), logPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

export class AuditStore {
	private readonly mutationQueue: MutationQueue;
	private readonly now: () => Date;

	constructor(mutationQueue: MutationQueue = directMutationQueue, now: () => Date = () => new Date()) {
		this.mutationQueue = mutationQueue;
		this.now = now;
	}

	readRows(logPath: string): Promise<AuditRow[]> {
		return readRows(logPath);
	}

	createLog(logPath: string): Promise<void> {
		return this.mutationQueue(logPath, async () => {
			await mkdir(dirname(logPath), { recursive: true });
			try {
				await writeFile(logPath, `${AUDIT_HEADER}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			} catch (error: any) {
				if (error?.code === "EEXIST") {
					throw new Error(`Audit log already exists without reusable lifecycle state: ${logPath}`);
				}
				throw error;
			}
		});
	}

	appendRow(logPath: string, row: NewAuditRow): Promise<AuditRow> {
		return this.mutationQueue(logPath, async () => {
			// Enum fields are validated at this single chokepoint so every harness
			// boundary shares the same rejection: a row that bypassed harness-side
			// schema validation would otherwise poison the TSV and make every
			// subsequent parseRows read fail.
			if (!(ORIGIN_VALUES as readonly string[]).includes(row.origin)) {
				throw new Error(`Invalid decision origin: ${row.origin}. Expected one of: ${ORIGIN_VALUES.join(", ")}`);
			}
			if (!(CONFIDENCE_VALUES as readonly string[]).includes(row.confidence)) {
				throw new Error(`Invalid decision confidence: ${row.confidence}. Expected one of: ${CONFIDENCE_VALUES.join(", ")}`);
			}
			if (!(RESULT_VALUES as readonly string[]).includes(row.result)) {
				throw new Error(`Invalid decision result: ${row.result}. Expected one of: ${RESULT_VALUES.join(", ")}`);
			}
			await mkdir(dirname(logPath), { recursive: true });
			const rows = await readRows(logPath);
			if (row.supersedes && !rows.some((candidate) => candidate.id === row.supersedes)) {
				throw new Error(`Cannot supersede unknown decision ${row.supersedes}`);
			}

			const maxId = rows.reduce((max, candidate) => {
				const match = /^D(\d+)$/.exec(candidate.id);
				return match ? Math.max(max, Number(match[1])) : max;
			}, 0);
			const complete: AuditRow = {
				id: `D${String(maxId + 1).padStart(4, "0")}`,
				ts: this.now().toISOString(),
				...row,
			};
			const current = await readFile(logPath, "utf8").catch((error: any) => {
				if (error?.code === "ENOENT") return "";
				throw error;
			});
			const existing = current || `${AUDIT_HEADER}\n`;
			await writeFileAtomic(
				logPath,
				`${existing.endsWith("\n") ? existing : `${existing}\n`}${serializeRow(complete)}\n`,
			);
			return complete;
		});
	}
}
