import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { googleFetch, type GoogleConfig } from "./tools/_google-auth.js";
import * as vectorStore from "./vector-store.js";
import { formatError } from "./vector-store.js";

// ── Types ────────────────────────────────────────────────

export interface KnowledgeConfig {
  enabled: boolean;
  driveFolderId: string;
  syncIntervalMinutes: number;
  chunkSize: number;
  chunkOverlap: number;
  maxChunksPerPrompt: number;
  minRelevanceScore: number;
}

interface ManifestEntry {
  name: string;
  mimeType: string;
  modifiedTime: string;
  chunkCount: number;
  indexedAt: string;
  charCount: number;
}

interface KBManifest {
  lastSyncAt: string;
  files: Record<string, ManifestEntry>;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  description?: string;
}

export interface KBSearchResult {
  fileName: string;
  chunk: string;
  score: number;
}

// ── State ────────────────────────────────────────────────

const MANIFEST_PATH = path.join("data", "kb-manifest.json");
const DRIVE_BASE = "https://www.googleapis.com/drive/v3/files";

let kbConfig: KnowledgeConfig | null = null;
let googleConfig: GoogleConfig | null = null;
let manifest: KBManifest = { lastSyncAt: "", files: {} };

// ── Manifest persistence ─────────────────────────────────

function loadManifest(): void {
  try {
    if (existsSync(MANIFEST_PATH)) {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    }
  } catch {
    manifest = { lastSyncAt: "", files: {} };
  }
}

function saveManifest(): void {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── Initialisation ───────────────────────────────────────

export function configureKnowledgeBase(cfg: KnowledgeConfig, gCfg: GoogleConfig): void {
  kbConfig = cfg;
  googleConfig = gCfg;
  loadManifest();

  if (cfg.enabled && cfg.driveFolderId) {
    console.log(`KnowledgeBase: enabled (folder=${cfg.driveFolderId}, sync every ${cfg.syncIntervalMinutes}m)`);
  } else if (cfg.enabled) {
    console.log("KnowledgeBase: enabled but no driveFolderId configured, sync disabled");
  }
}

// ── Drive API helpers ────────────────────────────────────

async function listDriveFiles(): Promise<DriveFile[]> {
  if (!googleConfig || !kbConfig?.driveFolderId) return [];

  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${kbConfig.driveFolderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,description)",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await googleFetch(`${DRIVE_BASE}?${params}`, googleConfig);
    if (!res.ok) {
      const body = await res.text();
      console.warn(`KnowledgeBase: Drive list failed (${res.status}): ${body.slice(0, 200)}`);
      return files;
    }

    const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    if (data.files) files.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

async function exportGoogleDoc(fileId: string): Promise<string | null> {
  if (!googleConfig) return null;

  const params = new URLSearchParams({ mimeType: "text/plain" });
  const res = await googleFetch(
    `${DRIVE_BASE}/${fileId}/export?${params}`,
    googleConfig,
  );
  if (!res.ok) {
    console.warn(`KnowledgeBase: export doc ${fileId} failed (${res.status})`);
    return null;
  }
  return res.text();
}

async function downloadFileText(fileId: string): Promise<string | null> {
  if (!googleConfig) return null;

  const res = await googleFetch(
    `${DRIVE_BASE}/${fileId}?alt=media`,
    googleConfig,
  );
  if (!res.ok) {
    console.warn(`KnowledgeBase: download ${fileId} failed (${res.status})`);
    return null;
  }
  return res.text();
}

async function downloadFileBinary(fileId: string): Promise<Buffer | null> {
  if (!googleConfig) return null;

  const res = await googleFetch(
    `${DRIVE_BASE}/${fileId}?alt=media`,
    googleConfig,
  );
  if (!res.ok) {
    console.warn(`KnowledgeBase: download binary ${fileId} failed (${res.status})`);
    return null;
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ── Text extraction ──────────────────────────────────────

async function extractText(file: DriveFile): Promise<string | null> {
  const { id, mimeType, description } = file;

  // Google Docs — export as plain text
  if (mimeType === "application/vnd.google-apps.document") {
    return exportGoogleDoc(id);
  }

  // PDF — download and parse
  if (mimeType === "application/pdf") {
    const buf = await downloadFileBinary(id);
    if (!buf) return null;
    try {
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const result = await parser.getText();
      await parser.destroy();
      return result.text || null;
    } catch (err) {
      console.warn(`KnowledgeBase: PDF parse failed for ${file.name}: ${formatError(err)}`);
      return null;
    }
  }

  // Plain text types — download directly
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return downloadFileText(id);
  }

  // Google Sheets — export as CSV
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    if (!googleConfig) return null;
    const params = new URLSearchParams({ mimeType: "text/csv" });
    const res = await googleFetch(
      `${DRIVE_BASE}/${id}/export?${params}`,
      googleConfig,
    );
    if (!res.ok) return null;
    return res.text();
  }

  // Images — use Drive description metadata
  if (mimeType.startsWith("image/")) {
    if (description && description.trim()) {
      return `[Image: ${file.name}]\n${description}`;
    }
    console.log(`KnowledgeBase: skipping image ${file.name} (no description)`);
    return null;
  }

  console.log(`KnowledgeBase: unsupported type ${mimeType} for ${file.name}, skipping`);
  return null;
}

// ── Chunking ─────────────────────────────────────────────

interface Chunk {
  text: string;
  index: number;
}

function chunkText(
  text: string,
  fileName: string,
  chunkSize: number,
  chunkOverlap: number,
): Chunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  // Split on paragraph boundaries
  const paragraphs = cleaned.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let current = "";
  let chunkIndex = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // If adding this paragraph exceeds chunk size, flush current
    if (current && (current.length + trimmed.length + 2) > chunkSize) {
      chunks.push({
        text: `[${fileName}]\n${current}`,
        index: chunkIndex++,
      });

      // Keep overlap from end of current chunk
      if (chunkOverlap > 0 && current.length > chunkOverlap) {
        current = current.slice(-chunkOverlap) + "\n\n" + trimmed;
      } else {
        current = trimmed;
      }
    } else {
      current = current ? current + "\n\n" + trimmed : trimmed;
    }

    // If a single paragraph exceeds chunk size, split on sentences
    if (current.length > chunkSize) {
      const sentences = current.split(/(?<=\.)\s+/);
      current = "";
      for (const sentence of sentences) {
        if (current && (current.length + sentence.length + 1) > chunkSize) {
          chunks.push({
            text: `[${fileName}]\n${current}`,
            index: chunkIndex++,
          });
          current = chunkOverlap > 0 && current.length > chunkOverlap
            ? current.slice(-chunkOverlap) + " " + sentence
            : sentence;
        } else {
          current = current ? current + " " + sentence : sentence;
        }
      }
    }
  }

  // Flush remaining
  if (current.trim()) {
    chunks.push({
      text: `[${fileName}]\n${current}`,
      index: chunkIndex,
    });
  }

  return chunks;
}

