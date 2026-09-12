import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "../fetch/activity.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";
import { redactCredential, resolveCredential } from "../fetch/credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveApiBaseUrl } from "../fetch/utils.ts";

const EXA_API_BASE_URL = "https://api.exa.ai";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const CONFIG_PATH = getWebSearchConfigPath();
const EXA_MCP_ADVANCED_TOOL = "web_search_advanced_exa";
const EXA_MCP_BASIC_TOOL = "web_search_exa";

interface WebSearchConfig {
	exaApiKey?: unknown;
	exaBaseUrl?: unknown;
}

interface ExaAnswerResponse {
	answer?: string;
	citations?: Array<{ url?: string; title?: string }>;
}

interface ExaSearchResponse {
	results?: Array<{
		title?: string;
		url?: string;
		text?: string;
		highlights?: unknown;
	}>;
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

export interface ExaSearchOptions extends SearchOptions {
}

type McpParsedResult = { title: string; url: string; content: string };

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Exa",
		configuredValue: loadConfig().exaApiKey,
		environmentValue: process.env.EXA_API_KEY,
		signal,
	});
}

function getApiBaseUrl(): string {
	return resolveApiBaseUrl({
		configKey: "exaBaseUrl",
		configuredValue: loadConfig().exaBaseUrl,
		defaultValue: EXA_API_BASE_URL,
		environmentKey: "EXA_BASE_URL",
		environmentValue: process.env.EXA_BASE_URL,
	});
}

function exaApiHeaders(apiKey: string): Record<string, string> {
	return {
		"x-api-key": apiKey,
		"Content-Type": "application/json",
		"x-exa-integration": "pi-web-access-minimal",
	};
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(includeDomains.length ? { includeDomains } : {}),
		...(excludeDomains.length ? { excludeDomains } : {}),
	};
}

function exaSearchArgs(query: string, options: ExaSearchOptions): Record<string, unknown> {
	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
	return {
		query,
		type: "auto",
		numResults: options.numResults ?? 5,
		...mapDomainFilter(options.domainFilter),
		...(startDate ? { startPublishedDate: startDate } : {}),
	};
}

function normalizeHighlights(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function buildAnswerFromSearchResults(results: ExaSearchResponse["results"]): string {
	if (!results?.length) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		const content = highlights.length > 0
			? highlights.join(" ")
			: typeof item.text === "string" ? item.text.trim().slice(0, 1000) : "";
		if (!content) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${content}\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: ExaSearchResponse["results"] | ExaAnswerResponse["citations"]): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: "",
		});
	}
	return mapped;
}

