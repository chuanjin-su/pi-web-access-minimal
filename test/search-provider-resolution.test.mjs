import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../src/providers/search.ts", import.meta.url).href;
const configModuleUrl = new URL("../src/config.ts", import.meta.url).href;

const CLEAR_ENV_KEYS = ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"];

async function runScenario({ script, env = {}, config = undefined }) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-search-"));
	if (config !== undefined) {
		await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	}
	const childEnv = { ...process.env };
	for (const key of CLEAR_ENV_KEYS) delete childEnv[key];
	childEnv.PI_CODING_AGENT_DIR = agentDir;
	Object.assign(childEnv, env);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return child.stdout.trim();
}

test("searchProvider in web-search.json must be openai, brave, or exa", async () => {
	const output = await runScenario({
		config: { searchProvider: "tavily" },
		script: `
			import { loadSearchProviderConfig } from ${JSON.stringify(configModuleUrl)};
			try {
				loadSearchProviderConfig();
				console.log("no-error");
			} catch (err) {
				console.log("invalid: " + /searchProvider in .* must be "openai", "brave", or "exa"/.test(err.message));
			}
		`,
	});
	assert.match(output, /invalid: true/);
});

test("configured provider is used when credentials exist; otherwise automatic openai→brave fallback applies", async () => {
	// No explicit searchProvider: openai credentials present → openai.
	const openai = await runScenario({
		env: { OPENAI_API_KEY: "sk-test" },
		script: `
			import { resolveSearchProvider } from ${JSON.stringify(searchModuleUrl)};
			console.log(await resolveSearchProvider());
		`,
	});
	assert.equal(openai, "openai");

	// Only brave credentials → brave.
	const brave = await runScenario({
		env: { BRAVE_API_KEY: "brave-test" },
		script: `
			import { resolveSearchProvider } from ${JSON.stringify(searchModuleUrl)};
			console.log(await resolveSearchProvider());
		`,
	});
	assert.equal(brave, "brave");

	// searchProvider pins brave even with openai credentials available.
	const pinned = await runScenario({
		env: { OPENAI_API_KEY: "sk-test", BRAVE_API_KEY: "brave-test" },
		config: { searchProvider: "brave" },
		script: `
			import { resolveSearchProvider } from ${JSON.stringify(searchModuleUrl)};
			console.log(await resolveSearchProvider());
		`,
	});
	assert.equal(pinned, "brave");

	// Nothing configured at all → exa (keyless MCP needs no credentials).
	const none = await runScenario({
		script: `
			import { resolveSearchProvider } from ${JSON.stringify(searchModuleUrl)};
			console.log(String(await resolveSearchProvider()));
		`,
	});
	assert.equal(none, "exa");
});

test("search() falls back to exa when every credential provider fails", async () => {
	const output = await runScenario({
		env: {
			OPENAI_API_KEY: "sk-test",
			BRAVE_API_KEY: "brave-test",
			BRAVE_BASE_URL: "https://brave.invalid-nonexistent.test",
		},
		script: `
			// OpenAI fails (unreachable host) and Brave fails too; keyless Exa MCP is stubbed to succeed.
			const realFetch = globalThis.fetch;
			globalThis.fetch = async (url, init) => {
				const target = String(url);
				if (target.startsWith("https://api.openai.com/v1/responses")) {
					return new Response("unreachable", { status: 503 });
				}
				if (target.startsWith("https://mcp.exa.ai/mcp")) {
					const mcpBody = JSON.stringify({
						result: {
							content: [{
								type: "text",
								text: JSON.stringify({ results: [
									{ title: "Exa Result", url: "https://example.com/exa", highlights: ["exa snippet"] },
								] }),
							}],
						},
					});
					return new Response("data: " + mcpBody, { status: 200, headers: { "content-type": "text/event-stream" } });
				}
				return realFetch(url, init);
			};
			import { search } from ${JSON.stringify(searchModuleUrl)};
			try {
				const result = await search("query", { numResults: 3 });
				console.log(JSON.stringify({ provider: result.provider, answer: result.answer, url: result.results[0]?.url }));
			} catch (err) {
				console.log(JSON.stringify({ error: err.message.slice(0, 80) }));
			}
		`,
	});
	assert.match(output, /"provider":"exa"/);
	assert.match(output, /"url":"https:\/\/example.com\/exa"/);
});

test("search() falls back to the other provider when the configured one fails", async () => {
	const output = await runScenario({
		env: {
			OPENAI_API_KEY: "sk-test",
			BRAVE_API_KEY: "brave-test",
			BRAVE_BASE_URL: "https://brave.invalid-nonexistent.test",
		},
		config: { searchProvider: "brave" },
		script: `
			// OpenAI is stubbed to succeed; Brave points at an unreachable host so it fails.
			const realFetch = globalThis.fetch;
			globalThis.fetch = async (url, init) => {
				const target = String(url);
				if (target.startsWith("https://api.openai.com/v1/responses")) {
					return new Response(JSON.stringify({
						output: [
							{ type: "web_search_call", action: { sources: [] } },
							{ type: "message", content: [{ type: "output_text", text: "Answer from the web", annotations: [] }] },
						],
					}), { status: 200, headers: { "content-type": "application/json" } });
				}
				return realFetch(url, init);
			};
			import { search } from ${JSON.stringify(searchModuleUrl)};
			try {
				const result = await search("query", { numResults: 3 });
				console.log(JSON.stringify({ provider: result.provider, answer: result.answer }));
			} catch (err) {
				console.log(JSON.stringify({ error: err.message.slice(0, 80) }));
			}
		`,
	});
	assert.match(output, /"provider":"openai"/);
});
