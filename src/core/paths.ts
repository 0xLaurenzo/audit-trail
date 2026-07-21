import { isAbsolute, relative } from "node:path";

export function cleanCell(value: unknown): string {
	let text = String(value ?? "")
		.replace(/[\t\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	return text;
}

export function safeSlug(input: string, now = new Date()): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || `audit-${now.toISOString().slice(0, 10)}`;
}

export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
