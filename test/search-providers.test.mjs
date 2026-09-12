import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../src/providers/brave.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../src/providers/openai-search.ts", import.meta.url).href;
const exaModuleUrl = new URL("../src/providers/exa.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"BRAVE_BASE_URL",
		"EXA_API_KEY",
		"EXA_BASE_URL",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Brave search applies domain filters in the query and returned results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-brave-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				web: { results: [
					{ title: "Repo", url: "https://github.com/example/repo", description: "repo" },
					{ title: "Gist", url: "https://gist.github.com/example/abc", description: "gist" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 2,
		});
		const parsedUrl = new URL(capturedUrl);
		console.log(JSON.stringify({
			q: parsedUrl.searchParams.get("q"),
			count: parsedUrl.searchParams.get("count"),
			token: capturedHeaders["X-Subscription-Token"],
			results: result.results,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	assert.deepEqual(output.results.map((result) => result.url), ["https://github.com/example/repo"]);
});

test("OpenAI search requires web_search and maps domain filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-openai-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ title: "OpenAI Blog", url: "https://openai.com/blog?utm_source=openai" }] },
					},
					{
						type: "message",
						content: [{
							type: "output_text",
							text: "Answer from the web",
							annotations: [{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://openai.com/docs?utm_source=openai",
								title: "OpenAI Docs",
							}],
						}],
					},
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("latest docs", {
			domainFilter: ["https://openai.com/docs", "-reddit.com"],
			numResults: 3,
		});
		console.log(JSON.stringify({
			url: capturedUrl,
			authorization: capturedHeaders.Authorization,
			body: capturedBody,
			results: result.results,
			answer: result.answer,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		OPENAI_API_KEY: "sk-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://api.openai.com/v1/responses");
	assert.equal(output.authorization, "Bearer sk-test-key");
	assert.equal(output.body.tool_choice, "required");
	assert.deepEqual(output.body.include, ["web_search_call.action.sources"]);
	assert.deepEqual(output.body.tools[0].filters, {
		allowed_domains: ["openai.com"],
		blocked_domains: ["reddit.com"],
	});
	assert.equal(output.answer, "Answer from the web");
	assert.deepEqual(output.results.map((result) => result.url), [
		"https://openai.com/docs",
		"https://openai.com/blog",
	]);
});

test("Exa keyless MCP maps filters onto the advanced tool and parses JSON results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-exa-mcp-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init.body);
			const mcpBody = JSON.stringify({
				result: {
					content: [{
						type: "text",
						text: JSON.stringify({ results: [
							{ title: "Exa Hit", url: "https://docs.example.com/guide", highlights: ["first highlight", "second highlight"] },
							{ title: "No Url", url: "" },
						] }),
					}],
				},
			});
			return new Response("data: " + mcpBody, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("sdk docs", {
			domainFilter: ["docs.example.com", "-spam.example.com"],
			recencyFilter: "week",
			numResults: 4,
		});
		console.log(JSON.stringify({
			url: capturedUrl,
			tool: capturedBody.params.name,
			args: capturedBody.params.arguments,
			results: result.results,
			answer: result.answer,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
	assert.equal(output.tool, "web_search_advanced_exa");
	assert.equal(output.args.numResults, 4);
	assert.deepEqual(output.args.includeDomains, ["docs.example.com"]);
	assert.deepEqual(output.args.excludeDomains, ["spam.example.com"]);
	assert.ok(output.args.startPublishedDate);
	assert.equal(output.answer, "first highlight second highlight\nSource: Exa Hit (https://docs.example.com/guide)");
	assert.deepEqual(output.results, [{ title: "Exa Hit", url: "https://docs.example.com/guide", snippet: "" }]);
});

test("Exa API key path uses /answer by default and /search with filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-exa-api-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
			if (String(url).endsWith("/answer")) {
				return new Response(JSON.stringify({
					answer: "Synthesized answer",
					citations: [{ title: "Cited", url: "https://example.com/cited" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response(JSON.stringify({ results: [
				{ title: "Search Hit", url: "https://example.com/search", highlights: ["hl"] },
			] }), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const answer = await searchWithExa("plain query");
		const filtered = await searchWithExa("filtered query", { domainFilter: ["example.com"], numResults: 7 });
		console.log(JSON.stringify({ answer, filtered, calls }));
	`, {
		HOME: home,
		USERPROFILE: home,
		EXA_API_KEY: "exa-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.equal(output.calls[0].url, "https://api.exa.ai/answer");
	assert.equal(output.calls[0].headers["x-api-key"], "exa-test-key");
	assert.equal(output.answer.answer, "Synthesized answer");
	assert.deepEqual(output.answer.results, [{ title: "Cited", url: "https://example.com/cited", snippet: "" }]);
	assert.equal(output.calls[1].url, "https://api.exa.ai/search");
	assert.equal(output.calls[1].body.numResults, 7);
	assert.deepEqual(output.calls[1].body.includeDomains, ["example.com"]);
	assert.deepEqual(output.filtered.results, [{ title: "Search Hit", url: "https://example.com/search", snippet: "" }]);
});
