import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import pLimit from "p-limit";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent } from "./src/fetch/extract.ts";
import { normalizeFetchContentParams } from "./src/fetch/fetch-params.ts";
import { resolveAuthFetchProfile } from "./src/fetch/auth-fetch.ts";
import { answerFromPage } from "./src/fetch/page-query.ts";
import { getStoredContent, storeFetchedContent } from "./src/fetch/fetch-cache.ts";
import { search } from "./src/providers/search.ts";
import type { SearchResult } from "./src/providers/types.ts";
import { installGlobalProxyFetch } from "./src/fetch/utils.ts";
import { getMaxInlineContentChars, loadSearchProviderConfig } from "./src/config.ts";

function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

// Limit each batch independently so separate tool calls can still run in parallel.
const SEARCH_QUERY_CONCURRENCY = 3;
function runSearchQueries<T>(queries: string[], run: (query: string, index: number) => Promise<T>): Promise<T[]> {
	const limit = pLimit(SEARCH_QUERY_CONCURRENCY);
	return Promise.all(queries.map((query, index) => limit(() => run(query, index))));
}

// Some local models serialize a multi-query list into the single-string `query`
// field as a JSON array (query: "[\"a\", \"b\"]") instead of using the
// `queries` parameter. Expand a string that parses as a JSON array of strings
// so each element is searched independently.
function expandQueryString(query: unknown): string[] {
	if (typeof query !== "string") return [];
	const trimmed = query.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every((entry): entry is string => typeof entry === "string")) {
				return parsed
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0);
			}
		} catch {
			// Not JSON — treat as a literal query string.
		}
	}
	return [query];
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

function normalizeRecencyFilter(value: unknown): "day" | "week" | "month" | "year" | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider: string | null;
}

