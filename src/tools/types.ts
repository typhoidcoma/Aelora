export type ToolParametersSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters?: ToolParametersSchema;
};

export type ToolContext = {
  channelId: string | null;
  sendToChannel: (channelId: string, text: string) => Promise<void>;
};

export type ToolResult = string;

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

export type Tool = {
  definition: ToolDefinition;
  handler: ToolHandler;
  enabled: boolean;
};
