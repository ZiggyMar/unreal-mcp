/**
 * Put a number on the rubber-band, instead of arguing about it.
 *
 * Rubber-banding is a DISAGREEMENT: the server has the dragged character somewhere the owning
 * client does not, so the client keeps getting corrected and the player sees a snap-back. That is
 * measurable without watching anything - sample the same pawn's position in both worlds at the same
 * moment and look at the distance between the two answers.
 *
 * This exists because two fixes were shipped on the strength of reasoning and both were wrong. One
 * made it judder in place; the other moved nothing at all. Neither was measured before or after, so
 * neither could be compared to anything.
 *
 * Usage: node scripts/measure-rubberband.mjs [--seconds 8] [--label before]
 */
import { startAndInitialize } from "./lib/mcpStdio.mjs";

const valueOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SECONDS = Number(valueOf("--seconds", "8"));
const LABEL = valueOf("--label", "run");
// Milliseconds of one-way packet lag to simulate. Zero reproduces nothing; see below.
const LAG = Number(valueOf("--lag", "120"));
// How far apart to stand them.
//
// The first version used 300uu and measured almost nothing: the target arrived in 700ms and the
// drag was over before anything could go wrong. A pull bug needs a pull long enough to watch, so
// the default is far enough that the drag lasts seconds rather than a moment.
const GAP = Number(valueOf("--gap", "600"));
// Fire the throw partway through the drag.
//
// The person reporting this said the pull only misbehaves one way round, but the THROW misbehaves
// both ways - so the throw is a separate code path and has to be measured separately. It is also
// the path whose handler, VacuumPushed on BP_BaseCharacter, has nothing wired to it at all.
const THROW_AT = Number(valueOf("--throw-at", "0"));

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "rubberband");
const call = async (tool, args) => {
  const res = await server.request("tools/call", { name: "unreal_call_tool", arguments: { tool, args } });
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. A running two-player session, host as listen server - the setup the bug appears in.
const status = await call("unreal_pie_status", {});
if (!status.running) {
  // ignoreCompileErrors, because a project with unrelated broken sample content would otherwise
  // never start PIE at all - which is how this harness spent several runs measuring nothing.
  await call("unreal_start_pie", { numPlayers: 2, listenServer: true, ignoreCompileErrors: true });
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const s = await call("unreal_pie_status", {});
    if (s.running) break;
  }
  await sleep(4000);
}

const actors = await call("unreal_pie_actors", { actorClass: "BP_Player" });
if (!actors.actors?.length) {
  console.error("no players in PIE; is the session running?");
  process.exit(1);
}

// 2. Face them at each other, close enough to be in range and inside the aim cone. Without this the
//    key is held, the ability runs, and nothing is in reach - which proves nothing and looks like a
//    pass.
const host = actors.actors.find((a) => a.role === "Authority" && a.locallyControlled);
const other = actors.actors.find((a) => a.role === "Authority" && !a.locallyControlled);
if (!host || !other) {
  console.error("need one locally-controlled and one remote pawn on Authority");
  process.exit(1);
}
// Host looks along -X; put the target 300uu in front of it.
await call("unreal_teleport_actor", { actorClass: "BP_Player", name: host.name, x: host.x, y: host.y, z: host.z, yaw: 180, pitch: 0 });
await call("unreal_teleport_actor", { actorClass: "BP_Player", name: other.name, x: host.x - GAP, y: host.y, z: host.z, yaw: 0 });
await sleep(1200);

// 3. Give the network a latency to be wrong about.
//
// This is the whole reason the first measurement of this bug read "mean 1uu, no disagreement" while
// the person playing saw the character snapping back. PIE runs both worlds in one process with no
// lag, so the server's correction arrives in the same frame the client predicted - there is nothing
// to see. Prediction bugs are invisible at zero latency, which makes zero latency the worst place
// to test them and the default place everyone does.
if (LAG > 0) {
  await call("unreal_run_console_command", { command: `Net PktLag=${LAG}`, world: "pie" });
}
// The engine's own report of the thing being measured: it prints a line every time the server tells
// the client it was in the wrong place.
await call("unreal_run_console_command", { command: "p.NetShowCorrections 1", world: "pie" });
await sleep(500);

// 4. Hold the vacuum and sample both worlds' idea of where the dragged pawn is.
await call("unreal_press_input", { inputAction: "IA_Vacuum", seconds: SECONDS, world: "Authority" });

const samples = [];
let thrown = false;
const started = Date.now();
while ((Date.now() - started) / 1000 < SECONDS) {
  const now = await call("unreal_pie_actors", { actorClass: "BP_Player" });
  const rows = now.actors ?? [];
  // The dragged pawn is the one the host does NOT control. Matched by role rather than by name:
  // PIE gives the same pawn a different suffix in each world.
  const onServer = rows.find((a) => a.role === "Authority" && !a.locallyControlled);
  const onClient = rows.find((a) => a.role === "Client0" && a.locallyControlled);
  if (onServer && onClient) {
    const dx = onServer.x - onClient.x;
    const dy = onServer.y - onClient.y;
    const dz = onServer.z - onClient.z;
    samples.push({
      t: Math.round((Date.now() - started) / 100) / 10,
      disagreement: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz)),
      serverX: onServer.x,
      clientX: onClient.x,
    });
  }
  if (THROW_AT > 0 && !thrown && (Date.now() - started) / 1000 >= THROW_AT) {
    thrown = true;
    await call("unreal_press_input", { inputAction: "IA_Shoot", seconds: 0.2, world: "Authority" });
  }
  await sleep(100);
}

await call("unreal_press_input", { action: "stop" });

// The engine's own count of corrections, which is the definitive signal - a position disagreement
// can be sampling noise, a correction cannot.
const errors = await call("unreal_read_runtime_errors", {});
const corrections = (JSON.stringify(errors).match(/Client:\s*Error at/gi) ?? []).length;

if (samples.length === 0) {
  console.error("no samples - both worlds must have the dragged pawn");
  process.exit(1);
}

const gaps = samples.map((s) => s.disagreement);
const mean = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
const max = Math.max(...gaps);
// How far the pawn actually travelled on the server: a fix that stops the snapping by stopping the
// pull entirely is not a fix, and this is the number that catches that.
const travelled = Math.round(Math.abs(samples[samples.length - 1].serverX - samples[0].serverX));

console.log(`\n[${LABEL}] ${samples.length} samples over ${SECONDS}s`);
console.log(`  server/client disagreement:  mean ${mean}uu   max ${max}uu`);
console.log(`  distance the pawn was pulled: ${travelled}uu on the server`);
console.log(`  server corrections logged:    ${corrections}${LAG > 0 ? ` (at ${LAG}ms simulated lag)` : " (no lag simulated)"}`);
console.log(`  gap trace:    ${samples.map((s) => s.disagreement).join(" ")}`);
// The positions themselves, because "the gap went to zero" has two readings - they agreed, or the
// pull stopped and there was nothing left to disagree about - and only the profile tells them apart.
console.log(`  server X:     ${samples.map((s) => Math.round(s.serverX)).join(" ")}`);
console.log(`  client X:     ${samples.map((s) => Math.round(s.clientX)).join(" ")}`);
console.log(
  `\n  A fix must lower the disagreement AND keep the pull. Disagreement near zero with ` +
    `travelled near zero means the drag stopped working, not that it was fixed.`
);

server.child.kill();
