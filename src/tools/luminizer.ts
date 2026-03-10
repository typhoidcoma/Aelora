import { defineTool, param, getToolConfigValue } from "./types.js";

// ============================================================
// Helpers
// ============================================================

function getConfig() {
  const apiKey =
    (getToolConfigValue("luminizer.apiKey") as string) ||
    process.env.AELORA_LLM_API_KEY ||
    "";
  const model =
    (getToolConfigValue("luminizer.model") as string) || "dall-e-3";
  const baseURL =
    (getToolConfigValue("luminizer.baseURL") as string) ||
    "https://api.openai.com/v1";
  const stylePrompt =
    (getToolConfigValue("luminizer.stylePrompt") as string) || "";

  return { apiKey, model, baseURL, stylePrompt };
}

function buildPrompt(userPrompt: string, stylePrompt: string): string {
  if (!stylePrompt) return userPrompt;
  return (
    `MANDATORY STYLE (apply to ALL images regardless of other instructions):\n${stylePrompt}\n\n` +
    `Subject/scene request:\n${userPrompt}`
  );
}

// ============================================================
// Generate (text -> image via /images/generations)
// ============================================================

async function generate(
  prompt: string,
  size: string,
  quality: string,
  cfg: ReturnType<typeof getConfig>,
) {
  const res = await fetch(
    `${cfg.baseURL.replace(/\/+$/, "")}/images/generations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        prompt,
        n: 1,
        size,
        quality,
        response_format: "url",
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Image generation failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return (await res.json()) as {
    data: { url: string; revised_prompt?: string }[];
  };
}

// ============================================================
// Tool definition
// ============================================================

export default defineTool({
  name: "luminizer",
  description:
    "Generate images from text descriptions. " +
    "When the user provides a reference image, YOU (the LLM) must describe what is in the image " +
    "in detail as part of the prompt so it can be recreated in the configured style. " +
    "Do NOT pass imageUrl - always use text-to-image generation. " +
    "Returns an image URL that Discord will auto-embed.",

  params: {
    prompt: param.string(
      "Detailed description of the image to generate. If recreating a user-provided image, " +
      "describe the scene, subjects, composition, colors, and mood in full detail.",
      { required: true, maxLength: 4000 },
    ),
    size: param.enum("Image dimensions.", [
      "1024x1024",
      "1024x1792",
      "1792x1024",
    ] as const),
    quality: param.enum("Image quality.", ["standard", "hd"] as const),
  },

  config: [],

  handler: async ({ prompt, size, quality }) => {
    const cfg = getConfig();

    if (!cfg.apiKey) {
      return "Error: No API key for image generation. Set luminizer.apiKey in settings.yaml under tools: or ensure AELORA_LLM_API_KEY is an OpenAI key.";
    }

    const finalPrompt = buildPrompt(prompt!, cfg.stylePrompt);
    const finalSize = size || "1024x1024";

    try {
      const data = await generate(finalPrompt, finalSize, quality || "standard", cfg);

      const image = data.data[0];
      if (!image?.url) return "Error: No image returned from the API.";

      return {
        text: `Generated image: ${image.url}${image.revised_prompt ? `\n\nRevised prompt: ${image.revised_prompt}` : ""}`,
        data: {
          url: image.url,
          revisedPrompt: image.revised_prompt,
          model: cfg.model,
          size: finalSize,
        },
      };
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
