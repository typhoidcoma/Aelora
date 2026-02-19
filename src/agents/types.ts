import type { ToolParametersSchema } from "../tools/types.js";

export type AgentResult = string;

export type AgentDefinition = {
  /** Unique name — used as the function name in OpenAI tool calls. */
  name: string;

  /** Tells the main agent when to invoke this agent. */
  description: string;

  /** JSON Schema for the agent's input parameters. */
  parameters?: ToolParametersSchema;

  /** System prompt for this agent's own LLM completion loop. */
  systemPrompt: string;

  /**
   * Which tools this agent can use during its loop.
   * - undefined / empty → no tools (pure reasoning)
   * - ["*"] → all enabled tools
   * - ["tool_a", "tool_b"] → specific allowlist
   */
  tools?: string[];

  /** Max LLM iterations for this agent. Falls back to config default. */
  maxIterations?: number;

  /** Model override. If omitted, uses the main agent's model. */
  model?: string;
};

export type Agent = {
  definition: AgentDefinition;

  /**
   * Optional post-processing hook. Runs after the agent's LLM loop
   * completes. Use to parse, validate, or restructure the raw output
   * before returning to the main agent.
   */
  postProcess?: (rawOutput: string, args: Record<string, unknown>) => AgentResult;

  enabled: boolean;
};
