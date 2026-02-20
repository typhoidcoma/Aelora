import { defineTool, param } from "./types.js";

const API_URL = "https://api.search.brave.com/res/v1/web/search";

type BraveWebResult = {
  title: string;
  url: string;
  description: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results: BraveWebResult[];
  };
  query?: {
    original: string;
  };
};

export default defineTool({
  name: "web_search",
  description:
    "Search the web using Brave Search. Returns titles, URLs, and descriptions " +
    "for matching results. Use this to find current information, look up facts, " +
    "research topics, or answer questions that need up-to-date knowledge.",

  params: {
    query: param.string("The search query.", { required: true, maxLength: 400 }),
    count: param.number("Number of results to return (1-10). Default: 5.", {
      minimum: 1,
      maximum: 10,
    }),
  },

  config: ["brave.apiKey"],

  handler: async ({ query, count }, { toolConfig }) => {
    const apiKey = toolConfig.apiKey as string;
    const numResults = count ?? 5;

    const url = `${API_URL}?q=${encodeURIComponent(query!)}&count=${numResults}`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      return `Search error (${res.status}): ${body.slice(0, 200)}`;
    }

    const data = (await res.json()) as BraveSearchResponse;
    const results = data.web?.results;

    if (!results || results.length === 0) {
      return `No results found for "${query}".`;
    }

    const lines = results.map((r, i) => {
      const age = r.age ? ` (${r.age})` : "";
      return `${i + 1}. [**${r.title}**](${r.url})${age}\n   ${r.description}`;
    });

    return `Search results for "${query}":\n\n${lines.join("\n\n")}`;
  },
});
