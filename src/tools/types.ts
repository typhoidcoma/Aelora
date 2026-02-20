// ============================================================
// Core tool types (unchanged — backward compatible)
// ============================================================

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
  userId: string | null;
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

// ============================================================
// Parameter schema helpers
// ============================================================

/** A parameter definition that carries JSON Schema + metadata for defineTool(). */
export type ParamSchema<T = unknown> = {
  schema: Record<string, unknown>;
  _required: boolean;
  _type?: T;
};

export const param = {
  string(
    description: string,
    options: { required?: boolean; minLength?: number; maxLength?: number; pattern?: string } = {},
  ): ParamSchema<string> {
    const { required = false, ...rest } = options;
    return { schema: { type: "string", description, ...rest }, _required: required };
  },

  number(
    description: string,
    options: { required?: boolean; minimum?: number; maximum?: number } = {},
  ): ParamSchema<number> {
    const { required = false, ...rest } = options;
    return { schema: { type: "number", description, ...rest }, _required: required };
  },

  boolean(
    description: string,
    options: { required?: boolean } = {},
  ): ParamSchema<boolean> {
    const { required = false } = options;
    return { schema: { type: "boolean", description }, _required: required };
  },

  enum<V extends string>(
    description: string,
    values: readonly V[],
    options: { required?: boolean } = {},
  ): ParamSchema<V> {
    return {
      schema: { type: "string", description, enum: [...values] },
      _required: options.required ?? false,
    };
  },

  array(
    description: string,
    options: { required?: boolean; itemType?: "string" | "number" | "boolean"; minItems?: number; maxItems?: number } = {},
  ): ParamSchema<unknown[]> {
    const { required = false, itemType = "string", minItems, maxItems } = options;
    return {
      schema: {
        type: "array",
        description,
        items: { type: itemType },
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
      },
      _required: required,
    };
  },
};

// ============================================================
// Extended context with tool config
// ============================================================

export type ToolContextWithConfig = ToolContext & {
  toolConfig: Record<string, unknown>;
};

// ============================================================
// defineTool() helper
// ============================================================

/** Map ParamSchema record to typed handler args. */
type InferParams<P extends Record<string, ParamSchema>> = {
  [K in keyof P]: P[K] extends ParamSchema<infer T> ? T | undefined : unknown;
};

export type DefineToolOptions<P extends Record<string, ParamSchema>> = {
  name: string;
  description: string;
  params?: P;
  /** Config keys from settings.yaml tools: section (e.g., ["gmail.clientId"]). */
  config?: string[];
  enabled?: boolean;
  handler: (args: InferParams<P>, context: ToolContextWithConfig) => Promise<string>;
};

/**
 * Define a tool with minimal boilerplate.
 *
 * Auto-generates JSON Schema from `params`, validates args before calling
 * handler, resolves tool config from settings.yaml. Returns a standard
 * `Tool` object — fully compatible with the existing tool registry.
 */
export function defineTool<P extends Record<string, ParamSchema>>(
  options: DefineToolOptions<P>,
): Tool {
  const { name, description, params, config: configKeys, enabled = true, handler } = options;

  // Build JSON Schema from params
  let parameters: ToolParametersSchema | undefined;

  if (params && Object.keys(params).length > 0) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, p] of Object.entries(params)) {
      properties[key] = p.schema;
      if (p._required) required.push(key);
    }

    parameters = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }

  return {
    definition: {
      name,
      description,
      ...(parameters ? { parameters } : {}),
    },

    handler: async (args: Record<string, unknown>, context: ToolContext) => {
      // Validate args
      if (params) {
        const errors = validateArgs(args, params);
        if (errors.length > 0) {
          return `Invalid arguments: ${errors.join("; ")}`;
        }
      }

      // Resolve tool config
      const toolConfig = configKeys ? resolveToolConfig(configKeys) : {};

      // Check required config keys are present
      if (configKeys) {
        const missing = configKeys.filter((k) => {
          const leaf = k.split(".").pop()!;
          return toolConfig[leaf] === undefined || toolConfig[leaf] === "";
        });
        if (missing.length > 0) {
          return `Tool "${name}" missing config: ${missing.join(", ")}. Add to settings.yaml under tools:`;
        }
      }

      const extendedContext: ToolContextWithConfig = { ...context, toolConfig };
      return handler(args as InferParams<P>, extendedContext);
    },

    enabled,
  };
}

// ============================================================
// Arg validation
// ============================================================

function validateArgs(
  args: Record<string, unknown>,
  params: Record<string, ParamSchema>,
): string[] {
  const errors: string[] = [];

  for (const [key, p] of Object.entries(params)) {
    const value = args[key];
    const schemaType = p.schema.type as string;

    if (p._required && (value === undefined || value === null)) {
      errors.push(`"${key}" is required`);
      continue;
    }

    if (value === undefined || value === null) continue;

    if (schemaType === "string" && typeof value !== "string") {
      errors.push(`"${key}" must be a string`);
    } else if (schemaType === "number" && typeof value !== "number") {
      errors.push(`"${key}" must be a number`);
    } else if (schemaType === "boolean" && typeof value !== "boolean") {
      errors.push(`"${key}" must be a boolean`);
    } else if (schemaType === "array" && !Array.isArray(value)) {
      errors.push(`"${key}" must be an array`);
    }

    if (p.schema.enum && Array.isArray(p.schema.enum)) {
      if (!(p.schema.enum as unknown[]).includes(value)) {
        errors.push(`"${key}" must be one of: ${(p.schema.enum as string[]).join(", ")}`);
      }
    }
  }

  return errors;
}

// ============================================================
// Tool config store
// ============================================================

let toolConfigStore: Record<string, Record<string, unknown>> = {};

/** Called at startup to inject tool configs from settings.yaml. */
export function setToolConfigStore(store: Record<string, Record<string, unknown>>): void {
  toolConfigStore = store;
}

/** Resolve dotted config keys into a flat object for the handler. */
function resolveToolConfig(keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of keys) {
    const parts = key.split(".");
    let current: unknown = toolConfigStore;
    for (const part of parts) {
      if (current && typeof current === "object") {
        current = (current as Record<string, unknown>)[part];
      } else {
        current = undefined;
        break;
      }
    }
    result[parts[parts.length - 1]] = current;
  }

  return result;
}
