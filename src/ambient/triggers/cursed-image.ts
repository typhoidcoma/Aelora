import type { AmbientTrigger } from "../types.js";
import { getRecentMessages } from "../buffer.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const cursedImageTrigger: AmbientTrigger = {
  name: "cursed-image",
  description: "Breaks the silence when someone posts an image and nobody reacts",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.cursedImage;
    const minAgeMs = tc.minAgeMinutes * 60 * 1000;
    const maxAgeMs = tc.maxAgeMinutes * 60 * 1000;
    const now = Date.now();
    return buffer.messages.some((m) => {
      if (!m.hasAttachments) return false;
      if (!m.attachmentTypes.some((t) => IMAGE_TYPES.has(t))) return false;
      if (m.hasReactions) return false;
      const ageMs = now - m.timestamp;
      return ageMs >= minAgeMs && ageMs <= maxAgeMs;
    });
  },

  async evaluate(ctx) {
    const tc = ctx.config.ambient.triggers.cursedImage;
    const minAgeMs = tc.minAgeMinutes * 60 * 1000;
    const maxAgeMs = tc.maxAgeMinutes * 60 * 1000;
    const now = Date.now();
    const unreactedImages = ctx.buffer.messages.filter((m) => {
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

    // check if anyone replied after the image (even without reactions)
    const afterImage = ctx.buffer.messages.filter((m) => m.timestamp > target.timestamp && m.authorId !== target.authorId);
    if (afterImage.length > 2) {
      // conversation moved on, people saw it
      return { message: null, debugReason: "conversation continued after image, not truly ignored" };
    }

    const surrounding = ctx.buffer.messages.slice(-8).map(
      (m) => `${m.authorName}: ${m.content.slice(0, 200)}${m.hasAttachments ? " [posted image]" : ""}`,
    ).join("\n");

    const prompt = `${target.authorName} posted an image ${silentMinutes} minutes ago and nobody said anything about it.

surrounding context:
${surrounding}

you can't see the image. react to the fact that it got completely ignored. examples:
- "not a single person acknowledged that image lmao"
- "the way nobody said anything about that. iconic"
- "that image just sitting there with zero reactions is sending me"

if it's not worth commenting on, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `image from ${target.authorName} unreacted for ${silentMinutes}m`,
    };
  },
};
