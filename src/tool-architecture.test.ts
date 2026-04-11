import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTool, param, setToolConfigStore } from "./tools/types.js";
import memoryTool from "./tools/memory.js";
import notesTool from "./tools/notes.js";
import cronTool from "./tools/cron.js";
import linearTool from "./tools/linear.js";
import { loadToggleState, saveToolToggle } from "./state.js";

const TOGGLE_STATE_FILE = resolve("data", "toggle-state.json");

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, actual?: unknown): void {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}${actual !== undefined ? ` (got: ${JSON.stringify(actual)})` : ""}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

const TEST_CONTEXT = {
  channelId: "tool-arch-channel",
  userId: "tool-arch-user",
  sendToChannel: async () => {},
  sendFileToChannel: async () => {},
};

async function loadExportedToolNames(): Promise<string[]> {
  const toolsDir = resolve("src", "tools");
  const entries = readdirSync(toolsDir)
    .filter((entry) => [".ts", ".js"].includes(extname(entry)))
    .filter((entry) => basename(entry, extname(entry)) !== "types")
    .filter((entry) => !basename(entry, extname(entry)).startsWith("_"))
    .sort();

  const names: string[] = [];
  for (const entry of entries) {
    const mod = await import(pathToFileURL(join(toolsDir, entry)).href);
    names.push(mod.default.definition.name);
  }
  return names.sort();
}

function restoreToggleState(original: string | null): void {
  if (original === null) {
    if (existsSync(TOGGLE_STATE_FILE)) unlinkSync(TOGGLE_STATE_FILE);
    return;
  }
  writeFileSync(TOGGLE_STATE_FILE, original, "utf-8");
}

async function main(): Promise<void> {
  section("Registry Surface");
  const exportedNames = await loadExportedToolNames();
  const expectedNames = [
    "calendar",
    "cron",
    "date",
    "discord_history",
    "gmail",
    "google_calendar",
    "google_docs",
    "google_tasks",
    "linear",
    "luminizer",
    "memory",
    "notes",
    "ping",
    "quest",
    "set_mood",
    "tasks",
    "web_search",
  ].sort();

  assert(JSON.stringify(exportedNames) === JSON.stringify(expectedNames), "loadable tool names match the documented catalog", exportedNames);

  const skippedEntries = readdirSync(resolve("src", "tools"))
    .filter((entry) => [".ts", ".js"].includes(extname(entry)))
    .filter((entry) => basename(entry, extname(entry)).startsWith("_"))
    .sort();
  assert(skippedEntries.includes("_example-multi-action.ts"), "underscore-prefixed helper files exist for skip behavior");
  assert(!exportedNames.includes("_example-multi-action"), "underscore-prefixed helper files are not exported as tools");

  section("Helper Error Contract");
  const validationTool = defineTool({
    name: "validation_probe",
    description: "Validation probe",
    params: {
      count: param.number("Count", { required: true }),
    },
    handler: async ({ count }) => `Count ${count}`,
  });
  const validationResult = await validationTool.handler({ count: "bad" as unknown as number }, TEST_CONTEXT);
  assert(typeof validationResult === "string" && validationResult.startsWith("Error: invalid arguments:"), "defineTool prefixes validation failures with Error:", validationResult);

  setToolConfigStore({});
  const configProbe = defineTool({
    name: "config_probe",
    description: "Config probe",
    config: ["service.apiKey"],
    handler: async () => "ok",
  });
  const configResult = await configProbe.handler({}, TEST_CONTEXT);
  assert(typeof configResult === "string" && configResult.startsWith("Error: tool \"config_probe\" missing config:"), "defineTool prefixes missing-config failures with Error:", configResult);

  section("Tool Error Contract");
  setToolConfigStore({ linear: { apiKey: "test-key" } });
  const memoryUnknown = await memoryTool.handler({ action: "bogus" }, TEST_CONTEXT);
  const notesUnknown = await notesTool.handler({ action: "bogus" }, TEST_CONTEXT);
  const cronUnknown = await cronTool.handler({ action: "bogus" }, TEST_CONTEXT);
  const linearUnknown = await linearTool.handler({ action: "bogus" }, TEST_CONTEXT);

  assert(typeof memoryUnknown === "string" && memoryUnknown.startsWith("Error:"), "memory invalid action failure is Error-prefixed", memoryUnknown);
  assert(typeof notesUnknown === "string" && notesUnknown.startsWith("Error:"), "notes invalid action failure is Error-prefixed", notesUnknown);
  assert(typeof cronUnknown === "string" && cronUnknown.startsWith("Error:"), "cron invalid action failure is Error-prefixed", cronUnknown);
  assert(typeof linearUnknown === "string" && linearUnknown.startsWith("Error:"), "linear invalid action failure is Error-prefixed", linearUnknown);

  section("Memory Output Contract");
  const uniqueFact = `tool architecture fact ${Date.now()}`;

  const saveResult = await memoryTool.handler(
    { action: "save", scope: "user", fact: uniqueFact },
    TEST_CONTEXT,
  );
  assert(typeof saveResult === "object" && saveResult !== null && saveResult.text.startsWith("Remembered in user:"), "memory save returns human-readable text", saveResult);

  const duplicateResult = await memoryTool.handler(
    { action: "save", scope: "user", fact: uniqueFact },
    TEST_CONTEXT,
  );
  assert(typeof duplicateResult === "object" && duplicateResult !== null && duplicateResult.text.startsWith("Did not save fact in user:"), "memory duplicate save returns readable non-error text", duplicateResult);

  const forgetResult = await memoryTool.handler(
    { action: "forget", scope: "user", index: 0 },
    TEST_CONTEXT,
  );
  assert(typeof forgetResult === "object" && forgetResult !== null && forgetResult.text.startsWith("Forgot fact 0 from user."), "memory forget returns human-readable text", forgetResult);

  const clearResult = await memoryTool.handler(
    { action: "clear", scope: "user" },
    TEST_CONTEXT,
  );
  assert(typeof clearResult === "object" && clearResult !== null && clearResult.text.startsWith("Cleared "), "memory clear returns human-readable text", clearResult);

  section("Toggle Persistence");
  const originalToggleState = existsSync(TOGGLE_STATE_FILE) ? readFileSync(TOGGLE_STATE_FILE, "utf-8") : null;
  try {
    saveToolToggle("tool_arch_test_toggle", true);
    const saved = loadToggleState();
    assert(saved?.tools.tool_arch_test_toggle === true, "tool toggles are persisted via state.ts", saved);
  } finally {
    restoreToggleState(originalToggleState);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\n${passed} tests passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("tool-architecture.test.ts failed:", err);
  process.exit(1);
});