export default function (pi: ExtensionAPI) {
	installGlobalProxyFetch();
	const configured = loadConfigForInit();

	function loadConfigForInit() {
		try {
			return loadSearchProviderConfig();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[pi-web-access-minimal] ${message}`);
			return {};
		}
	}

	function initialContentSlice(content: string, maxChars: number): {
		text: string;
		endOffset: number;
		totalBytes: number;
		totalLines: number;
		shownBytes: number;
		shownLines: number;
	} {
		let endOffset = Math.min(content.length, maxChars);
		if (endOffset < content.length) {
			const lineBreak = content.lastIndexOf("\n", endOffset);
			if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
		}
		const text = content.slice(0, endOffset);
		return {
			text,
			endOffset,
			totalBytes: Buffer.byteLength(content),
			totalLines: content.length === 0 ? 0 : content.split("\n").length,
			shownBytes: Buffer.byteLength(text),
			shownLines: text.length === 0 ? 0 : text.split("\n").length,
		};
	}

	function continuationSlice(content: string, offset: number, maxChars: number): {
		text: string;
		endOffset: number;
		shownBytes: number;
		shownLines: number;
	} {
		const boundedOffset = Math.max(0, Math.min(offset, content.length));
		let endOffset = Math.min(content.length, boundedOffset + maxChars);
		if (endOffset < content.length) {
			const lineBreak = content.lastIndexOf("\n", endOffset);
			if (lineBreak >= Math.floor((boundedOffset + maxChars) * 0.8)) endOffset = lineBreak + 1;
		}
		const text = content.slice(boundedOffset, endOffset);
		return {
			text,
			endOffset,
			shownBytes: Buffer.byteLength(text),
			shownLines: text.length === 0 ? 0 : text.split("\n").length,
		};
	}

	function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
		return results.map(({ thumbnail, ...rest }) => rest);
	}

	// ---------------------------------------------------------------------------
	// web_search
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content of every source is fetched and included inline.",
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. Prefer 'queries' for research tasks." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched concurrently (up to three at a time), each returning its own synthesized answer. Vary phrasing, scope, and angle across 2-4 queries to maximize coverage." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content of sources (inline)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
		}),

		async execute(_callId, params, signal, onUpdate, ctx) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? expandQueryString(params.query) : []);
			const queryList = normalizeQueryList(rawQueryList);
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			let completedSearches = 0;
			const allUrls: string[] = [];
			const inlineContent: ExtractedContent[] = [];

			const queryResponses = await runSearchQueries(queryList, async (query) => {
				signal?.throwIfAborted();
				onUpdate?.({
					content: [{ type: "text", text: `Searching "${query}" (${completedSearches}/${queryList.length} complete)...` }],
					details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, provider } = await search(query, {
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						signal,
					}, ctx);
					return { result: { query, answer, results, error: null, provider } satisfies QueryResultData };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (signal?.aborted || message.toLowerCase().includes("abort")) throw err;
					return { result: { query, answer: "", results: [], error: message, provider: null } satisfies QueryResultData };
				} finally {
					completedSearches++;
					if (!signal?.aborted) {
						onUpdate?.({
							content: [{ type: "text", text: `Completed ${completedSearches}/${queryList.length} searches.` }],
							details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
						});
					}
				}
			});

			const searchResults = queryResponses.map(response => response.result);
			for (const response of searchResults) {
				for (const result of response.results) {
					if (!allUrls.includes(result.url)) allUrls.push(result.url);
				}
			}

			// includeContent: fetch source pages inline (bounded concurrency), full
			// content cached for offset paging via fetch_content.
			if (params.includeContent === true && allUrls.length > 0) {
				onUpdate?.({
					content: [{ type: "text", text: `Fetching content for ${allUrls.length} source(s)...` }],
					details: { phase: "fetch", progress: 0 },
				});
				const fetchLimit = pLimit(3);
				const fetched = await Promise.all(allUrls.map((url) => fetchLimit(async () => {
					try {
						const { fetchAllContent } = await import("./src/fetch/extract.ts");
						const results = await fetchAllContent([url], signal, {
							toolNames: { webSearch: "web_search", fetchContent: "fetch_content" },
						});
						return results[0];
					} catch (err) {
						return { url, title: "", content: "", error: err instanceof Error ? err.message : String(err) } satisfies ExtractedContent;
					}
				})));
				for (const result of fetched) {
					if (result.error || !result.content) continue;
					if (result.thumbnail) continue; // images are shown, not stored for paging
					inlineContent.push(result);
					storeFetchedContent(result.url, {
						title: result.title,
						content: result.content,
						...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
						...(result.status !== undefined ? { status: result.status } : {}),
					});
				}
			}

			let output = "";
			for (const { query, answer, results, error } of searchResults) {
				if (queryList.length > 1) output += `## Query: "${query}"\n\n`;
				if (error) output += `Error: ${error}\n\n`;
				else output += formatSearchSummary(results, answer) + "\n\n";
			}

			if (inlineContent.length > 0) {
				output += `---\nFull page content for ${inlineContent.length} source(s) is cached; call fetch_content with the same URL and an offset to page through it.`;
			}

			const sc = searchResults.filter(r => !r.error).length;
			const tr = searchResults.reduce((sum, r) => sum + r.results.length, 0);

			return {
				content: [{ type: "text", text: output.trim() }],
				details: {
					queries: queryList,
					queryCount: queryList.length,
					successfulQueries: sc,
					totalResults: tr,
					includeContent: params.includeContent === true,
					provider: searchResults.map(r => r.provider).filter(Boolean)[0] ?? null,
				},
			};
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? expandQueryString(input.query) : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				phase?: string;
				progress?: number;
				currentQuery?: string;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				const phase = details?.currentQuery ? `searching "${details.currentQuery}"` : (details?.phase || "searching");
				return new Text(theme.fg("accent", `[${bar}] ${phase}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const countColor = (details?.successfulQueries ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successfulQueries ?? 0}/${details?.queryCount ?? 0} queries`) +
				theme.fg("muted", ` · ${details?.totalResults ?? 0} sources`);
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			if (!expanded) {
				const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
				return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
			}
			return new Text(statusLine + "\n" + theme.fg("dim", textContent.slice(0, 2000)), 0, 0);
		},
	});

	// ---------------------------------------------------------------------------
	// fetch_content
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			'Fetch URL(s) and extract readable content as markdown. Use mode "raw" for exact textual HTTP response bodies or mode "answer" with prompt to answer using only fetched content. Direct image URLs return resized image content. Supports GitHub repositories and PDFs. When a result is truncated, call again with the same url and an offset to get the next slice.',
		promptSnippet:
			"Use to fetch readable or raw URL content, direct images, GitHub repos, and PDFs. Mode answer answers a prompt using only the fetched source.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: "Question for mode answer.",
			})),
			mode: Type.Optional(StringEnum(["readable", "raw", "answer"], {
				description: "Fetch mode: readable (default extraction), raw (exact textual HTTP body), or answer (answer prompt using only fetched content).",
			})),
			answerModel: Type.Optional(Type.String({
				description: "Optional provider/model-id override for mode answer. Defaults to fetch.answerProvider + fetch.answerModel when configured, otherwise the current Pi model.",
			})),
			offset: Type.Optional(Type.Integer({
				minimum: 0,
				description: "Character offset to continue reading a previously fetched (and truncated) URL.",
			})),
			auth: Type.Optional(Type.Union([Type.String(), Type.Boolean()], {
				description: "Opt into an authFetch profile for local browser-cookie fetching. Use a profile name, or true only when exactly one profile exists.",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(params);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			const { urlList, options } = normalized;
			const offset = typeof params.offset === "number" && Number.isInteger(params.offset) && params.offset >= 0
				? params.offset
				: undefined;

			const validateIncompatible = (): string | null => {
				const mode = options.mode ?? "readable";
				if (mode === "answer" && !options.prompt) return "mode answer requires prompt";
				if (mode === "raw" && (options.forceClone === true || options.prompt || options.answerModel || offset !== undefined)) {
					return "mode raw cannot be combined with forceClone, prompt, answerModel, or offset";
				}
				if (mode !== "answer" && options.answerModel) return "answerModel requires mode answer";
				if (mode === "answer" && offset !== undefined) return "offset is incompatible with mode answer";
				return null;
			};
			const incompatible = validateIncompatible();
			if (incompatible) {
				return { content: [{ type: "text", text: `Error: ${incompatible}` }], details: { error: incompatible } };
			}

			let authFetchProfile: ReturnType<typeof resolveAuthFetchProfile> | undefined;
			if (options.auth !== undefined) {
				try {
					authFetchProfile = resolveAuthFetchProfile(options.auth);
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
				}
			}

			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			// Offset paging path: serve a previously stored, truncated fetch.
			if (offset !== undefined) {
				if (urlList.length > 1) {
					const error = "offset requires a single url";
					return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
				}
				const stored = getStoredContent(urlList[0]);
				if (!stored) {
					const error = "No stored content for this URL. Fetch it first (without offset) to page through it.";
					return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
				}
				if (offset >= stored.content.length) {
					return {
						content: [{ type: "text", text: `End of stored content for ${stored.url} (total ${stored.content.length} chars).` }],
						details: { url: stored.url, offset, totalChars: stored.content.length, atEnd: true },
					};
				}
				const config = loadConfigForInit();
				const maxChars = getMaxInlineContentChars(config);
				const slice = continuationSlice(stored.content, offset, maxChars);
				let output = slice.text;
				const truncated = slice.endOffset < stored.content.length;
				if (truncated) {
					output += `\n\n---\nShowing chars ${offset}–${slice.endOffset} of ${stored.content.length}. Call fetch_content({ url: ${JSON.stringify(stored.url)}, offset: ${slice.endOffset} }) for the next slice.`;
				}
				return {
					content: [{ type: "text", text: output }],
					details: {
						url: stored.url,
						title: stored.title,
						offset,
						totalChars: stored.content.length,
						truncated,
						nextOffset: truncated ? slice.endOffset : undefined,
						shownBytes: slice.shownBytes,
						shownLines: slice.shownLines,
					},
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const mode = options.mode ?? "readable";
			const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = options;
			const fetchOptions = mode === "answer"
				? (() => {
					const { prompt: _prompt, ...rest } = extractionOptions;
					return { ...rest, ...(authFetchProfile ? { authFetchProfile } : {}) };
				})()
				: { ...extractionOptions, ...(authFetchProfile ? { authFetchProfile } : {}) };

			const { fetchAllContent } = await import("./src/fetch/extract.ts");
			const fetchResults = await fetchAllContent(urlList, signal, fetchOptions);
			const presentedResults = mode === "answer"
				? await Promise.all(fetchResults.map(async result => {
					if (result.error) return result;
					if (result.thumbnail || result.mimeType?.startsWith("image/")) {
						return { ...result, error: "Page answer requires textual fetched content" };
					}
					try {
						const answer = await answerFromPage({
							question: options.prompt!,
							pageText: result.content,
							sourceUrl: result.url,
							...(options.answerModel ? { model: options.answerModel } : {}),
						}, ctx, signal);
						return { ...result, content: answer.text };
					} catch (err) {
						return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
					}
				}))
				: fetchResults;
			const successful = presentedResults.filter((r) => !r.error).length;
			const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

			// Store full content for offset paging (unless auth cache is off).
			const cacheable = !authFetchProfile || authFetchProfile.cache !== "off";
			if (cacheable) {
				for (const result of fetchResults) {
					if (result.error || !result.content) continue;
					storeFetchedContent(result.url, {
						title: result.title,
						content: result.content,
						...(result.mimeType !== undefined ? { mimeType: result.mimeType } : {}),
						...(result.status !== undefined ? { status: result.status } : {}),
					});
				}
			}

			if (urlList.length === 1) {
				const result = presentedResults[0];
				if (result.error) {
					return {
						content: [{ type: "text", text: `Error: ${result.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, prompt: params.prompt },
					};
				}

				const fullLength = result.content.length;
				const maxChars = getMaxInlineContentChars(loadConfigForInit());
				const slice = initialContentSlice(result.content, maxChars);
				const truncated = slice.endOffset < fullLength;
				let output = slice.text;

				if (truncated) {
					output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines.\n`;
					output += cacheable
						? `Call fetch_content({ url: ${JSON.stringify(result.url)}, offset: ${slice.endOffset} }) for the next slice.`
						: "Authenticated fetch cache is off; repeat the fetch to read more.";
				}

				const content: Array<TextContent | ImageContent> = [];
				if (result.thumbnail) {
					content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
				}
				content.push({ type: "text", text: output });

				return {
					content,
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						truncated,
						hasImage: !!result.thumbnail,
						imageCount: result.thumbnail ? 1 : 0,
						prompt: params.prompt,
						mode,
						mimeType: result.mimeType,
						status: result.status,
						totalBytes: slice.totalBytes,
						totalLines: slice.totalLines,
						shownBytes: slice.shownBytes,
						shownLines: slice.shownLines,
					},
				};
			}

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of presentedResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			if (cacheable && presentedResults.some((r) => !r.error && r.content.length > 0)) {
				output += "\n---\nFull content is cached; call fetch_content with the same url and an offset to page through it.";
			}

			return {
				content: [{ type: "text", text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars },
			};
		},

		renderCall(args, theme) {
			const { urlList, options } = safeNormalize(args);
			const { prompt, mode, answerModel, auth } = options;
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (mode && mode !== "readable") {
				lines.push(theme.fg("dim", "  mode: ") + theme.fg("warning", mode));
			}
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
			}
			if (answerModel) {
				lines.push(theme.fg("dim", "  answer model: ") + theme.fg("warning", answerModel));
			}
			if (auth !== undefined) {
				lines.push(theme.fg("dim", "  auth: ") + theme.fg("warning", auth === true ? "true" : auth));
			}
			const offset = (args as { offset?: unknown }).offset;
			if (typeof offset === "number") {
				lines.push(theme.fg("dim", "  offset: ") + theme.fg("warning", String(offset)));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				hasImage?: boolean;
				imageCount?: number;
				prompt?: string;
				mode?: string;
			};

			if (isPartial) {
				const progress = details && typeof details === "object" && "progress" in details
					? Number((details as { progress?: number }).progress ?? 0)
					: 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] fetching`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imageBadge = details?.hasImage ? theme.fg("accent", " [image]") : "";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const lines = [statusLine];
				if (details?.prompt) {
					const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
					lines.push(theme.fg("dim", `  prompt: "${display}"`));
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content fetched)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	function safeNormalize(args: unknown) {
		try {
			return normalizeFetchContentParams(args as never);
		} catch {
			return { urlList: [], options: {} as ReturnType<typeof normalizeFetchContentParams>["options"] };
		}
	}
}
