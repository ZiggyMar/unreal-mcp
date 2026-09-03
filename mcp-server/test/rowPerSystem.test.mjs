import { test } from "node:test";
import assert from "node:assert/strict";

import { placeNewNodes, boxesForBatch } from "../dist/placeNewNodes.js";

const ev = (id, pins = []) => ({ id, title: id, type: "K2Node_CustomEvent", x: 0, y: 0, pins });
const fn = (id, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x: 0, y: 0, pins });
const host = { id: "existing", title: "Comment", type: "EdGraphNode_Comment", x: -9e4, y: -9e4, width: 100, height: 100, text: "E" };

/** Three replicated systems built in one call, the shape that exposed this. */
function threeSystems(len = 6) {
  const nodes = [host];
  for (const [e, t] of [["CE_ServerSound", "s"], ["CE_MC_Sound", "m"], ["CE_ClientSound", "c"]]) {
    nodes.push(ev(e, [`out then -> ${t}0.execute`]));
    for (let i = 0; i < len; i++) nodes.push(fn(`${t}${i}`, i < len - 1 ? [`out then -> ${t}${i + 1}.execute`] : []));
  }
  return nodes;
}

test("each system in a batch gets its own row", () => {
  // Three systems built in one call came out as 21 nodes on a single line, 5200 wide and 0 tall.
  const nodes = threeSystems();
  const fresh = nodes.filter((n) => n !== host);
  const placed = placeNewNodes(nodes, fresh.map((n) => n.id));
  assert.equal(new Set(placed.map((p) => p.y)).size, 3, "three systems, three rows");
});

test("the box round them is a shape this project draws", () => {
  // 5820x360 is 16:1. The widest comment box in the project is 4.2:1 and the median is 2.6:1.
  const nodes = threeSystems();
  const fresh = nodes.filter((n) => n !== host);
  const placed = placeNewNodes(nodes, fresh.map((n) => n.id));
  for (const p of placed) { const f = fresh.find((x) => x.id === p.nodeId); f.x = p.x; f.y = p.y; }
  const outer = boxesForBatch(nodes, fresh.map((n) => n.id), placed).find((b) => b.outer);
  assert.ok(outer, "a shared-word outer box");
  assert.ok(outer.width / outer.height < 6, `outer box is ${outer.width}x${outer.height}`);
});

test("a single chain is still one row", () => {
  // A chain runs left to right. Splitting one would be inventing structure that is not there.
  const nodes = [host, ev("CE_Solo", ["out then -> a0.execute"])];
  for (let i = 0; i < 5; i++) nodes.push(fn(`a${i}`, i < 4 ? [`out then -> a${i + 1}.execute`] : []));
  const fresh = nodes.filter((n) => n !== host);
  const placed = placeNewNodes(nodes, fresh.map((n) => n.id));
  assert.equal(new Set(placed.map((p) => p.y)).size, 1);
});

test("a node no system reaches is still placed, not dropped", () => {
  const nodes = [host, ev("CE_Solo", ["out then -> a.execute"]), fn("a"), fn("orphan")];
  const fresh = nodes.filter((n) => n !== host);
  const placed = placeNewNodes(nodes, fresh.map((n) => n.id));
  assert.equal(placed.length, fresh.length, "every fresh node got a position");
  assert.ok(placed.some((p) => p.nodeId === "orphan"));
});

test("rows never overlap each other", () => {
  const nodes = threeSystems(8);
  const fresh = nodes.filter((n) => n !== host);
  const placed = placeNewNodes(nodes, fresh.map((n) => n.id));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const apart = Math.max(Math.abs(placed[i].x - placed[j].x), Math.abs(placed[i].y - placed[j].y));
      assert.ok(apart >= 60, `${placed[i].nodeId} and ${placed[j].nodeId} only ${apart} apart`);
    }
  }
});
