/**
 * Split text into chunks that fit within Discord's message limit.
 * Breaks at newlines first, then spaces, then hard-cuts.
 * Preserves markdown code block formatting across chunks.
 */
export function chunkMessage(text: string, maxLen = 2000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline within the limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      // Try a space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt <= 0) {
      // Hard cut
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return fixMarkdownContinuity(chunks);
}

/**
 * Fix markdown code fences broken by chunk splits.
 * If a chunk ends inside an unclosed code block, appends a closing ```
 * and prepends an opening ``` (with the original language tag) to the next chunk.
 */
export function fixMarkdownContinuity(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const result = [...chunks];

  for (let i = 0; i < result.length - 1; i++) {
    const lines = result[i].split("\n");
    let inCodeBlock = false;
    let openFence = "```";

    for (const line of lines) {
      const fenceMatch = line.match(/^(```\w*)/);
      if (fenceMatch) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          openFence = fenceMatch[1];
        } else {
          inCodeBlock = false;
        }
      }
    }

    if (inCodeBlock) {
      result[i] += "\n```";
      result[i + 1] = openFence + "\n" + result[i + 1];
    }
  }

  return result;
}
