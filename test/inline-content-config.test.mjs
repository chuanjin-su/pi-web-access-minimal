import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

async function runScenario(maxInlineContentChars) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-inline-"));
	if (maxInlineContentChars !== undefined) {
		await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ maxInlineContentChars }) + "\n", "utf8");
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			globalThis.fetch = async () => new Response("A".repeat(40000) + "TAIL", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); } });
			const fetchTool = tools.find(tool => tool.name === "fetch_content");
			const fetched = await fetchTool.execute("call", { url: "https://93.184.216.34/page" });
			const firstText = fetched.content.find(item => item.type === "text").text;
			const offsetMatch = firstText.match(/offset: (\\d+)/);
			const tail = await fetchTool.execute("call", { url: "https://93.184.216.34/page", offset: Number(offsetMatch[1]) });
			const tailText = tail.content.find(item => item.type === "text").text;
			console.log(JSON.stringify({
				fetchTruncated: fetched.details.truncated,
				fetchShownChars: fetched.details.shownBytes === undefined ? undefined : fetched.details.totalChars,
				expectedLimit: ${maxInlineContentChars === undefined ? 30_000 : maxInlineContentChars},
				firstSliceEnd: Number(offsetMatch[1]),
				tailSeesTail: tailText.includes("TAIL"),
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

test("inline content defaults to 30,000 characters", async () => {
	const output = await runScenario(undefined);
	assert.equal(output.fetchTruncated, true);
	assert.equal(output.firstSliceEnd, output.expectedLimit);
	assert.equal(output.tailSeesTail, true);
});

test("maxInlineContentChars config raises the inline slice", async () => {
	const output = await runScenario(35_000);
	assert.equal(output.firstSliceEnd, output.expectedLimit);
	assert.equal(output.tailSeesTail, true);
});

test("both tools register with the expected names", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-names-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); } });
			console.log(JSON.stringify(tools.map(tool => tool.name)));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), ["web_search", "fetch_content"]);
});
