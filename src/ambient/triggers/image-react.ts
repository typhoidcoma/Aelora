import type { AmbientTrigger, ContentPart } from "../types.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const imageReactTrigger: AmbientTrigger = {
  name: "image-react",
  description: "Engages with an image someone posted when the conversation moved on without acknowledging it",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.imageReact;
    const minAgeMs = tc.minAgeMinutes * 60 * 1000;
    const maxAgeMs = tc.maxAgeMinutes * 60 * 1000;
    const now = Date.now();
    return buffer.messages.some((m) => {
      if (m.isBot) return false;
      if (!m.hasAttachments) return false;
      if (!m.attachmentTypes.some((t) => IMAGE_TYPES.has(t))) return false;
      if (m.hasReactions) return false;
      const ageMs = now - m.timestamp;
      return ageMs >= minAgeMs && ageMs <= maxAgeMs;
    });
  },

  async evaluate(ctx) {
    const tc = ctx.config.ambient.triggers.imageReact;
    const minAgeMs = tc.minAgeMinutes * 60 * 1000;
    const maxAgeMs = tc.maxAgeMinutes * 60 * 1000;
    const now = Date.now();
    const unreactedImages = ctx.buffer.messages.filter((m) => {
      if (m.isBot) return false;
      if (!m.hasAttachments) return false;
      if (!m.attachmentTypes.some((t) => IMAGE_TYPES.has(t))) return false;
      if (m.hasReactions) return false;
      const ageMs = now - m.timestamp;
      return ageMs >= minAgeMs && ageMs <= maxAgeMs;
    });

    if (unreactedImages.length === 0) {
      return { message: null, debugReason: "no unreacted images on re-check" };
    }

    const target = unreactedImages[unreactedImages.length - 1]; // most recent
    const silentMinutes = Math.round((now - target.timestamp) / 60000);

    // Skip if conversation continued after the image (people saw it)
    const afterImage = ctx.buffer.messages.filter(
      (m) => m.timestamp > target.timestamp && m.authorId !== target.authorId && !m.isBot,
    );
    if (afterImage.length > 2) {
      return { message: null, debugReason: "conversation continued after image, not truly ignored" };
    }

    const surrounding = ctx.buffer.messages
      .slice(-5)
      .map((m) => {
        const prefix = m.isBot ? "[BOT] " : "";
        return `${prefix}${m.authorName}: ${m.content.slice(0, 200)}${m.hasAttachments ? " [posted image]" : ""}`;
      })
      .join("\n");

    const prompt: ContentPart[] = [
      {
        type: "text",
        text: `${target.authorName} shared this image ${silentMinutes} minutes ago.\n\nrecent context:\n${surrounding}\n\n`,
      },
      ...target.imageUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url, detail: "low" as const },
      })),
      {
        type: "text",
        text: `\nif the image is interesting, react to what's actually in it. talk about the content, engage with it genuinely. don't mention that it was ignored or unreacted.\n\nif it's not worth commenting on, respond SKIP.`,
      },
    ];

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `image from ${target.authorName} unreacted for ${silentMinutes}m`,
    };
  },
};
