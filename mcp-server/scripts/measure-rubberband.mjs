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
  await call("unreal_start_pie", { numPlayers: 2, listenServer: true });
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
await call("unreal_teleport_actor", { actorClass: "BP_Player", name: other.name, x: host.x - 300, y: host.y, z: host.z, yaw: 0 });
await sleep(1200);

// 3. Hold the vacuum and sample both worlds' idea of where the dragged pawn is.
await call("unreal_press_input", { inputAction: "IA_Vacuum", seconds: SECONDS, world: "Authority" });

const samples = [];
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
  await sleep(250);
}

await call("unreal_press_input", { action: "stop" });

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
console.log(`  trace: ${samples.map((s) => s.disagreement).join(" ")}`);
console.log(
  `\n  A fix must lower the disagreement AND keep the pull. Disagreement near zero with ` +
    `travelled near zero means the drag stopped working, not that it was fixed.`
);

server.child.kill();
