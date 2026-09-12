import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFetchContentParams } from "../src/fetch/fetch-params.ts";

test("fetch_content params fall back to url when urls is an empty array", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/docs",
		urls: [],
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/docs"]);
});

test("fetch_content params keep non-empty urls precedence over url", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/fallback",
		urls: ["https://example.com/primary"],
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/primary"]);
});

test("fetch_content params ignore blank optional strings and blank urls", () => {
	const normalized = normalizeFetchContentParams({
		url: "  https://example.com/one  ",
		urls: ["", " https://example.com/two ", "https://example.com/one"],
		prompt: "",
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/two", "https://example.com/one"]);
	assert.equal(normalized.options.prompt, undefined);
	assert.equal(normalizeFetchContentParams({ prompt: "" }).options.prompt, undefined);
});

test("fetch_content params preserve forceClone only for boolean values", () => {
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", forceClone: true }).options.forceClone, true);
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", forceClone: false }).options.forceClone, false);
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", forceClone: "yes" }).options.forceClone, undefined);
});

test("fetch_content params reject invalid modes", () => {
	assert.throws(() => normalizeFetchContentParams({ url: "https://example.com", mode: "video" }), /mode must be/);
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", mode: "raw" }).options.mode, "raw");
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", mode: "answer" }).options.mode, "answer");
	assert.equal(normalizeFetchContentParams({ url: "https://example.com" }).options.mode, undefined);
});

test("fetch_content params normalize auth profiles", () => {
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", auth: true }).options.auth, true);
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", auth: "work" }).options.auth, "work");
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", auth: false }).options.auth, undefined);
	assert.throws(() => normalizeFetchContentParams({ url: "https://example.com", auth: 42 }), /auth must be/);
});

test("fetch_content params keep answerModel only as a non-empty string", () => {
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", answerModel: " openai/gpt-5-mini " }).options.answerModel, "openai/gpt-5-mini");
	assert.equal(normalizeFetchContentParams({ url: "https://example.com", answerModel: "" }).options.answerModel, undefined);
});
