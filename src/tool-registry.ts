import { readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { Tool, ToolHandler, ToolContext } from "./tools/types.js";
import type OpenAI from "openai";
import { sendToChannel } from "./discord.js";
import { loadToggleState, saveToolToggle } from "./state.js";

export type RegisteredTool = {
  name: string;
  description: string;
  handler: ToolHandler;
  enabled: boolean;
  parameters?: Record<string, unknown>;
};

const registry = new Map<string, RegisteredTool>();

export async function loadTools(): Promise<void> {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const toolsDir = join(__dirname, "tools");

  if (!existsSync(toolsDir)) {
    console.warn("Tools: src/tools/ directory not found, no tools loaded");
    return;
  }

  const entries = readdirSync(toolsDir);

  for (const entry of entries) {
    const ext = extname(entry);
    const name = basename(entry, ext);

    // Skip types, helpers, and non-code files
    if (name === "types" || name.startsWith("_")) continue;
    if (ext !== ".ts" && ext !== ".js") continue;

    try {
      const modulePath = pathToFileURL(join(toolsDir, entry)).href;
      const mod = await import(modulePath);
      const tool: Tool = mod.default;

      if (!tool?.definition?.name || typeof tool.handler !== "function") {
        console.warn(`Tools: skipping ${entry} (invalid export shape)`);
        continue;
      }

      registry.set(tool.definition.name, {
        name: tool.definition.name,
        description: tool.definition.description,
        handler: tool.handler,
        enabled: tool.enabled,
        parameters: tool.definition.parameters,
      });

      console.log(
        `Tools: loaded "${tool.definition.name}" (${tool.enabled ? "enabled" : "disabled"})`,
      );
    } catch (err) {
      console.error(`Tools: failed to load ${entry}:`, err);
    }
  }

  // Apply saved toggle overrides
  const saved = loadToggleState();
  if (saved?.tools) {
    for (const [name, enabled] of Object.entries(saved.tools)) {
      const tool = registry.get(name);
      if (tool && tool.enabled !== enabled) {
        tool.enabled = enabled;
        console.log(`Tools: restored "${name}" as ${enabled ? "enabled" : "disabled"}`);
      }
    }
  }

  console.log(
    `Tools: ${registry.size} tool(s) loaded, ${getEnabledTools().length} enabled`,
  );
}

export function getAllTools(): RegisteredTool[] {
  return Array.from(registry.values());
}

export function getEnabledTools(): RegisteredTool[] {
  return Array.from(registry.values()).filter((t) => t.enabled);
}

export function getToolDefinitionsForOpenAI(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return getEnabledTools().map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      ...(t.parameters ? { parameters: t.parameters } : {}),
    },
  }));
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  channelId: string | null,
  userId?: string | null,
): Promise<string> {
  const tool = registry.get(toolName);
  if (!tool) return `Error: unknown tool "${toolName}"`;
  if (!tool.enabled) return `Error: tool "${toolName}" is currently disabled`;

  const argSummary = Object.keys(args).length > 0
    ? Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60)}`).join(", ")
    : "(no args)";
  console.log(`Tools: executing "${toolName}" (${argSummary})`);

  const context: ToolContext = { channelId, userId: userId ?? null, sendToChannel };
  const start = Date.now();

  try {
    const result = await tool.handler(args, context);
    console.log(`Tools: "${toolName}" completed in ${Date.now() - start}ms (result: ${result.slice(0, 100)}${result.length > 100 ? "..." : ""})`);
    return result;
  } catch (err) {
    console.error(`Tools: "${toolName}" failed after ${Date.now() - start}ms:`, err);
    return `Error executing tool "${toolName}": ${String(err)}`;
  }
}

export function toggleTool(name: string): { found: boolean; enabled: boolean } {
  const tool = registry.get(name);
  if (!tool) return { found: false, enabled: false };
  tool.enabled = !tool.enabled;
  saveToolToggle(name, tool.enabled);
  console.log(`Tools: "${name}" is now ${tool.enabled ? "enabled" : "disabled"}`);
  return { found: true, enabled: tool.enabled };
}
