import { createHash } from "node:crypto";

/**
 * In-memory store of fully extracted page content, keyed by URL.
 *
 * fetch_content inlines only the first slice of large content. The full text is
 * kept here so a follow-up call with the same URL and an `offset` parameter can
 * continue from where the previous slice stopped — without a third tool.
 */
export interface StoredFetchContent {
	url: string;
	title: string;
	content: string;
	mimeType?: string;
	status?: number;
	storedAt: number;
}

const MAX_STORED_ENTRIES = 50;

const store = new Map<string, StoredFetchContent>();

export function fetchCacheKey(url: string): string {
	return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export function storeFetchedContent(url: string, entry: Omit<StoredFetchContent, "url" | "storedAt">): void {
	const key = fetchCacheKey(url);
	// Refresh insertion order for FIFO eviction.
	store.delete(key);
	if (store.size >= MAX_STORED_ENTRIES) {
		const oldest = store.keys().next();
		if (!oldest.done) store.delete(oldest.value);
	}
	store.set(key, { ...entry, url, storedAt: Date.now() });
}

export function getStoredContent(url: string): StoredFetchContent | undefined {
	return store.get(fetchCacheKey(url));
}

export function hasStoredContent(url: string): boolean {
	return store.has(fetchCacheKey(url));
}
