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

import { startAndInitialize, listTools, estimateTokens } from "./lib/mcpStdio.mjs";

const NEWLINE = String.fromCharCode(10);

// Ceilings, with the reason each one is where it is. These are budgets, not observations: raising
// one should be a decision someone argues for, not something that happens by adding a tool.
//
// All five were restated once, when this script started counting the `instructions` field. That
// field is standing context - a client sends it to the model every turn, exactly as it sends tool
// definitions - and counting only tools/list understated `search`, the frontier default, by 44%.
//
// The restatement is a CORRECTION, not a relaxation. Every ceiling encoded an intent about what a
// model has to hold before it can work; that intent always applied to the whole payload, and the
// old numbers simply measured part of it. Nothing got bigger on the day these changed. The new
// numbers keep the same intent against the quantity that was meant all along, and each is written
// as a fraction of the context it has to fit inside so the next person can check the arithmetic
// rather than trust the number.
const PROFILES = [
  {
    name: "minimal",
    // The profile that exists for the 14B-at-8k case. Half its context on tool definitions is
    // already generous; more than that and there is no room left to work in.
    // 5,000 of 8,192 is 61%, leaving ~3.2k to think and work in. Was 4,000 when only tools were
    // counted, which meant the real figure was ~4,800 all along and nobody was looking at it.
    ceilingTokens: 5_000,
    why: "must fit a 14B capped at 8k context with room left to think",
  },
  {
    name: "search",
    // Four tools: ping, doctor, list_tools, enable_tools. This is the frontier default, and the
    // ceiling is low on purpose - the moment anything else is standing here, the profile has
    // stopped being what it claims to be and the saving it exists for is gone.
    // Of this, 990 is instructions and only ~1,240 is tools. The instructions are what make four
    // tools usable at all, so they are the last thing to cut; 2,500 is still ~1% of a 200k window.
    ceilingTokens: 2_500,
    why: "the frontier default: everything reachable, almost nothing standing",
  },
  {
    name: "core",
    // Deliberately the same ceiling as `lazy`, because they expose the same tools: `core` registers
    // only this set, while `lazy` registers everything and disables all but this set so it can grow
    // at runtime. Identical tools/list output is the correct result, not a bug - which this script
    // established the hard way by asserting otherwise first.
    ceilingTokens: 13_000,
    why: "exposes the same surface as lazy, which a small model must hold before it can work",
  },
  {
    name: "lazy",
    // The recommended default, and the one the 5/5 local-model result was measured with.
    ceilingTokens: 13_000,
    why: "the recommended default; the local-model benchmark result is measured with this",
  },
  {
    name: "full",
    // Raised from 32,000 once, loudly, with the argument the header asks for.
    //
    // That number was set when `full` exposed 80 tools. It now exposes 95, and the growth is
    // capability rather than prose: C++ compilation, Data Asset properties, class defaults, Anim
    // Blueprints, Behavior Trees, project-wide variable tracing. The number that says whether
    // descriptions are bloating is the per-tool average, and it is flat - about 320 tokens a tool
    // then, about 330 now, after trimming the three newest descriptions that had drifted long.
    //
    // 34,000 is 17% of a 200k window, for the profile whose whole premise is "everything, for a
    // model that can afford it". Anything that cannot afford it has `search` and the presets, which
    // is where the real work on this went.
    ceilingTokens: 34_000,
    why: "everything, for frontier models that can afford it",
  },
];

async function measure(profile) {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: profile }, "measure-profiles");
  try {
    const { tools, chars, tokens } = await listTools(server);

    // The instructions field counts. A client sends it to the model on every turn exactly as it
    // sends tool definitions, so leaving it out did not make it free - it made this check report
    // less than half the standing cost on the `search` profile, which is the frontier default.
    const instructionChars = (server.instructions ?? "").length;
    const instructionTokens = estimateTokens(instructionChars);

    const perTool = tools
      .map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars);

    return {
      profile,
      toolCount: tools.length,
      chars,
      tokens,
      instructionTokens,
      standingTokens: tokens + instructionTokens,
      perTool,
    };
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

  console.log("Standing context by profile - what a model holds before its first call" + NEWLINE);
  console.log("  profile   tools   ~tools   ~instrs   standing   per tool   ceiling   ");
  console.log("  --------  ------  -------  --------  ---------  ---------  ----------");
  const problems = [];
  for (const result of results) {
    const spec = PROFILES.find((p) => p.name === result.profile);
    const over = result.standingTokens > spec.ceilingTokens;
    if (over) problems.push({ ...result, spec });
    console.log(
      `  ${result.profile.padEnd(8)}  ${String(result.toolCount).padStart(6)}  ` +
        `${String(result.tokens).padStart(7)}  ${String(result.instructionTokens).padStart(8)}  ` +
        `${String(result.standingTokens).padStart(9)}  ` +
        // Per-tool is the number that says whether DESCRIPTIONS are growing. The total also grows
        // when the surface grows, which is not the same thing and should not read as the same
        // problem: adding a capability is meant to cost something.
        `${String(Math.round(result.tokens / Math.max(result.toolCount, 1))).padStart(9)}  ` +
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
        `  - ${p.profile} is ~${p.standingTokens} tokens standing (${p.tokens} tools + ${p.instructionTokens} instructions), over its ${p.spec.ceilingTokens} ceiling.` +
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
