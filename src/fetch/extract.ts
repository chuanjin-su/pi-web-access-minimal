import { existsSync, readFileSync } from "node:fs";
import type TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { extractPDFToMarkdown, isPDF, loadPDFConfig } from "./pdf-extract.ts";
import { extractGitHub } from "./github-extract.ts";
import { extractGitHubIssuePr } from "./github-issue-pr.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { appendDeclaredWebLinks, discoverDeclaredWebLinks, type DeclaredWebLink } from "./declared-web-links.ts";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl, type DomainPolicy, type Lookup, type SsrfConfig } from "./ssrf-protection.ts";
import { getWebSearchConfigPath, type ProxiedRequestInit } from "./utils.ts";
import { isImageEnabled } from "./feature-config.ts";
import { assertAuthFetchUrl, authFetchRedirectGuard, type AuthFetchProfile } from "./auth-fetch.ts";
import { getBrowserCookiesForHosts, getLastBrowserCookieDiagnostic } from "./chrome-cookies.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_CONFIGURED_TIMEOUT_MS = 2_147_483_647;
const CONCURRENT_LIMIT = 3;
const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

function loadFetchTimeoutMs(): number {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return DEFAULT_TIMEOUT_MS;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}

	const fetchConfig = (raw as Record<string, unknown>).fetch;
	if (fetchConfig === undefined) return DEFAULT_TIMEOUT_MS;
	if (!fetchConfig || typeof fetchConfig !== "object" || Array.isArray(fetchConfig)) {
		throw new Error(`fetch in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const value = (fetchConfig as Record<string, unknown>).timeout;
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid fetch.timeout in ${WEB_SEARCH_CONFIG_PATH}: expected a positive finite number of seconds, got ${JSON.stringify(value)}`);
	}
	const timeoutMs = Math.ceil(value * 1000);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CONFIGURED_TIMEOUT_MS) {
		throw new Error(`Invalid fetch.timeout in ${WEB_SEARCH_CONFIG_PATH}: converted timeout must be a finite safe integer from 1 through ${MAX_CONFIGURED_TIMEOUT_MS} milliseconds`);
	}
	return Math.max(1, timeoutMs);
}

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large", "PDF extraction is disabled", "Image fetching is disabled"];
const MIN_USEFUL_CONTENT = 500;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FETCH_PROVIDERS = ["http", "jina"] as const;
type FetchProvider = typeof FETCH_PROVIDERS[number];
type FetchRouting = { providers: FetchProvider[]; allowRemoteHostedProviders: boolean };
const DEFAULT_FETCH_PROVIDER_ORDER: FetchProvider[] = ["http", "jina"];
const REMOTE_HOSTED_FETCH_PROVIDERS = new Set<FetchProvider>(["jina"]);

function isDefuddleConsoleError(args: Parameters<typeof console.error>): boolean {
	const prefix = args[0];
	return prefix === "Defuddle" || (typeof prefix === "string" && /^Defuddle(?:\s|:)/.test(prefix));
}

async function extractWithDefuddle(text: string, url: string): Promise<{ title: string; content: string } | null> {
	const { Defuddle } = await import("defuddle/node");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(text);
	Object.defineProperty(document, "location", {
		value: new URL(url),
		configurable: true,
	});
	let processingError: unknown;
	const originalConsoleError = console.error;
	console.error = (...args) => {
		if (isDefuddleConsoleError(args)) {
			if (args[0] === "Defuddle" && args[1] === "Error processing document:") {
				processingError = args[2];
			}
			return;
		}
		originalConsoleError(...args);
	};

	let resultPromise: ReturnType<typeof Defuddle>;
	try {
		// With useAsync:false, Defuddle parses synchronously before returning its promise.
		// Keep the console interception limited to that call so unrelated Pi output is
		// never routed through this fallback's handler.
		resultPromise = Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false });
	} finally {
		console.error = originalConsoleError;
	}

	const result = await resultPromise;
	if (processingError !== undefined) {
		throw new Error(`Defuddle failed to process document: ${errorMessage(processingError)}`);
	}
	return typeof result.content === "string" ? { title: result.title, content: result.content } : null;
}

export { loadSsrfConfig } from "./ssrf-protection.ts";

