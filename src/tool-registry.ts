import { readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { Tool, ToolHandler, ToolContext } from "./tools/types.js";
import type OpenAI from "openai";
import { sendToChannel } from "./discord.js";

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
): Promise<string> {
  const tool = registry.get(toolName);
  if (!tool) return `Error: unknown tool "${toolName}"`;
  if (!tool.enabled) return `Error: tool "${toolName}" is currently disabled`;

  const context: ToolContext = { channelId, sendToChannel };

  try {
    return await tool.handler(args, context);
  } catch (err) {
    console.error(`Tools: execution error in "${toolName}":`, err);
    return `Error executing tool "${toolName}": ${String(err)}`;
  }
}

export function toggleTool(name: string): { found: boolean; enabled: boolean } {
  const tool = registry.get(name);
  if (!tool) return { found: false, enabled: false };
  tool.enabled = !tool.enabled;
  console.log(`Tools: "${name}" is now ${tool.enabled ? "enabled" : "disabled"}`);
  return { found: true, enabled: tool.enabled };
}
