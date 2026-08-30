import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseBuildOutput,
  buildBatchPath,
  extractFailureReason,
  guidanceFor,
  unityNote,
  MAX_DIAGNOSTICS,
} from "../dist/nativeBuild.js";

const NL = String.fromCharCode(10);

test("an MSVC error is parsed into file, line, code and message", () => {
  const out = [
    "[1/1] Compile [x64] MyCharacter.cpp",
    "M:\\Proj\\Source\\MyGame\\Private\\MyCharacter.cpp(42): error C2065: 'Healht': undeclared identifier",
    "Result: Failed",
  ].join(NL);
  const { errors, succeeded } = parseBuildOutput(out, "M:\\Proj");
  assert.equal(succeeded, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 42);
  assert.equal(errors[0].code, "C2065");
  assert.match(errors[0].message, /undeclared identifier/);
  assert.equal(errors[0].file, "Source/MyGame/Private/MyCharacter.cpp", "paths should be project-relative");
});

test("a clang error is parsed too, since UBT is not Windows-only", () => {
  const out = ["/proj/Source/MyGame/Private/Foo.cpp:9:5: error: use of undeclared identifier 'Bar'", "Result: Failed"].join(NL);
  const { errors } = parseBuildOutput(out, "/proj");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 9);
  assert.equal(errors[0].column, 5);
  assert.match(errors[0].message, /undeclared identifier/);
});

test("the same diagnostic reported twice is counted once", () => {
  // UBT echoes a diagnostic from the compiler and again in its own summary. Counting both reports
  // four errors where a human sees two, which makes the count useless for deciding what to fix.
  const line = "M:\\Proj\\Source\\A.cpp(7): error C2039: 'X': is not a member of 'Y'";
  const { errors } = parseBuildOutput([line, line, "Result: Failed"].join(NL), "M:\\Proj");
  assert.equal(errors.length, 1);
});

test("warnings are separated from errors, not mixed in", () => {
  const out = [
    "M:\\Proj\\Source\\A.cpp(3): warning C4996: 'x': deprecated",
    "M:\\Proj\\Source\\A.cpp(7): error C2065: 'y': undeclared identifier",
    "Result: Failed",
  ].join(NL);
  const { errors, warnings } = parseBuildOutput(out, "M:\\Proj");
  assert.equal(errors.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, "warning");
});

test("success requires BOTH the success line and no errors", () => {
  // Trusting UBT's word alone has bitten this repo before; so has trusting an exit code. If a build
  // says it succeeded while errors are present, something is wrong and the honest answer is "no".
  assert.equal(parseBuildOutput("Result: Succeeded").succeeded, true);
  assert.equal(parseBuildOutput("Result: Failed").succeeded, false);
  const contradictory = ["M:\\P\\A.cpp(1): error C1: bad", "Result: Succeeded"].join(NL);
  assert.equal(parseBuildOutput(contradictory, "M:\\P").succeeded, false);
});

test("engine headers keep their absolute path rather than a path climbing out of the project", () => {
  const out = "M:\\Unreal\\UE_5.6\\Engine\\Source\\Runtime\\Core\\Public\\X.h(10): error C2065: 'z': undeclared identifier";
  const { errors } = parseBuildOutput(out, "M:\\Proj");
  assert.doesNotMatch(errors[0].file, /^\.\./, "a ../../.. path is harder to read than the absolute one");
  assert.match(errors[0].file, /UE_5\.6/);
});

test("build output with no diagnostics parses cleanly rather than throwing", () => {
  // The link-failure case: the editor holds the DLL, the build fails, and there is not one compiler
  // diagnostic in it. The tool has to survive that and say something useful.
  const { errors, warnings, succeeded } = parseBuildOutput("LINK : fatal error LNK1104: cannot open file" + NL + "Result: Failed");
  assert.equal(succeeded, false);
  assert.equal(errors.length, 0, "LNK1104 has no file(line) prefix, so it is not a source diagnostic");
  assert.equal(warnings.length, 0);
});