export function loadSsrfAllowRanges(): string[] {
	return loadSsrfConfig().allowRanges;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function isAbortException(err: unknown): boolean {
	return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

function isRedirectPolicyError(message: string): boolean {
	return message.startsWith("Authenticated fetch refused cross-origin redirect") ||
		message.startsWith("Blocked internal ") ||
		message.startsWith("Blocked hostname by fetch_content domain policy") ||
		message.startsWith("Hostname not allowed by fetch_content domain policy") ||
		message.startsWith("Too many redirects fetching ") ||
		message === "Only HTTP and HTTPS URLs can be fetched remotely" ||
		message === "URL must include a hostname" ||
		message.startsWith("Failed to resolve ");
}

function imageGateError(): string | null {
	try {
		return isImageEnabled() ? null : "Image fetching is disabled by image.enabled";
	} catch (err) {
		return errorMessage(err);
	}
}

async function resolveAuthCookieHeader(url: string | URL, profile: AuthFetchProfile): Promise<string> {
	const parsed = assertAuthFetchUrl(profile, url.toString());
	const result = await getBrowserCookiesForHosts({ hosts: [parsed.hostname], profile: profile.chromeProfile, requestUrl: parsed });
	if (result?.cookieHeader) return result.cookieHeader;
	if (!result) {
		const diagnostic = getLastBrowserCookieDiagnostic();
		throw new Error(`Authenticated fetch profile ${profile.name} could not read browser cookies${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	throw new Error(`Authenticated fetch profile ${profile.name} could not build a cookie header`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchAuthenticatedRemoteUrl(
	url: string,
	init: RequestInit,
	validationOptions: { ssrf: SsrfConfig; domainPolicy: DomainPolicy; lookup?: Lookup },
	profile: AuthFetchProfile,
): Promise<Response> {
	let current = await validateRemoteUrl(url, {
		allowRanges: validationOptions.ssrf.allowRanges,
		trustEnvProxy: validationOptions.ssrf.trustEnvProxy,
		domainPolicy: validationOptions.domainPolicy,
		...(validationOptions.lookup ? { lookup: validationOptions.lookup } : {}),
	});
	let requestInit = init;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const cookieHeader = await resolveAuthCookieHeader(current, profile);
		const headers = { ...(requestInit.headers as Record<string, string>), cookie: cookieHeader };
		const response = await fetch(current, { ...requestInit, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === 5) throw new Error(`Too many redirects fetching ${current.toString()}`);
		const from = current;
		current = await validateRemoteUrl(new URL(location, current), {
			allowRanges: validationOptions.ssrf.allowRanges,
			trustEnvProxy: validationOptions.ssrf.trustEnvProxy,
			domainPolicy: validationOptions.domainPolicy,
			...(validationOptions.lookup ? { lookup: validationOptions.lookup } : {}),
		});
		authFetchRedirectGuard(profile, from, current);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function loadFetchRouting(): FetchRouting {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}

	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}

	if (!Object.hasOwn(raw, "fetchRouting")) {
		return { providers: DEFAULT_FETCH_PROVIDER_ORDER, allowRemoteHostedProviders: false };
	}
	const routing = raw.fetchRouting;
	if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
		throw new Error(`fetchRouting in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}

	const routingConfig = routing as Record<string, unknown>;
	const providersValue = routingConfig.providers;
	let providers = DEFAULT_FETCH_PROVIDER_ORDER;
	if (providersValue !== undefined) {
		if (!Array.isArray(providersValue) || providersValue.length === 0) {
			throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array`);
		}

		providers = [];
		for (const provider of providersValue) {
			const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
			if (!FETCH_PROVIDERS.includes(normalized as FetchProvider)) {
				throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} contains an invalid provider: ${String(provider)}`);
			}
			if (providers.includes(normalized as FetchProvider)) {
				throw new Error(`fetchRouting.providers in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: ${normalized}`);
			}
			providers.push(normalized as FetchProvider);
		}
	}

	const allowRemoteHostedProvidersValue = routingConfig.allowRemoteHostedProviders;
	if (allowRemoteHostedProvidersValue !== undefined && typeof allowRemoteHostedProvidersValue !== "boolean") {
		throw new Error(`fetchRouting.allowRemoteHostedProviders in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`);
	}

	return { providers, allowRemoteHostedProviders: allowRemoteHostedProvidersValue === true };
}

/** Names of the search/fetch tools the caller has actually registered, so
 * failure guidance never points at tools that do not exist in the session. */
export interface RegisteredToolNames {
	webSearch?: string;
	fetchContent?: string;
}

/** Guidance for definitive origin 404/410 responses: no extraction provider
 * can retrieve a page the origin says is gone, so point at the registered
 * search/fetch tools (when the caller knows them) instead of provider config. */
function notFoundGuidance(result: ExtractedContent, toolNames?: RegisteredToolNames): string {
	const lines = [
		result.error ?? `HTTP ${result.status}`,
		"",
		`The origin server says this page does not exist (HTTP ${result.status}), so extraction providers cannot retrieve it.`,
	];
	if (toolNames?.webSearch && toolNames.fetchContent) {
		lines.push(`The page may have moved or been renamed. Use ${toolNames.webSearch} to find the current URL, then retry ${toolNames.fetchContent} with it.`);
	} else if (toolNames?.webSearch) {
		lines.push(`The page may have moved or been renamed. Use ${toolNames.webSearch} to find the current URL.`);
	} else {
		lines.push("The page may have moved or been renamed. Find the current URL, then retry the fetch with it.");
	}
	return lines.join("\n");
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

// Share first-use initialization without loading Turndown at extension startup.
let turndownInstance: Promise<TurndownService> | undefined;
async function loadTurndown(): Promise<TurndownService> {
	const { default: TurndownService } = await import("turndown");
	return new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});
}
function getTurndown(): Promise<TurndownService> {
	turndownInstance ??= loadTurndown();
	return turndownInstance;
}

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	mimeType?: string;
	status?: number;
}