export async function callExaMcp(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(`${EXA_MCP_URL}?tools=${toolName}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"x-exa-source": "pi-web-access-minimal",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429) {
			throw new Error(
				`Exa MCP rate limit reached (429). Add "exaApiKey" to ${CONFIG_PATH} for unthrottled Exa search: ${errorText.slice(0, 200)}`,
			);
		}
		throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();
	const dataLines = body.split("\n").filter(line => line.startsWith("data:"));

	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
		}
	}

	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
			}
		} catch {
		}
	}

	if (!parsed) {
		throw new Error("Exa MCP returned an empty response");
	}

	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		const message = parsed.error.message || "Unknown error";
		throw new Error(`Exa MCP error${code}: ${message}`);
	}

	if (parsed.result?.isError) {
		const message = parsed.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text?.trim();
		throw new Error(message || "Exa MCP returned an error");
	}

	const text = parsed.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw new Error("Exa MCP returned empty content");
	}

	return text;
}

function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim().length > 0);
	const parsed = blocks.map(block => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			content = block.slice(textStart + 7).trim();
		} else {
			const hlMatch = block.match(/\nHighlights:\s*\n/);
			if (hlMatch?.index != null) {
				content = block.slice(hlMatch.index + hlMatch[0].length).trim();
			}
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title, url, content };
	}).filter(result => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
	if (results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
		if (!snippet) continue;
		const sourceTitle = result.title || `Source ${i + 1}`;
		parts.push(`${snippet}\nSource: ${sourceTitle} (${result.url})`);
	}
	return parts.join("\n\n");
}

function buildMcpQuery(query: string, options: ExaSearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day": parts.push("past 24 hours"); break;
			case "week": parts.push("past week"); break;
			case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
			case "year": parts.push(String(now.getFullYear())); break;
		}
	}
	return parts.join(" ");
}

function isAbortMessage(message: string): boolean {
	return message.toLowerCase().includes("abort");
}

function parseJsonMcpResults(text: string): ExaSearchResponse["results"] | null {
	try {
		const results = (JSON.parse(text) as ExaSearchResponse).results;
		return Array.isArray(results) && results.length > 0 ? results : null;
	} catch {
		return null;
	}
}

/**
 * Calls one Exa MCP search tool and normalizes its payload. `web_search_advanced_exa`
 * returns the raw Exa search JSON; `web_search_exa` returns a formatted text block.
 */
async function searchWithExaMcpTool(
	tool: string,
	args: Record<string, unknown>,
): Promise<SearchResponse> {
	const text = await callExaMcp(tool, args);

	const jsonResults = parseJsonMcpResults(text);
	if (jsonResults) {
		return {
			answer: buildAnswerFromSearchResults(jsonResults),
			results: mapResults(jsonResults),
		};
	}

	const textResults = parseMcpResults(text);
	if (!textResults) {
		throw new Error("Exa MCP returned an unparseable response");
	}

	return {
		answer: buildAnswerFromMcpResults(textResults),
		results: mapResults(textResults),
	};
}

/** Filtered searches need the advanced tool, which not every deployment exposes. */
async function searchWithFilteredExaMcp(
	query: string,
	options: ExaSearchOptions,
	basicArgs: Record<string, unknown>,
): Promise<SearchResponse> {
	try {
		return await searchWithExaMcpTool(EXA_MCP_ADVANCED_TOOL, {
			...exaSearchArgs(query, options),
			enableHighlights: true,
			textMaxCharacters: 3000,
		});
	} catch (err) {
		if (isAbortMessage(err instanceof Error ? err.message : String(err))) throw err;
		// The basic tool ignores every argument except query/numResults, so the
		// filters degrade into the query text.
		return searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs);
	}
}

async function searchWithExaMcp(query: string, options: ExaSearchOptions = {}): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	const basicArgs = { query: buildMcpQuery(query, options), numResults: options.numResults ?? 5 };
	const filtered = !!options.recencyFilter || !!options.domainFilter?.length;

	try {
		const response = filtered
			? await searchWithFilteredExaMcp(query, options, basicArgs)
			: await searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs);
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (isAbortMessage(message)) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

/** Exa is always available: the keyless MCP endpoint needs no credentials. */
export function isExaAvailable(): boolean {
	return true;
}

export async function searchWithExa(query: string, options: ExaSearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await getApiKey(options.signal);
	if (!apiKey) {
		return searchWithExaMcp(query, options);
	}

	const apiBaseUrl = getApiBaseUrl();
	const useSearch = !!options.recencyFilter
		|| !!options.domainFilter?.length
		|| !!(options.numResults && options.numResults !== 5);

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		if (!useSearch) {
			const response = await fetchWithCredentialRedirects(`${apiBaseUrl}/answer`, {
				method: "POST",
				headers: exaApiHeaders(apiKey),
				body: JSON.stringify({ query }),
				signal: requestSignal(options.signal),
			}, ["x-api-key"]);

			if (!response.ok) {
				const errorText = redactCredential(await response.text(), apiKey);
				throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
			}

			const data = await response.json() as ExaAnswerResponse;
			activityMonitor.logComplete(activityId, response.status);
			return {
				answer: data.answer || "",
				results: mapResults(data.citations),
			};
		}

		const response = await fetchWithCredentialRedirects(`${apiBaseUrl}/search`, {
			method: "POST",
			headers: exaApiHeaders(apiKey),
			body: JSON.stringify({
				...exaSearchArgs(query, options),
				contents: { highlights: true },
			}),
			signal: requestSignal(options.signal),
		}, ["x-api-key"]);

		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as ExaSearchResponse;
		activityMonitor.logComplete(activityId, response.status);

		return {
			answer: buildAnswerFromSearchResults(data.results),
			results: mapResults(data.results),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (isAbortMessage(redactedMessage)) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		throw new Error(redactedMessage);
	}
}
