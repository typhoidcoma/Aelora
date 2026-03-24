export type BufferedMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
  hasAttachments: boolean;
  attachmentTypes: string[];
  imageUrls: string[];
  hasReactions: boolean;
  reactionCount: number;
};

export type ChannelBuffer = {
  channelId: string;
  channelName: string;
  messages: BufferedMessage[];
  lastAmbientSendAt: number;
};

const buffers = new Map<string, ChannelBuffer>();
let maxBufferSize = 100;

export function configureBuffer(opts: { bufferSize: number }): void {
  maxBufferSize = opts.bufferSize;
}

/** Called from client.ts on every MessageCreate in allowed channels. */
export function ingestMessage(msg: {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  content: string;
  hasAttachments: boolean;
  attachmentTypes: string[];
  imageUrls: string[];
}): void {
  let buf = buffers.get(msg.channelId);
  if (!buf) {
    buf = {
      channelId: msg.channelId,
      channelName: msg.channelName,
      messages: [],
      lastAmbientSendAt: 0,
    };
    buffers.set(msg.channelId, buf);
  }

  buf.channelName = msg.channelName; // keep fresh

  buf.messages.push({
    id: msg.id,
    channelId: msg.channelId,
    authorId: msg.authorId,
    authorName: msg.authorName,
    content: msg.content,
    timestamp: Date.now(),
    hasAttachments: msg.hasAttachments,
    attachmentTypes: msg.attachmentTypes,
    imageUrls: msg.imageUrls,
    hasReactions: false,
    reactionCount: 0,
  });

  // keep sorted by timestamp (messages usually arrive in order, but just in case)
  buf.messages.sort((a, b) => a.timestamp - b.timestamp);

  // trim to max size
  if (buf.messages.length > maxBufferSize) {
    buf.messages = buf.messages.slice(-maxBufferSize);
  }
}

/** Mark a message as having reactions (called from reaction handler). */
export function markReaction(messageId: string, channelId: string): void {
  const buf = buffers.get(channelId);
  if (!buf) return;
  const msg = buf.messages.find((m) => m.id === messageId);
  if (msg) {
    msg.hasReactions = true;
    msg.reactionCount++;
  }
}

export function getBuffer(channelId: string): ChannelBuffer | undefined {
  return buffers.get(channelId);
}

export function getAllBuffers(): ChannelBuffer[] {
  return [...buffers.values()];
}

export function getRecentMessages(channelId: string, windowMs: number): BufferedMessage[] {
  const buf = buffers.get(channelId);
  if (!buf) return [];
  const cutoff = Date.now() - windowMs;
  return buf.messages.filter((m) => m.timestamp >= cutoff);
}

/** Format buffer messages as conversation text for LLM consumption. */
export function formatBufferForLLM(channelId: string, limit?: number): string {
  const buf = buffers.get(channelId);
  if (!buf) return "";
  const msgs = limit ? buf.messages.slice(-limit) : buf.messages;
  return msgs
    .map((m) => {
      let line = `${m.authorName}: ${m.content}`;
      if (m.hasAttachments) {
        const types = m.attachmentTypes.join(", ");
        line += ` [attached: ${types}]`;
      }
      return line;
    })
    .join("\n");
}

/** Record that an ambient message was sent to a channel. */
export function recordAmbientSend(channelId: string): void {
  const buf = buffers.get(channelId);
  if (buf) buf.lastAmbientSendAt = Date.now();
}

/** Get buffer stats for dashboard. */
export function getBufferStats(): Array<{
  channelId: string;
  channelName: string;
  messageCount: number;
  oldestMessage: number | null;
  newestMessage: number | null;
  lastAmbientSendAt: number;
}> {
  return [...buffers.values()].map((buf) => ({
    channelId: buf.channelId,
    channelName: buf.channelName,
    messageCount: buf.messages.length,
    oldestMessage: buf.messages[0]?.timestamp ?? null,
    newestMessage: buf.messages[buf.messages.length - 1]?.timestamp ?? null,
    lastAmbientSendAt: buf.lastAmbientSendAt,
  }));
}