type HttpExtractedContent = ExtractedContent & { declaredLinks?: DeclaredWebLink[] };

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	mode?: "readable" | "raw" | "answer";
	answerModel?: string;
	authFetchProfile?: AuthFetchProfile;
	toolNames?: RegisteredToolNames;
	/** Optional HTTP(S) or SOCKS proxy URL; routed through the curl-backed transport. */
	proxy?: string;
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup;
}

/** Resolve the direct HTTP/Jina fetch budget, with a per-call override taking precedence. */
export function resolveFetchTimeoutMs(options?: Pick<ExtractOptions, "timeoutMs">): number {
	return options?.timeoutMs ?? loadFetchTimeoutMs();
}

const JINA_READER_BASE = "https://r.jina.ai/";

async function extractWithJinaReader(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	lookup?: Lookup,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		await validateRemoteUrl(url, {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			domainPolicy,
			...(lookup ? { lookup } : {}),
		});
		const res = await fetch(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(timeoutMs),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	let remoteUrl: URL | null = null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
	} catch {
	}
	if (remoteUrl) {
		try {
			const ssrf = loadSsrfConfig();
			const domainPolicy = loadFetchContentDomainPolicy();
			await validateRemoteUrl(remoteUrl, {
				allowRanges: ssrf.allowRanges,
				trustEnvProxy: ssrf.trustEnvProxy,
				domainPolicy,
				...(options?.lookup ? { lookup: options.lookup } : {}),
			});
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	if (options?.authFetchProfile || options?.mode === "raw") {
		try {
			return await extractViaHttp(url, resolveFetchTimeoutMs(options), signal, options);
		} catch (err) {
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	try {
		if (!remoteUrl) new URL(url);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}

	try {
		const ghIssuePrResult = await extractGitHubIssuePr(url, signal, options);
		if (ghIssuePrResult) return ghIssuePrResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
	}

	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
	}

	if (signal?.aborted) return abortedResult(url);

	let fetchTimeoutMs: number;
	try {
		fetchTimeoutMs = resolveFetchTimeoutMs(options);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}

	let fetchRouting: FetchRouting;
	try {
		fetchRouting = loadFetchRouting();
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	const providerOrder = remoteUrl && !fetchRouting.allowRemoteHostedProviders
		? fetchRouting.providers.filter(provider => !REMOTE_HOSTED_FETCH_PROVIDERS.has(provider))
		: fetchRouting.providers;
	if (providerOrder.length === 0) {
		return {
			url,
			title: "",
			content: "",
			error: "Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true",
		};
	}

	let httpResult: ExtractedContent | null = null;
	let declaredLinks: DeclaredWebLink[] = [];
	const withDeclaredLinks = (result: ExtractedContent): ExtractedContent => ({
		...result,
		content: appendDeclaredWebLinks(result.content, declaredLinks),
	});
	const parseErrorResult = (message: string): ExtractedContent => httpResult
		? { ...httpResult, error: message }
		: { url, title: "", content: "", error: message };
	const runHttpProvider = async (): Promise<ExtractedContent | null> => {
		const { declaredLinks: discoveredLinks = [], ...result } = await extractViaHttp(url, fetchTimeoutMs, signal, options);
		httpResult = result;
		declaredLinks = discoveredLinks;
		if (signal?.aborted) return abortedResult(url);
		if (!httpResult.error) return httpResult;
		if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult!.error!.startsWith(prefix)) || isRedirectPolicyError(httpResult.error) || isConfigParseError(httpResult.error)) {
			return httpResult;
		}
		return null;
	};


	if (remoteUrl && providerOrder[0] !== "http") {
		const httpGateResult = await runHttpProvider();
		if (httpGateResult) return httpGateResult;
	}

	for (const provider of providerOrder) {
		if (signal?.aborted) return abortedResult(url);

		if (provider === "http") {
			const result = await runHttpProvider();
			if (result) return result;
			continue;
		}



		if (provider === "jina") {
			const jinaResult = await extractWithJinaReader(url, fetchTimeoutMs, signal, options?.lookup);
			if (jinaResult) return withDeclaredLinks(jinaResult);
			continue;
		}









	}

	if (signal?.aborted) return abortedResult(url);
	const finalHttpResult = httpResult as ExtractedContent | null;
	if (finalHttpResult && declaredLinks.length > 0) return { ...finalHttpResult, error: null };

	// A definitive 404/410 from the origin means no extraction provider can
	// retrieve the page, so the provider-configuration checklist below would
	// send users down the wrong path. Point at search instead.
	if (finalHttpResult?.status === 404 || finalHttpResult?.status === 410) {
		return { ...finalHttpResult, error: notFoundGuidance(finalHttpResult, options?.toolNames) };
	}

	const searchToolName = options?.toolNames?.webSearch;
	const guidance = [
		finalHttpResult?.error ?? "No fetch_content provider returned content",
		"",
		"Fallback options:",
		...(searchToolName ? [`  • Use ${searchToolName} to find content about this topic`] : []),
	].join("\n");
	return { ...(finalHttpResult ?? { url, title: "", content: "", error: null }), error: guidance };
}

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	const scriptCount = (html.match(/<script/gi) || []).length;

	return textContent.length < 500 && scriptCount > 3;
}

export async function readPDFResponseBuffer(response: Response, maxSizeMB: number): Promise<ArrayBuffer> {
	const maxBytes = maxSizeMB * 1024 * 1024;
	return readResponseBufferWithLimit(response, maxBytes, () => pdfSizeLimitError(maxSizeMB));
}

async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
	const buffer = await readResponseBufferWithLimit(response, maxBytes, () => responseSizeLimitError(maxBytes));
	const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml");
}

