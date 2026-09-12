import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

const PAGE = "A".repeat(65_000) + "TAIL";

async function runScenario(script) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-minimal-paging-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			globalThis.fetch = async () => new Response(${JSON.stringify(PAGE)}, {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); } });
			const fetchTool = tools.find(tool => tool.name === "fetch_content");
			${script}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

test("fetch_content truncates long content and pages through stored content with offset", async () => {
	const output = await runScenario(`
		const first = await fetchTool.execute("call", { url: "https://93.184.216.34/page" });
		const firstText = first.content.find(item => item.type === "text").text;
		const offsetMatch = firstText.match(/offset: (\\d+)/);
		const firstOffset = Number(offsetMatch[1]);
		const second = await fetchTool.execute("call", { url: "https://93.184.216.34/page", offset: firstOffset });
		const secondText = second.content.find(item => item.type === "text").text;
		const allOffsets = [...secondText.matchAll(/offset: (\\d+)/g)].map(match => Number(match[1]));
		const secondOffset = allOffsets[allOffsets.length - 1];
		const third = await fetchTool.execute("call", { url: "https://93.184.216.34/page", offset: secondOffset });
		const thirdText = third.content.find(item => item.type === "text").text;
		const beyond = await fetchTool.execute("call", { url: "https://93.184.216.34/page", offset: 1000000 });
		console.log(JSON.stringify({
			truncated: first.details.truncated,
			totalChars: first.details.totalChars,
			firstOffset,
			hintMentionsOffset: /fetch_content\\(\\{ url: "https:\\/\\/93\\.184\\.216\\.34\\/page", offset: \\d+ \\}\\)/.test(firstText),
			secondSeesProgress: second.details.offset === firstOffset,
			secondTruncated: second.details.truncated,
			secondHint: /Showing chars \\d+\\u2013\\d+ of \\d+/.test(secondText),
			thirdSeesTail: thirdText.includes("TAIL"),
			thirdTruncated: third.details.truncated,
			beyondAtEnd: beyond.details.atEnd,
			beyondTotal: beyond.details.totalChars,
		}));
	`);
	assert.equal(output.truncated, true);
	assert.equal(output.totalChars, PAGE.length);
	assert.equal(output.firstOffset, 30_000);
	assert.equal(output.hintMentionsOffset, true);
	assert.equal(output.secondSeesProgress, true);
	assert.equal(output.secondTruncated, true);
	assert.equal(output.secondHint, true);
	assert.equal(output.thirdSeesTail, true);
	assert.equal(output.thirdTruncated, false);
	assert.equal(output.beyondAtEnd, true);
	assert.equal(output.beyondTotal, PAGE.length);
});

test("offset requires prior stored content and rejects multiple urls", async () => {
	const output = await runScenario(`
		const missing = await fetchTool.execute("call", { url: "https://93.184.216.34/never-fetched", offset: 0 });
		const multi = await fetchTool.execute("call", { urls: ["https://a.com/1", "https://b.com/2"], offset: 0 });
		const raw = await fetchTool.execute("call", { url: "https://93.184.216.34/page", mode: "raw", offset: 0 });
		console.log(JSON.stringify({
			missingError: /No stored content/.test(missing.details.error || missing.content[0].text),
			multiError: /single url/.test(multi.details.error || multi.content[0].text),
			rawError: /mode raw cannot be combined/.test(raw.details.error || raw.content[0].text),
		}));
	`);
	assert.equal(output.missingError, true);
	assert.equal(output.multiError, true);
	assert.equal(output.rawError, true);
});

test("offset works across separately fetched urls (cache is keyed per URL)", async () => {
	const output = await runScenario(`
		const first = await fetchTool.execute("call", { url: "https://93.184.216.34/one" });
		await fetchTool.execute("call", { url: "https://93.184.216.34/two" });
		const firstText = first.content.find(item => item.type === "text").text;
		const offsetMatch = firstText.match(/offset: (\\d+)/);
		const sliced = await fetchTool.execute("call", { url: "https://93.184.216.34/one", offset: Number(offsetMatch[1]) });
		console.log(JSON.stringify({ ok: !sliced.details.error, offset: sliced.details.offset }));
	`);
	assert.equal(output.ok, true);
	assert.equal(output.offset > 0, true);
});
