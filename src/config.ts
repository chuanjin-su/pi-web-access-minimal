import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./fetch/utils.ts";

export interface MinimalWebSearchConfig {
	searchProvider?: "openai" | "brave" | "exa";
	proxy?: string;
	maxInlineContentChars?: number;
}

const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

export function loadSearchProviderConfig(): MinimalWebSearchConfig {
	const path = getWebSearchConfigPath();
	if (!existsSync(path)) return {};

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid config in ${path}: expected a JSON object`);
	}
	const config = raw as Record<string, unknown>;

	const result: MinimalWebSearchConfig = {};

	if (config.searchProvider !== undefined || config.provider !== undefined) {
		const value = config.searchProvider ?? config.provider;
		if (typeof value !== "string" || (value !== "openai" && value !== "brave" && value !== "exa")) {
			throw new Error(`searchProvider in ${path} must be "openai", "brave", or "exa"`);
		}
		result.searchProvider = value;
	}

	if (config.proxy !== undefined) {
		if (typeof config.proxy !== "string") {
			throw new Error(`proxy in ${path} must be an http(s) or socks proxy URL string`);
		}
		result.proxy = config.proxy;
	}

	if (config.maxInlineContentChars !== undefined) {
		const value = config.maxInlineContentChars;
		if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
			throw new Error(`maxInlineContentChars in ${path} must be a positive integer`);
		}
		result.maxInlineContentChars = Math.min(value, MAX_INLINE_CONTENT_CHARS);
	}

	return result;
}

export function getMaxInlineContentChars(config = loadSearchProviderConfig()): number {
	return config.maxInlineContentChars ?? DEFAULT_MAX_INLINE_CONTENT_CHARS;
}

export function DEFAULT_INLINE_CHARS(): number {
	return DEFAULT_MAX_INLINE_CONTENT_CHARS;
}