async function readResponseBufferWithLimit(
	response: Response,
	maxBytes: number,
	buildError: () => Error,
): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) throw buildError();
		return buffer;
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw buildError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

function pdfSizeLimitError(maxSizeMB: number): Error {
	return new Error(`PDF exceeds configured pdf.maxSizeMB limit (${maxSizeMB} MB)`);
}

function responseSizeLimitError(maxBytes: number): Error {
	return new Error(`Response too large (${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

async function extractViaHttp(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<HttpExtractedContent> {
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const startedAt = Date.now();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const ssrf = loadSsrfConfig();
		const domainPolicy = loadFetchContentDomainPolicy();
		const authProfile = options?.authFetchProfile;
		const trustEnvProxy = options?.proxy === undefined && ssrf.trustEnvProxy;
		const requestInit: ProxiedRequestInit = {
			signal: controller.signal,
			__proxy: options?.proxy,
			headers: {
				"User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		};
		const response = authProfile
			? await fetchAuthenticatedRemoteUrl(url, requestInit, { ssrf: { ...ssrf, trustEnvProxy }, domainPolicy, ...(options?.lookup ? { lookup: options.lookup } : {}) }, authProfile)
			: await fetchRemoteUrl(
				url,
				requestInit,
				{
					allowRanges: ssrf.allowRanges,
					trustEnvProxy,
					domainPolicy,
					...(options?.lookup ? { lookup: options.lookup } : {}),
				},
			);

		if (!response.ok && options?.mode !== "raw") {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
				status: response.status,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const isPDFContent = isPDF(url, contentType);
		const pdfConfig = isPDFContent ? loadPDFConfig() : null;
		if (isPDFContent && pdfConfig && !pdfConfig.enabled) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: "PDF extraction is disabled by pdf.enabled", mimeType, status: response.status };
		}
		const maxResponseSize = (pdfConfig?.maxSizeMB ?? 5) * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = Number.parseInt(contentLengthHeader, 10);
			if (Number.isFinite(contentLength) && contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: pdfConfig
						? pdfSizeLimitError(pdfConfig.maxSizeMB).message
						: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (options?.mode === "raw") {
			if (!isTextContentType(contentType)) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: `Unsupported content type in raw mode: ${mimeType || "missing"}`, mimeType, status: response.status };
			}
			const text = await readTextResponseWithLimit(response, maxResponseSize);
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: extractTextTitle(text, url), content: text, error: null, mimeType, status: response.status };
		}

		if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
			const disabled = imageGateError();
			if (disabled) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: "", content: "", error: disabled, mimeType, status: response.status };
			}
			try {
				const buffer = await readResponseBufferWithLimit(response, maxResponseSize, () => responseSizeLimitError(maxResponseSize));
				const { resizeImage } = await import("@earendil-works/pi-coding-agent");
				const resized = await resizeImage(new Uint8Array(buffer), mimeType, { maxWidth: 2000, maxHeight: 2000 });
				activityMonitor.logComplete(activityId, response.status);
				if (!resized) return { url, title: "", content: "", error: `Could not decode image: ${mimeType}`, mimeType, status: response.status };
				const title = new URL(response.url || url).pathname.split("/").pop() || url;
				return {
					url,
					title,
					content: `Image fetched (${resized.width}×${resized.height}, ${resized.mimeType})`,
					error: null,
					thumbnail: { data: resized.data, mimeType: resized.mimeType },
					mimeType: resized.mimeType,
					status: response.status,
				};
			} catch (err) {
				const message = errorMessage(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: message, mimeType, status: response.status };
			}
		}

		if (isPDFContent && pdfConfig) {
			try {
				const buffer = await readPDFResponseBuffer(response, pdfConfig.maxSizeMB);
				if (signal?.aborted) return abortedResult(url);
				const result = await extractPDFToMarkdown(buffer, url, { signal });
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				if (message.startsWith("PDF exceeds configured pdf.maxSizeMB limit")) {
					return { url, title: "", content: "", error: message };
				}
				if (err instanceof CredentialResolutionError || isConfigParseError(err)) {
					return { url, title: "", content: "", error: message };
				}
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await readTextResponseWithLimit(response, maxResponseSize);
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { parseHTML } = await import("linkedom");
		const { document } = parseHTML(text);
		const documentTitle = document.title?.trim() ?? "";
		const declaredLinks = discoverDeclaredWebLinks(
			document as unknown as Document,
			response.headers.get("link"),
			response.url || url,
		);
		const { Readability } = await import("@mozilla/readability");
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: rscResult.title,
					content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			controller.signal.throwIfAborted();
			const defuddleResult = await extractWithDefuddle(text, response.url || url);
			controller.signal.throwIfAborted();
			if (defuddleResult && defuddleResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: documentTitle || defuddleResult.title,
					content: appendDeclaredWebLinks(defuddleResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}

			activityMonitor.logComplete(activityId, response.status);
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: documentTitle,
				content: appendDeclaredWebLinks("", declaredLinks),
				error: errorMsg,
				declaredLinks,
			};
		}

		if (typeof article.content !== "string") {
			throw new Error("Readability returned invalid article content");
		}
		const markdown = (await getTurndown()).turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				return {
					url,
					title: rscResult.title,
					content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			controller.signal.throwIfAborted();
			const defuddleResult = await extractWithDefuddle(text, response.url || url);
			controller.signal.throwIfAborted();
			if (defuddleResult && defuddleResult.content.length >= MIN_USEFUL_CONTENT) {
				return {
					url,
					title: article.title || documentTitle || defuddleResult.title,
					content: appendDeclaredWebLinks(defuddleResult.content, declaredLinks),
					error: null,
					declaredLinks,
				};
			}
			return {
				url,
				title: article.title || documentTitle,
				content: appendDeclaredWebLinks(markdown, declaredLinks),
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
				declaredLinks,
			};
		}

		return {
			url,
			title: article.title || documentTitle,
			content: appendDeclaredWebLinks(markdown, declaredLinks),
			error: null,
			declaredLinks,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		// Imports and CPU-bound processing need not observe the fetch signal, and
		// can finish before an expired timer gets a turn. Guard every exit, with
		// caller cancellation taking precedence over the internal deadline.
		if (signal?.aborted) return abortedResult(url);
		if (controller.signal.aborted || Date.now() - startedAt >= timeoutMs) {
			return { url, title: "", content: "", error: "The operation was aborted." };
		}
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const results = await Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
	if (options?.mode === "raw") return results;
	// Inline data: URIs in extracted markdown would otherwise flow into tool
	// results and the fetch cache as opaque base64; typed thumbnail/frame image
	// blocks are deliberate outputs and are left untouched.
	return results.map((result, index) => {
		if (!result.content) return result;
		const sanitized = sanitizeInlineDataUris(result.content, `urls[${index}].content`);
		return sanitized.omissions.length > 0 ? { ...result, content: sanitized.text } : result;
	});
}
