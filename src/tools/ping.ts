import type { Tool } from "./types.js";

const ping: Tool = {
  definition: {
    name: "ping",
    description:
      "Responds with pong and the current server time. Use this to test if tools are working.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Optional message to echo back.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  handler: async (args) => {
    const echo = args.message ? ` Echo: ${args.message}` : "";
    return `Pong! Server time: ${new Date().toISOString()}${echo}`;
  },

  enabled: true,
};

export default ping;
