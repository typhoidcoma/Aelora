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
// Restyle (image + prompt -> image via gpt-image-1 /images/edits)
// ============================================================

async function restyle(
  imageUrl: string,
  prompt: string,
  size: string,
  cfg: ReturnType<typeof getConfig>,
) {
  // Download the reference image
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download reference image (${imgRes.status})`);
  const imgBuf = new Uint8Array(await imgRes.arrayBuffer());

  // Build multipart form — gpt-image-1 accepts PNG/JPEG/WebP directly
  const form = new FormData();
  const mime = imgRes.headers.get("content-type") || "image/png";
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg"
    : mime.includes("webp") ? "webp" : "png";
  form.append("image", new Blob([imgBuf], { type: mime }), `input.${ext}`);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("model", "gpt-image-1");

  const res = await fetch(
    `${cfg.baseURL.replace(/\/+$/, "")}/images/edits`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Image restyle failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    data: { url?: string; b64_json?: string; revised_prompt?: string }[];
  };

  // gpt-image-1 may return b64_json instead of url
  const image = data.data[0];
  if (image?.url) return image;
  if (image?.b64_json) {
    return { url: `data:image/png;base64,${image.b64_json}`, revised_prompt: image.revised_prompt };
  }
  throw new Error("No image returned from the API.");
}

// ============================================================
// Tool definition
// ============================================================

export default defineTool({
  name: "luminizer",
  description:
    "Generate or restyle images. Text-to-image by default. " +
    "If imageUrl is provided, restyles that image using gpt-image-1 while preserving " +
    "the pose, face, and composition. Returns an image URL that Discord will auto-embed.",

  params: {
    prompt: param.string(
      "Detailed description of the desired result. For restyling, describe what style/changes to apply.",
      { required: true, maxLength: 4000 },
    ),
    imageUrl: param.string(
      "URL of a reference image to restyle. Pass the url from a Discord attachment " +
      "when the user provides an image. Omit for text-to-image generation.",
    ),
    size: param.enum("Image dimensions.", [
      "1024x1024",
      "1024x1792",
      "1792x1024",
    ] as const),
    quality: param.enum("Image quality (generation only).", ["standard", "hd"] as const),
  },

  config: [],

  handler: async ({ prompt, imageUrl, size, quality }) => {
    const cfg = getConfig();

    if (!cfg.apiKey) {
      return "Error: No API key for image generation. Set luminizer.apiKey in settings.yaml under tools: or ensure AELORA_LLM_API_KEY is an OpenAI key.";
    }

    const finalPrompt = buildPrompt(prompt!, cfg.stylePrompt);
    const finalSize = size || "1024x1024";

    try {
      let url: string;
      let revisedPrompt: string | undefined;
      let mode: string;

      if (imageUrl) {
        // Restyle mode: send image + prompt to gpt-image-1
        const result = await restyle(imageUrl as string, finalPrompt, finalSize, cfg);
        url = result.url!;
        revisedPrompt = result.revised_prompt;
        mode = "restyle";
      } else {
        // Generate mode: text-to-image
        const data = await generate(finalPrompt, finalSize, quality || "standard", cfg);
        const image = data.data[0];
        if (!image?.url) return "Error: No image returned from the API.";
        url = image.url;
        revisedPrompt = image.revised_prompt;
        mode = "generate";
      }

      return {
        text: `Generated image: ${url}${revisedPrompt ? `\n\nRevised prompt: ${revisedPrompt}` : ""}`,
        data: { url, revisedPrompt, mode, model: imageUrl ? "gpt-image-1" : cfg.model, size: finalSize },
      };
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
