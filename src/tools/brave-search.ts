import { defineTool, param, getToolConfigValue } from "./types.js";
import { record } from "../api-health.js";

// ============================================================
// Types
// ============================================================

type SearchResult = {
  title: string;
  url: string;
  description: string;
  age?: string | null;
};

type BraveSearchResponse = {
  web?: {
    results: { title: string; url: string; description: string; age?: string }[];
  };
};

type OpenAIResponseItem = {
  type: string;
  content?: { type: string; text?: string; annotations?: OpenAIAnnotation[] }[];
};

type OpenAIAnnotation = {
  type: string;
  url?: string;
  title?: string;
};

type OpenAIResponsesResponse = {
  output: OpenAIResponseItem[];
};

// ============================================================
// Brave backend
// ============================================================

async function searchBrave(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const start = Date.now();

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });
  const duration = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    console.warn(`External: [brave] search failed ${res.status} ${duration}ms`);
    record("brave", false, duration, `${res.status}`);
    throw new Error(`Brave Search API error (${res.status}): ${body.slice(0, 200)}`);
  }

  record("brave", true, duration);
  const data = (await res.json()) as BraveSearchResponse;
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    age: r.age ?? null,
  }));
}

// ============================================================
// OpenAI Responses API backend (web_search_preview)
// ============================================================

async function searchOpenAI(query: string, count: number, apiKey: string, baseURL: string, model: string): Promise<SearchResult[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/responses`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search_preview" }],
      input: query,
      // Keep it focused on search results
      instructions: `Search the web for: ${query}\n\nReturn the top ${count} results with titles, URLs, and brief descriptions. Be factual and concise.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI search error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenAIResponsesResponse;

  // Extract URLs from annotations in the message output
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const item of data.output) {
    if (item.type !== "message" || !item.content) continue;
    for (const part of item.content) {
      if (part.type !== "output_text" || !part.annotations) continue;
      for (const ann of part.annotations) {
        if (ann.type === "url_citation" && ann.url && !seen.has(ann.url)) {
          seen.add(ann.url);
          results.push({
            title: ann.title || ann.url,
            url: ann.url,
            description: "",
            age: null,
          });
        }
      }
    }
  }

  return results.slice(0, count);
}

// ============================================================
// Tool definition
// ============================================================

export default defineTool({
  name: "web_search",
  description:
    "Search the web for current information. Returns titles, URLs, and descriptions. " +
    "Use this to find current news, look up facts, research topics, or answer questions " +
    "that need up-to-date knowledge.",

  params: {
    query: param.string("The search query.", { required: true, maxLength: 400 }),
    count: param.number("Number of results to return (1-10). Default: 5.", {
      minimum: 1,
      maximum: 10,
    }),
  },

  // No hard config requirement - we check at runtime which backend is available
  config: [],

  handler: async ({ query, count }) => {
    const numResults = count ?? 5;
    const provider = (getToolConfigValue("search.provider") as string) || "";

    let results: SearchResult[];

    if (provider === "openai") {
      // OpenAI Responses API with web_search_preview
      const apiKey = (getToolConfigValue("search.apiKey") as string)
        || (getToolConfigValue("search.openaiApiKey") as string)
        || process.env.AELORA_LLM_API_KEY
        || "";
      const baseURL = (getToolConfigValue("search.baseURL") as string)
        || process.env.AELORA_LLM_BASE_URL
        || "https://api.openai.com/v1";
      const model = (getToolConfigValue("search.model") as string) || "gpt-4o-mini";

      if (!apiKey) {
        return "Error: OpenAI search requires an API key. Set search.apiKey in settings.yaml or use AELORA_LLM_API_KEY env var.";
      }

      try {
        results = await searchOpenAI(query!, numResults, apiKey, baseURL, model);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      // Brave Search (default)
      const apiKey = (getToolConfigValue("brave.apiKey") as string) || "";

      if (!apiKey) {
        return "Error: No search provider configured. Set search.provider to \"openai\" with an API key, or set brave.apiKey in settings.yaml.";
      }

      try {
        results = await searchBrave(query!, numResults, apiKey);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (results.length === 0) {
      return { text: `No results found for "${query}".`, data: { action: "search", query, count: 0, results: [] } };
    }

    const lines = results.map((r, i) => {
      const age = r.age ? ` (${r.age})` : "";
      const desc = r.description ? `\n   ${r.description}` : "";
      return `${i + 1}. [**${r.title}**](${r.url})${age}${desc}`;
    });

    return {
      text: `Search results for "${query}":\n\n${lines.join("\n\n")}`,
      data: {
        action: "search",
        query,
        provider: provider || "brave",
        count: results.length,
        results: results.map((r) => ({ title: r.title, url: r.url, description: r.description, age: r.age ?? null })),
      },
    };
  },
});
