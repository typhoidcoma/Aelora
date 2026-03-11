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

  const data = (await res.json()) as {
    data: { url: string; revised_prompt?: string }[];
  };
  const image = data.data[0];
  if (!image?.url) throw new Error("No image returned from the API.");
  return { url: image.url, revised_prompt: image.revised_prompt };
}

// ============================================================
// Restyle (image + prompt -> image via gpt-image-1 /images/edits)
// Returns raw b64 PNG since gpt-image-1 doesn't support response_format=url.
// ============================================================

async function restyle(
  imageUrl: string,
  prompt: string,
  size: string,
  cfg: ReturnType<typeof getConfig>,
): Promise<{ b64: string; revised_prompt?: string }> {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download reference image (${imgRes.status})`);
  const imgBuf = new Uint8Array(await imgRes.arrayBuffer());

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
    data: { b64_json?: string; url?: string; revised_prompt?: string }[];
  };

  const image = data.data[0];
  if (image?.b64_json) return { b64: image.b64_json, revised_prompt: image.revised_prompt };
  if (image?.url) {
    // Unlikely but handle gracefully: download the URL to get raw data
    const dl = await fetch(image.url);
    const buf = Buffer.from(await dl.arrayBuffer());
    return { b64: buf.toString("base64"), revised_prompt: image.revised_prompt };
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
    "the pose, face, and composition. The result is sent directly as a Discord attachment.",

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

  handler: async ({ prompt, imageUrl, size, quality }, context) => {
    const cfg = getConfig();

    if (!cfg.apiKey) {
      return "Error: No API key for image generation. Set luminizer.apiKey in settings.yaml under tools: or ensure AELORA_LLM_API_KEY is an OpenAI key.";
    }

    console.log(`Luminizer: stylePrompt=${cfg.stylePrompt ? cfg.stylePrompt.slice(0, 80) + "..." : "(empty)"}`);
    const finalPrompt = buildPrompt(prompt!, cfg.stylePrompt);
    console.log(`Luminizer: finalPrompt=${finalPrompt.slice(0, 200)}...`);
    const finalSize = "1792x1024";

    try {
      if (imageUrl) {
        // Restyle mode: get b64 from gpt-image-1 and send as Discord attachment
        const result = await restyle(imageUrl as string, finalPrompt, finalSize, cfg);
        const buf = Buffer.from(result.b64, "base64");

        if (context.channelId) {
          await context.sendFileToChannel(context.channelId, buf, "luminizer.png");
        }

        return {
          text: "Image restyled and sent as attachment.",
          data: { mode: "restyle", model: "gpt-image-1", size: finalSize },
        };
      } else {
        // Generate mode: dall-e-3 returns a URL — download and send as attachment
        const result = await generate(finalPrompt, finalSize, quality || "standard", cfg);

        if (context.channelId) {
          try {
            const dl = await fetch(result.url);
            if (dl.ok) {
              const buf = Buffer.from(await dl.arrayBuffer());
              await context.sendFileToChannel(context.channelId, buf, "luminizer.png");
            }
          } catch (err) {
            console.warn("Luminizer: failed to download generated image for attachment:", err);
          }
        }

        return {
          text: `Image generated and sent as attachment.${result.revised_prompt ? ` Revised prompt: ${result.revised_prompt}` : ""}`,
          data: { mode: "generate", model: cfg.model, size: finalSize },
        };
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
