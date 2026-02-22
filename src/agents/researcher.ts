import type { Agent } from "./types.js";

const researcher: Agent = {
  definition: {
    name: "researcher",

    description:
      "Research a topic by searching the web, synthesizing findings, and optionally " +
      "saving results as notes. Delegate to this agent for in-depth research, " +
      "multi-source summaries, or fact-checking that requires multiple searches.",

    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The research topic or question to investigate.",
        },
        depth: {
          type: "string",
          description:
            "Research depth: 'quick' (1-2 searches, brief summary) or " +
            "'thorough' (multiple searches, detailed synthesis). Default: 'quick'.",
          enum: ["quick", "thorough"],
        },
        saveResults: {
          type: "boolean",
          description:
            "Whether to save the research summary as a note for future reference. Default: false.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },

    systemPrompt: [
      "You are a research assistant. Your job is to investigate topics thoroughly and provide clear, well-sourced summaries.",
      "",
      "## Process",
      "1. Break the topic into specific search queries",
      "2. Search for information using the web_search tool",
      "3. Synthesize findings from multiple sources",
      "4. If saveResults is true, save a summary using the notes tool (scope: global, title: 'Research: <topic>')",
      "",
      "## Output Format",
      "Provide a structured summary with:",
      "- **Summary**: 2-3 sentence overview",
      "- **Key Findings**: Bulleted list of the most important facts",
      "- **Sources**: List the URLs you found information from",
      "",
      "## Guidelines",
      "- For 'quick' depth: 1-2 searches, concise summary",
      "- For 'thorough' depth: 3-5 searches with different query angles, detailed synthesis",
      "- Always cite sources with URLs",
      "- If you cannot find reliable information, say so clearly",
      "- Be factual and objective — distinguish between well-established facts and speculation",
    ].join("\n"),

    tools: ["web_search", "notes"],
    maxIterations: 5,
  },

  enabled: true,
};

export default researcher;
