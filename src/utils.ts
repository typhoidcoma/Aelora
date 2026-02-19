/**
 * Split text into chunks that fit within Discord's message limit.
 * Breaks at newlines first, then spaces, then hard-cuts.
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

  return chunks;
}
