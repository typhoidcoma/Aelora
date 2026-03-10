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
  // Style is wrapped as a mandatory constraint that overrides any conflicting user instructions.
  return (
    `MANDATORY STYLE (apply to ALL images regardless of other instructions):\n${stylePrompt}\n\n` +
    `Subject/scene request:\n${userPrompt}`
  );
}

// ============================================================
// Generate (text -> image)
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
// Edit (image + prompt -> image)
// Uses multipart/form-data for the /images/edits endpoint.
// ============================================================

async function edit(
  imageUrl: string,
  prompt: string,
  size: string,
  cfg: ReturnType<typeof getConfig>,
) {
  // Download the reference image
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download reference image (${imgRes.status})`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const mime = imgRes.headers.get("content-type") || "image/png";

  // Determine extension from mime
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg"
    : mime.includes("webp") ? "webp"
    : "png";

  // Build multipart form
  const form = new FormData();
  form.append("image", new Blob([imgBuf], { type: mime }), `input.${ext}`);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("response_format", "url");

  // gpt-image-1 supports edits; fall back to dall-e-2 if model is dall-e-3
  // (dall-e-3 does not have an edit endpoint)
  const editModel = cfg.model === "dall-e-3" ? "dall-e-2" : cfg.model;
  form.append("model", editModel);

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
    throw new Error(`Image edit failed (${res.status}): ${body.slice(0, 300)}`);
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
    "Generate or edit images. Text-to-image by default. " +
    "If imageUrl is provided, edits/transforms that image using the prompt. " +
    "Returns an image URL that Discord will auto-embed.",

  params: {
    prompt: param.string("Detailed description of the image to generate or how to edit the reference image.", {
      required: true,
      maxLength: 4000,
    }),
    imageUrl: param.string(
      "URL of a reference image to edit/transform. Pass the url from a Discord attachment " +
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
      let data: { data: { url: string; revised_prompt?: string }[] };

      if (imageUrl) {
        // Edit mode: reference image + prompt
        data = await edit(imageUrl as string, finalPrompt, finalSize, cfg);
      } else {
        // Generate mode: text-to-image
        data = await generate(finalPrompt, finalSize, quality || "standard", cfg);
      }

      const image = data.data[0];
      if (!image?.url) return "Error: No image returned from the API.";

      return {
        text: `Generated image: ${image.url}${image.revised_prompt ? `\n\nRevised prompt: ${image.revised_prompt}` : ""}`,
        data: {
          url: image.url,
          revisedPrompt: image.revised_prompt,
          mode: imageUrl ? "edit" : "generate",
          model: cfg.model,
          size: finalSize,
        },
      };
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