test("Build.bat is located whether engineDir ends in Engine or not", () => {
  // ping reports FPaths::EngineDir(), which ends in /Engine/. A caller passing the install root is
  // the obvious mistake and costs nothing to absorb.
  assert.match(buildBatchPath("M:/Unreal/UE_5.6/Engine/"), /Engine[\\/]Build[\\/]BatchFiles[\\/]Build\.bat$/);
  assert.match(buildBatchPath("M:/Unreal/UE_5.6"), /Engine[\\/]Build[\\/]BatchFiles[\\/]Build\.bat$/);
  const once = buildBatchPath("M:/Unreal/UE_5.6/Engine");
  assert.equal(once.match(/Engine/g).length, 1, "Engine must not be appended to a path that has it");
});

test("a wall of errors is capped, and the total is still reported", () => {
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(`M:\\P\\A.cpp(${i}): error C2065: 'v${i}': undeclared identifier`);
  const { errors } = parseBuildOutput(lines.join(NL), "M:\\P");
  assert.equal(errors.length, 40, "the parser reports everything; capping is the tool's job");
  assert.ok(MAX_DIAGNOSTICS < 40, "and the tool's cap must actually be a cap");
});

test("a failure with no diagnostics reports what the build actually said", () => {
  // Found by running the tool for real: it failed with zero errors and the reply confidently blamed
  // a link step holding the DLL open. It was a Wwise plugin referencing an AkAudio module that is
  // not installed, so UBT refused before compiling anything. A wrong explanation sends a model
  // hunting a problem that is not there, in code that is fine.
  const out = [
    "Creating makefile for UnrealEditor (no existing makefile)",
    "Could not find definition for module 'AkAudio', (referenced via allmodules option -> Wwise.uplugin)",
    "Result: Failed (RulesError)",
  ].join(NL);
  const reason = extractFailureReason(out);
  assert.ok(reason.some((l) => /AkAudio/.test(l)), "the one informative line must survive");
  assert.match(guidanceFor(reason), /configuration, not/i, "it must not blame the caller's code");
  assert.doesNotMatch(guidanceFor(reason), /link/i, "there is no link step to blame here");
});

test("a genuine link failure still gets the link explanation", () => {
  const reason = extractFailureReason("LINK : fatal error LNK1104: cannot open file 'X.dll'" + NL + "Result: Failed");
  assert.match(guidanceFor(reason), /editor running/i);
});

test("missing-declaration errors from a single-file compile carry the unity-build explanation", () => {
  // The live case: this tool's first real run reported ten errors in the plugin's own
  // MCPTcpServer.cpp, a file that builds cleanly on both engines. It used TJsonWriterFactory without
  // including it and got the header from a neighbour in the unity blob. The errors were real - the
  // file could not build alone - but no edit caused them, and a model told "ten errors" with no
  // explanation would set about fixing code its change had not broken.
  const errs = [{ file: "A.cpp", line: 1, code: "C2065", message: "'TJsonWriter': undeclared identifier", severity: "error" }];
  const note = unityNote("A.cpp", errs);
  assert.match(note, /unity/i);
  assert.match(note, /may predate your edit/i, "it must say the errors might not be the caller's doing");
  assert.match(note, /still real/i, "and must not excuse them either - the file cannot build alone");
});

test("an ordinary mistake gets no unity note, so the note stays meaningful", () => {
  const errs = [{ file: "A.cpp", line: 1, code: "C4430", message: "missing type specifier", severity: "error" }];
  assert.equal(unityNote("A.cpp", errs), undefined);
});

test("a full build gets no unity note, because unity is exactly what a full build uses", () => {
  const errs = [{ file: "A.cpp", line: 1, code: "C2065", message: "'X': undeclared identifier", severity: "error" }];
  assert.equal(unityNote(undefined, errs), undefined);
});
