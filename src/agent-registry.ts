import { readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Agent, AgentDefinition } from "./agents/types.js";
import type OpenAI from "openai";

export type RegisteredAgent = {
  name: string;
  description: string;
  definition: AgentDefinition;
  postProcess?: Agent["postProcess"];
  enabled: boolean;
};

const registry = new Map<string, RegisteredAgent>();

export async function loadAgents(): Promise<void> {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const agentsDir = join(__dirname, "agents");

  if (!existsSync(agentsDir)) {
    console.warn("Agents: src/agents/ directory not found, no agents loaded");
    return;
  }

  const entries = readdirSync(agentsDir);

  for (const entry of entries) {
    const ext = extname(entry);
    const name = basename(entry, ext);

    // Skip types, helpers, and non-code files
    if (name === "types" || name.startsWith("_")) continue;
    if (ext !== ".ts" && ext !== ".js") continue;

    try {
      const modulePath = pathToFileURL(join(agentsDir, entry)).href;
      const mod = await import(modulePath);
      const agent: Agent = mod.default;

      if (!agent?.definition?.name || !agent.definition.systemPrompt) {
        console.warn(`Agents: skipping ${entry} (invalid export shape)`);
        continue;
      }

      registry.set(agent.definition.name, {
        name: agent.definition.name,
        description: agent.definition.description,
        definition: agent.definition,
        postProcess: agent.postProcess,
        enabled: agent.enabled,
      });

      console.log(
        `Agents: loaded "${agent.definition.name}" (${agent.enabled ? "enabled" : "disabled"})`,
      );
    } catch (err) {
      console.error(`Agents: failed to load ${entry}:`, err);
    }
  }

  console.log(
    `Agents: ${registry.size} agent(s) loaded, ${getEnabledAgents().length} enabled`,
  );
}

export function getAllAgents(): RegisteredAgent[] {
  return Array.from(registry.values());
}

export function getEnabledAgents(): RegisteredAgent[] {
  return Array.from(registry.values()).filter((a) => a.enabled);
}

/** Format agents as OpenAI function definitions (identical to tools from API perspective). */
export function getAgentDefinitionsForOpenAI(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return getEnabledAgents().map((a) => ({
    type: "function" as const,
    function: {
      name: a.name,
      description: a.description,
      ...(a.definition.parameters ? { parameters: a.definition.parameters } : {}),
    },
  }));
}

/** Execute an agent by spinning up a sub-completion-loop. */
export async function executeAgent(
  agentName: string,
  args: Record<string, unknown>,
  channelId: string | null,
): Promise<string> {
  const agent = registry.get(agentName);
  if (!agent) return `Error: unknown agent "${agentName}"`;
  if (!agent.enabled) return `Error: agent "${agentName}" is currently disabled`;

  try {
    // Lazy import to break circular dependency with llm.ts
    const { runAgentLoop } = await import("./llm.js");

    const rawResult = await runAgentLoop({
      systemPrompt: agent.definition.systemPrompt,
      userPrompt: JSON.stringify(args),
      toolAllowlist: agent.definition.tools,
      maxIterations: agent.definition.maxIterations,
      model: agent.definition.model,
      channelId,
    });

    if (agent.postProcess) {
      return agent.postProcess(rawResult, args);
    }

    return rawResult;
  } catch (err) {
    console.error(`Agents: execution error in "${agentName}":`, err);
    return `Error executing agent "${agentName}": ${String(err)}`;
  }
}

export function toggleAgent(name: string): { found: boolean; enabled: boolean } {
  const agent = registry.get(name);
  if (!agent) return { found: false, enabled: false };
  agent.enabled = !agent.enabled;
  console.log(`Agents: "${name}" is now ${agent.enabled ? "enabled" : "disabled"}`);
  return { found: true, enabled: agent.enabled };
}

/** Check if a function name belongs to an agent (for dispatch routing). */
export function isAgent(name: string): boolean {
  return registry.has(name);
}
