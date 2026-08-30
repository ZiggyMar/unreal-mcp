#!/usr/bin/env node
// Measure the tool-definition payload of every profile, and refuse to let it creep.
//
// This project has a measured finding that makes profile size a correctness concern rather than a
// tidiness one: a 14B on a 12 GB card loads at 8k context and fails outright at 16k, so a tool list
// that is itself ~9k tokens consumes the entire budget such a model has. **Tool payload size does
// not merely cost tokens; it decides which models can be driven at all.**
//
// The sizes were measured once by hand and written into the docs, where they promptly began to rot
// — four tools were added to `lazy` without anyone re-measuring. A number in a document that
// nothing checks is a number that is eventually wrong, so this measures them and fails when a
// profile crosses the ceiling its intended model can hold.
//
// Usage: node scripts/measure-profiles.mjs [--json]
//
// Needs no editor: tool definitions are static, which is exactly why this can run in the normal
// test suite while live-verify cannot.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);

// Ceilings, with the reason each one is where it is. These are budgets, not observations: raising
// one should be a decision someone argues for, not something that happens by adding a tool.
const PROFILES = [
  {
    name: "minimal",
    // The profile that exists for the 14B-at-8k case. Half its context on tool definitions is
    // already generous; more than that and there is no room left to work in.
    ceilingTokens: 4_000,
    why: "must fit a 14B capped at 8k context with room left to think",
  },
  {
    name: "search",
    // Four tools: ping, doctor, list_tools, enable_tools. This is the frontier default, and the
    // ceiling is low on purpose - the moment anything else is standing here, the profile has
    // stopped being what it claims to be and the saving it exists for is gone.
    ceilingTokens: 2_000,
    why: "the frontier default: everything reachable, almost nothing standing",
  },
  {
    name: "core",
    // Deliberately the same ceiling as `lazy`, because they expose the same tools: `core` registers
    // only this set, while `lazy` registers everything and disables all but this set so it can grow
    // at runtime. Identical tools/list output is the correct result, not a bug - which this script
    // established the hard way by asserting otherwise first.
    ceilingTokens: 12_000,
    why: "exposes the same surface as lazy, which a small model must hold before it can work",
  },
  {
    name: "lazy",
    // The recommended default, and the one the 5/5 local-model result was measured with.
    ceilingTokens: 12_000,
    why: "the recommended default; the local-model benchmark result is measured with this",
  },
  {
    name: "full",
    ceilingTokens: 32_000,
    why: "everything, for frontier models that can afford it",
  },
];

/**
 * Tokens are estimated from characters rather than tokenised properly.
 *
 * A real tokeniser would be more accurate and would also make this script depend on one. The ratio
 * for English prose plus JSON punctuation sits near 4 characters per token, and since every number
 * here is compared against a ceiling with a lot of headroom, the estimate is honest enough for the
 * decision it informs. It is deliberately reported as an estimate everywhere it appears.
 */
const estimateTokens = (chars) => Math.round(chars / 4);

function startServer(profile) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, UNREAL_MCP_PROFILE: profile, UNREAL_MCP_MODE: "standard" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = new Map();
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf(NEWLINE)) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + NEWLINE);
    });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + NEWLINE);
  return { child, request, notify };
}

async function measure(profile) {
  const server = startServer(profile);
  try {
    await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "measure-profiles", version: "1" },
    });
    server.notify("notifications/initialized");
    const listed = await server.request("tools/list", {});
    const tools = listed?.result?.tools ?? [];

    // What a client actually pays for is the serialized definitions it sends to the model, so
    // measure that rather than counting descriptions.
    const chars = JSON.stringify(tools).length;
    const perTool = tools
      .map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars);

    return { profile, toolCount: tools.length, chars, tokens: estimateTokens(chars), perTool };
  } finally {
    server.child.kill();
  }
}

async function main() {
  const asJson = process.argv.includes("--json");
  const results = [];
  for (const { name } of PROFILES) {
    results.push(await measure(name));
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("Tool-definition payload by profile (estimated at 4 chars/token):" + NEWLINE);
  console.log("  profile   tools   chars    ~tokens   ceiling   ");
  console.log("  --------  ------  -------  --------  ----------");
  const problems = [];
  for (const result of results) {
    const spec = PROFILES.find((p) => p.name === result.profile);
    const over = result.tokens > spec.ceilingTokens;
    if (over) problems.push({ ...result, spec });
    console.log(
      `  ${result.profile.padEnd(8)}  ${String(result.toolCount).padStart(6)}  ` +
        `${String(result.chars).padStart(7)}  ${String(result.tokens).padStart(8)}  ` +
        `${String(spec.ceilingTokens).padStart(8)}  ${over ? "OVER" : "ok"}`
    );
  }

  // The largest definitions are the actionable part: on a small model, description length is a real
  // cost, and this benchmark has already seen ~600 extra characters push a 7B into truncating its
  // output mid-JSON.
  const lazy = results.find((r) => r.profile === "lazy");
  if (lazy) {
    console.log(NEWLINE + "Largest definitions in `lazy` (where trimming pays most):");
    for (const tool of lazy.perTool.slice(0, 5)) {
      console.log(`  ${String(tool.chars).padStart(5)} chars  ${tool.name}`);
    }
  }

  if (problems.length > 0) {
    console.log(NEWLINE + `profile budget exceeded (${problems.length}):`);
    for (const p of problems) {
      console.log(
        `  - ${p.profile} is ~${p.tokens} tokens, over its ${p.spec.ceilingTokens} ceiling.` +
          NEWLINE +
          `    That ceiling exists because it ${p.spec.why}.` +
          NEWLINE +
          `    Either trim a description, move a tool to a group this profile does not include,` +
          NEWLINE +
          `    or argue for a higher ceiling here - but do not raise it silently.`
      );
    }
    process.exit(1);
  }
  console.log(NEWLINE + `profiles ok: ${results.length} profiles, all within budget`);
}

main().catch((err) => {
  console.error(`could not measure profiles: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
