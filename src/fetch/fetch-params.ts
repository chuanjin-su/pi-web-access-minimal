import { normalizeProxyUrl } from "./utils.ts";

export interface FetchContentParams {
	url?: unknown;
	urls?: unknown;
	forceClone?: unknown;
	prompt?: unknown;
	mode?: unknown;
	answerModel?: unknown;
	auth?: unknown;
	offset?: unknown;
	proxy?: unknown;
}

export interface NormalizedFetchContentParams {
	urlList: string[];
	options: {
		forceClone?: boolean;
		prompt?: string;
		mode?: "readable" | "raw" | "answer";
		answerModel?: string;
		auth?: true | string;
		proxy?: string;
	};
}

export function normalizeFetchContentParams(params: FetchContentParams): NormalizedFetchContentParams {
	const normalizedUrls = uniqueUrls(normalizeUrlArray(params.urls));
	const urlList = normalizedUrls.length > 0 ? normalizedUrls : normalizeSingleUrl(params.url);
	const prompt = normalizeOptionalString(params.prompt);
	const forceClone = typeof params.forceClone === "boolean" ? params.forceClone : undefined;
	const mode = normalizeMode(params.mode);
	const answerModel = normalizeOptionalString(params.answerModel);
	const auth = normalizeAuth(params.auth);
	const proxy = normalizeProxy(params.proxy);

	return {
		urlList,
		options: {
			...(forceClone !== undefined ? { forceClone } : {}),
			...(prompt !== undefined ? { prompt } : {}),
			...(mode !== undefined ? { mode } : {}),
			...(answerModel !== undefined ? { answerModel } : {}),
			...(auth !== undefined ? { auth } : {}),
			...(proxy !== undefined ? { proxy } : {}),
		},
	};
}

function normalizeUrlArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(normalizeSingleUrl);
}

function normalizeSingleUrl(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	return trimmed ? [trimmed] : [];
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function normalizeMode(value: unknown): "readable" | "raw" | "answer" | undefined {
	if (value === undefined) return undefined;
	if (value === "readable" || value === "raw" || value === "answer") return value;
	throw new Error('mode must be "readable", "raw", or "answer"');
}

function normalizeAuth(value: unknown): true | string | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return true;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	throw new Error("auth must be a profile name, true, or false");
}

function normalizeProxy(value: unknown): string | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === null) throw new Error("proxy must be an http(s) or socks proxy URL string");
	const normalized = normalizeProxyUrl(value, "proxy");
	return normalized ?? "";
}

function uniqueUrls(urls: string[]): string[] {
	return [...new Set(urls)];
}
