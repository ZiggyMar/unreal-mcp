import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSourceRoots, searchSource, modulesByName, matchesByFile } from "../dist/nativeSource.js";

/**
 * A project tree shaped like a real one: a game module, an editor module, a plugin with its own
 * Source, and build output that must never be searched.
 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "unreal-mcp-src-"));
  const write = (rel, text) => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  };

  write("MyGame.uproject", "{}");

  // A module is a directory under Source/ that declares itself with a .Build.cs. That is how
  // UnrealBuildTool decides, and it is why Public/ and Private/ are not modules.
  write("Source/MyGame/MyGame.Build.cs", "public class MyGame : ModuleRules {}");

  write(
    "Source/MyGame/Public/MyCharacter.h",
    [
      "#pragma once",
      "// AMyCharacter is the base for every playable pawn.",
      "UCLASS()",
      "class MYGAME_API AMyCharacter : public ACharacter",
      "{",
      "  GENERATED_BODY()",
      "public:",
      "  UPROPERTY(EditAnywhere, Replicated)",
      "  float Health = 100.f;",
      "",
      "  UFUNCTION(BlueprintCallable)",
      "  void ApplyDamage(float Amount);",
      "};",
    ].join("\n")
  );

  write(
    "Source/MyGame/Private/MyCharacter.cpp",
    [
      '#include "MyCharacter.h"',
      "",
      "void AMyCharacter::ApplyDamage(float Amount)",
      "{",
      "  Health -= Amount;",
      "}",
    ].join("\n")
  );

  write("Source/MyGameEditor/MyGameEditor.Build.cs", "public class MyGameEditor {}");
  write("Plugins/Cool/Source/CoolRuntime/CoolRuntime.Build.cs", "public class CoolRuntime : ModuleRules {}");
  write("Plugins/Cool/Source/CoolRuntime/CoolThing.h", "class COOL_API UCoolThing {};");

  // A plugin that puts Public/ and Private/ straight under Source/, with no module folder between.
  // These are NOT modules; reporting them as such offered a model two places to put new code that
  // do not exist as modules at all. Measured on a real project: 26 "modules" were really 15.
  write("Plugins/Flat/Source/Public/FlatThing.h", "class FLAT_API UFlatThing {};");
  write("Plugins/Flat/Source/Private/FlatThing.cpp", "// nothing");

  // Build output. If any of this is ever searched, the scan is wrong.
  write("Binaries/Win64/MyGame.dll", "AMyCharacter Health ApplyDamage");
  write("Intermediate/Build/Generated.h", "class MYGAME_API AMyCharacter {};");

  return { root, projectFile: join(root, "MyGame.uproject") };
}

test("source roots cover project modules and plugin modules, and nothing else", () => {
  const { root, projectFile } = makeProject();
  try {
    const roots = findSourceRoots(projectFile);
    const names = roots.map((r) => r.module).sort();
    assert.deepEqual(names, ["CoolRuntime", "MyGame", "MyGameEditor"]);

    const cool = roots.find((r) => r.module === "CoolRuntime");
    assert.equal(cool.kind, "plugin", "a plugin's module must be marked as one");
    assert.equal(roots.find((r) => r.module === "MyGame").kind, "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a class declaration outranks every other mention of the same name", () => {
  const { root, projectFile } = makeProject();
  try {
    const roots = findSourceRoots(projectFile);
    const { matches } = searchSource(projectFile, roots, "AMyCharacter");

    assert.ok(matches.length > 0, "the class should be found at all");
    assert.equal(matches[0].kind, "class", `expected the declaration first, got ${matches[0].kind}`);
    assert.match(matches[0].file, /MyCharacter\.h$/);
    assert.equal(matches[0].line, 4, "line numbers are 1-based and must point at the declaration");

    // The .cpp definition should be present and ranked above a bare mention.
    const def = matches.find((m) => m.kind === "definition");
    assert.ok(def, "the constructor/method definition in the .cpp should be found");
    assert.match(def.file, /MyCharacter\.cpp$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build output is never searched", () => {
  const { root, projectFile } = makeProject();
  try {
    const roots = findSourceRoots(projectFile);
    const { matches } = searchSource(projectFile, roots, "AMyCharacter");
    for (const m of matches) {
      assert.doesNotMatch(m.file, /Binaries|Intermediate/, `build output leaked into results: ${m.file}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matching is whole-word, so Health does not drag in every HealthBar", () => {
  const { root, projectFile } = makeProject();
  try {
    mkdirSync(join(root, "Source/MyGame/Public"), { recursive: true });
    writeFileSync(
      join(root, "Source/MyGame/Public/HUD.h"),
      ["class AMyHUD", "{", "  float HealthBarWidth;", "  float HealthPercent;", "};"].join("\n"),
      "utf8"
    );

    const roots = findSourceRoots(projectFile);
    const { matches } = searchSource(projectFile, roots, "Health");
    assert.ok(matches.length > 0, "the real Health property should still be found");
    for (const m of matches) {
      assert.doesNotMatch(m.text, /HealthBarWidth|HealthPercent/, `substring noise leaked in: ${m.text}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paths come back relative to the project and with forward slashes", () => {
  const { root, projectFile } = makeProject();
  try {
    const roots = findSourceRoots(projectFile);
    const { matches } = searchSource(projectFile, roots, "ApplyDamage");
    assert.ok(matches.length > 0);
    for (const m of matches) {
      assert.doesNotMatch(m.file, /\\/, "backslashes are not quotable across platforms");
      assert.match(m.file, /^Source\//, "paths should be relative to the project root");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symbol that is not there says so rather than guessing", () => {
  const { root, projectFile } = makeProject();
  try {
    const roots = findSourceRoots(projectFile);
    const { matches, totalMatches } = searchSource(projectFile, roots, "ANonexistentThing");
    assert.equal(matches.length, 0);
    assert.equal(totalMatches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project with no C++ at all is not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "unreal-mcp-bponly-"));
  try {
    writeFileSync(join(root, "BpOnly.uproject"), "{}", "utf8");
    const projectFile = join(root, "BpOnly.uproject");
    assert.deepEqual(findSourceRoots(projectFile), []);
    const { matches } = searchSource(projectFile, [], "Anything");
    assert.deepEqual(matches, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare mentions are sampled, declarations and definitions never are", () => {
  // Searching a common symbol returned 30 matches of which 25 were bare mentions - the kind that
  // says "this file also refers to it" and answers nothing, ranked last and costing most of the
  // reply. Capping them keeps every hit that locates the thing.
  const { root, projectFile } = makeProject();
  try {
    // Bare mentions: lines that reference the symbol without declaring or defining it.
    const noisy = ["void Unrelated() {", ...Array.from({ length: 30 }, (_, i) => `  Register(AMyCharacter);`), "}"];
    writeFileSync(join(root, "Source/MyGame/Private/Noise.cpp"), noisy.join("\n"), "utf8");

    const roots = findSourceRoots(projectFile);
    const res = searchSource(projectFile, roots, "AMyCharacter");
    const mentions = res.matches.filter((m) => m.kind === "mention");
    assert.ok(mentions.length <= 5, `mentions should be sampled, got ${mentions.length}`);
    assert.ok(
      res.matches.some((m) => m.kind === "class"),
      "the declaration must survive the cap"
    );
    assert.ok(res.totalMatches > res.matches.length, "the total is still reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the module list drops the three things it was spelling on every row", () => {
  // String.raw, because these are Windows paths. "\P" is not an escape sequence, so a plain string
  // literal silently drops every separator - and the test would then be measuring nothing.
  const roots = [
    { module: "MyGame", dir: String.raw`M:\Projects\MyGame\Source\MyGame`, kind: "project" },
    { module: "Kronos", dir: String.raw`M:\Projects\MyGame\Plugins\KronosV8\Source\Kronos`, kind: "plugin" },
  ];
  const map = modulesByName(roots, String.raw`M:\Projects\MyGame`);
  assert.deepEqual(map, {
    MyGame: "Source/MyGame",
    // The plugin FOLDER is not the module name, which is why the path cannot simply be derived from
    // the name and has to be carried.
    Kronos: "Plugins/KronosV8/Source/Kronos",
  });
  // kind is gone because the first path segment already says it - the same rule that assigned it.
  assert.ok(!JSON.stringify(map).includes("plugin"));
  // fromCharCode(92) is a backslash, written the one way that cannot be mangled by an editor, a
  // heredoc, or a raw template literal - none of which can end in one.
  const BACKSLASH = String.fromCharCode(92);
  assert.ok(
    !Object.values(map).some((dir) => dir.includes(BACKSLASH)),
    "separators must be forward slashes, which JSON does not have to escape"
  );
});

test("a module outside the project keeps a path that still works", () => {
  // A relative path that escapes upward would be worse than the absolute one it replaced.
  const map = modulesByName(
    [{ module: "Shared", dir: String.raw`D:\Common\Shared`, kind: "plugin" }],
    String.raw`M:\Projects\MyGame`
  );
  assert.equal(map.Shared, "D:/Common/Shared");
});

test("matches group under the file, and stay quotable as file:line", () => {
  const grouped = matchesByFile([
    { file: "Source/MyGame/Foo.h", line: 12, kind: "class", text: "class AFoo : public AActor" },
    { file: "Source/MyGame/Foo.cpp", line: 40, kind: "definition", text: "void AFoo::Tick()" },
    { file: "Source/MyGame/Foo.cpp", line: 51, kind: "mention", text: "AFoo* Other = nullptr;" },
  ]);
  assert.deepEqual(Object.keys(grouped), ["Source/MyGame/Foo.h", "Source/MyGame/Foo.cpp"]);
  // The file is written once for both of its hits - that repetition was up to 40% of the reply.
  assert.equal(grouped["Source/MyGame/Foo.cpp"].length, 2);
  assert.equal(grouped["Source/MyGame/Foo.cpp"][0], "40 definition: void AFoo::Tick()");
  // kind survives on every hit. It is the difference between "declared here" and "also mentions it",
  // which is the entire ranking this search exists to produce.
  assert.ok(grouped["Source/MyGame/Foo.cpp"][1].startsWith("51 mention:"));
});

test("ordering within a file is preserved, because rank is the product", () => {
  const grouped = matchesByFile([
    { file: "a.h", line: 9, kind: "class", text: "class A" },
    { file: "b.cpp", line: 1, kind: "mention", text: "A a;" },
    { file: "a.h", line: 30, kind: "property", text: "int X;" },
  ]);
  assert.deepEqual(grouped["a.h"], ["9 class: class A", "30 property: int X;"]);
  // And the first file is still the highest-ranked one, not whichever sorted first.
  assert.equal(Object.keys(grouped)[0], "a.h");
});
