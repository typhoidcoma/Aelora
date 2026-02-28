import { defineTool, param } from "./types.js";

export default defineTool({
  name: "ping",
  description:
    "Responds with pong and the current server time. Use this to test if tools are working.",

  params: {
    message: param.string("Optional message to echo back."),
  },

  handler: async ({ message }) => {
    const now = new Date().toISOString();
    const echo = message ? ` Echo: ${message}` : "";
    return {
      text: `Pong! Server time: ${now}${echo}`,
      data: { serverTime: now, echo: message ?? null },
    };
  },
});
