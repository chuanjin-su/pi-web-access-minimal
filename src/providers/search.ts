import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import { SEARCH_PROVIDERS, type SearchOptions, type SearchProviderId, type SearchResponse } from "./types.ts";

export { SEARCH_PROVIDERS } from "./types.ts";
export type { SearchOptions, SearchProviderId, SearchResponse, SearchResult } from "./types.ts";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

export async function isProviderAvailable(provider: SearchProviderId, ctx?: ExtensionContext): Promise<boolean> {
	if (provider === "brave") return isBraveAvailable();
	if (provider === "exa") return isExaAvailable();
	return isOpenAISearchAvailable(ctx);
}

/**
 * Resolve the effective provider for this search.
 *
 * Order (never influenced by tool-call parameters — the agent cannot pick):
 *   1. `searchProvider` in web-search.json (only if its credentials exist)
 *   2. automatic fallback: openai → brave → exa (first provider that can search;
 *      exa is always available via its keyless MCP endpoint)
 *
 * Returns null only when no provider is configured at all.
 */
export async function resolveSearchProvider(ctx?: ExtensionContext): Promise<SearchProviderId | null> {
	const { loadSearchProviderConfig } = await import("../config.ts");
	const configured = loadSearchProviderConfig().searchProvider;
	if (configured && await isProviderAvailable(configured, ctx)) return configured;

	for (const provider of SEARCH_PROVIDERS) {
		if (provider === configured) continue;
		if (await isProviderAvailable(provider, ctx)) return provider;
	}
	return null;
}

/** Search with the configured provider, falling back automatically when it is unavailable. */
export async function search(query: string, options: SearchOptions = {}, ctx?: ExtensionContext): Promise<SearchResponse & { provider: SearchProviderId }> {
	const provider = await resolveSearchProvider(ctx);
	if (!provider) {
		const { getWebSearchConfigPath } = await import("../fetch/utils.ts");
		throw new Error(
			"No search provider is configured. Either:\n" +
			`  1. Set "searchProvider" in ${getWebSearchConfigPath()} to "openai", "brave", or "exa"\n` +
			"  2. Set OPENAI_API_KEY (or /login with a Codex subscription)\n" +
			"  3. Set BRAVE_API_KEY environment variable\n" +
			"Exa works with no key at all, so this error only occurs when search is explicitly disabled.",
		);
	}

	const errors: string[] = [];
	try {
		const result = provider === "brave"
			? await searchWithBrave(query, options)
			: provider === "exa"
				? await searchWithExa(query, options)
				: await searchWithOpenAI(query, options, ctx);
		return { ...result, provider };
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`${provider}: ${errorMessage(err)}`);
	}

	// Automatic fallback to the other provider when the configured one fails.
	for (const fallback of SEARCH_PROVIDERS) {
		if (fallback === provider) continue;
		try {
			if (!(await isProviderAvailable(fallback, ctx))) continue;
			const result = fallback === "brave"
				? await searchWithBrave(query, options)
				: fallback === "exa"
					? await searchWithExa(query, options)
					: await searchWithOpenAI(query, options, ctx);
			return { ...result, provider: fallback };
		} catch (err) {
			if (isAbortError(err)) throw err;
			errors.push(`${fallback}: ${errorMessage(err)}`);
		}
	}

	throw new Error(`All search providers failed:\n  - ${errors.join("\n  - ")}`);
}