// ── Sync pipeline ────────────────────────────────────────

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  chunksIndexed: number;
  errors: number;
}

export async function syncKnowledgeBase(): Promise<SyncResult | null> {
  if (!kbConfig?.enabled || !kbConfig.driveFolderId || !googleConfig) return null;
  if (!vectorStore.isReady()) {
    console.log("KnowledgeBase: vector store not ready, skipping sync");
    return null;
  }

  const result: SyncResult = { added: 0, updated: 0, removed: 0, chunksIndexed: 0, errors: 0 };

  try {
    const driveFiles = await listDriveFiles();
    const driveFileIds = new Set(driveFiles.map((f) => f.id));

    // Detect deleted files
    for (const [fileId, entry] of Object.entries(manifest.files)) {
      if (!driveFileIds.has(fileId)) {
        const removed = await vectorStore.removeItemsByFilter({ source: { $eq: `drive:${fileId}` } });
        console.log(`KnowledgeBase: removed ${entry.name} (${removed} chunks)`);
        delete manifest.files[fileId];
        result.removed++;
      }
    }

    // Process new and updated files
    for (const file of driveFiles) {
      const existing = manifest.files[file.id];
      const isNew = !existing;
      const isUpdated = existing && existing.modifiedTime !== file.modifiedTime;

      if (!isNew && !isUpdated) continue;

      try {
        const text = await extractText(file);
        if (!text) continue;

        // Remove old chunks if updating
        if (isUpdated) {
          await vectorStore.removeItemsByFilter({ source: { $eq: `drive:${file.id}` } });
        }

        // Chunk and index
        const chunks = chunkText(text, file.name, kbConfig.chunkSize, kbConfig.chunkOverlap);
        for (const chunk of chunks) {
          await vectorStore.indexFact("kb", chunk.text, file.modifiedTime, {
            category: "knowledge",
            confidence: "stated",
            source: `drive:${file.id}`,
          });
          result.chunksIndexed++;
        }

        // Update manifest
        manifest.files[file.id] = {
          name: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          chunkCount: chunks.length,
          indexedAt: new Date().toISOString(),
          charCount: text.length,
        };

        if (isNew) {
          result.added++;
          console.log(`KnowledgeBase: indexed ${file.name} (${chunks.length} chunks, ${text.length} chars)`);
        } else {
          result.updated++;
          console.log(`KnowledgeBase: re-indexed ${file.name} (${chunks.length} chunks)`);
        }
      } catch (err) {
        console.warn(`KnowledgeBase: failed to process ${file.name}: ${formatError(err)}`);
        result.errors++;
      }
    }

    manifest.lastSyncAt = new Date().toISOString();
    saveManifest();
  } catch (err) {
    console.warn(`KnowledgeBase: sync failed: ${formatError(err)}`);
    result.errors++;
  }

  return result;
}

// ── Search ───────────────────────────────────────────────

export async function searchKnowledgeBase(
  query: string,
  opts?: { topK?: number; minScore?: number },
): Promise<KBSearchResult[]> {
  if (!kbConfig?.enabled) return [];

  const topK = opts?.topK ?? kbConfig.maxChunksPerPrompt;
  const minScore = opts?.minScore ?? kbConfig.minRelevanceScore;

  const results = await vectorStore.semanticSearch(query, {
    scopes: ["kb"],
    topK,
    minScore,
  });

  return results.map((r) => {
    // Extract file name from chunk header "[FileName]\n..."
    const headerMatch = r.fact.match(/^\[(.+?)\]\n/);
    const fileName = headerMatch ? headerMatch[1] : "Unknown";
    const chunk = headerMatch ? r.fact.slice(headerMatch[0].length) : r.fact;

    return { fileName, chunk, score: r.score };
  });
}

// ── Stats ────────────────────────────────────────────────

export function getKnowledgeBaseStats(): {
  enabled: boolean;
  fileCount: number;
  totalChunks: number;
  lastSyncAt: string;
  files: { name: string; chunkCount: number; charCount: number }[];
} {
  return {
    enabled: kbConfig?.enabled ?? false,
    fileCount: Object.keys(manifest.files).length,
    totalChunks: Object.values(manifest.files).reduce((sum, f) => sum + f.chunkCount, 0),
    lastSyncAt: manifest.lastSyncAt,
    files: Object.values(manifest.files).map((f) => ({
      name: f.name,
      chunkCount: f.chunkCount,
      charCount: f.charCount,
    })),
  };
}
