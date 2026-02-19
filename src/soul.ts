import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";

export type SoulFileMeta = {
  order: number;
  enabled: boolean;
  label: string;
  section: string;
};

export type SoulFile = {
  /** Relative path from soul directory, e.g. "skills/creative-writing.md" */
  path: string;
  meta: SoulFileMeta;
  /** Markdown content below frontmatter, before template substitution */
  rawContent: string;
};

export type SoulState = {
  files: SoulFile[];
  composedPrompt: string;
  loadedAt: Date;
};

export type SoulVariables = {
  botName: string;
  [key: string]: string;
};

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { meta: {}, content: raw };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { meta: {}, content: raw };
  }

  const yamlBlock = trimmed.slice(3, endIndex);
  const content = trimmed.slice(endIndex + 3).trimStart();

  let meta: Record<string, unknown> = {};
  try {
    meta = parseYaml(yamlBlock) ?? {};
  } catch {
    console.warn("Soul: failed to parse frontmatter, using defaults");
  }

  return { meta, content };
}

function discoverFiles(dir: string, basePath = ""): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = basePath ? `${basePath}/${entry}` : entry;

    if (statSync(fullPath).isDirectory()) {
      results.push(...discoverFiles(fullPath, relPath));
    } else if (extname(entry) === ".md") {
      results.push(relPath);
    }
  }

  return results;
}

function substituteVariables(content: string, variables: SoulVariables): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
}

export function loadSoul(soulDir: string, variables: SoulVariables): SoulState {
  const filePaths = discoverFiles(soulDir);
  const files: SoulFile[] = [];

  for (const relPath of filePaths) {
    const fullPath = join(soulDir, relPath);
    const raw = readFileSync(fullPath, "utf-8");
    const { meta, content } = parseFrontmatter(raw);

    files.push({
      path: relPath,
      meta: {
        order: (meta.order as number) ?? 100,
        enabled: (meta.enabled as boolean) ?? true,
        label: (meta.label as string) ?? relPath,
        section: (meta.section as string) ?? "identity",
      },
      rawContent: content,
    });
  }

  // Sort by order, then alphabetically for stable ordering within same order
  files.sort((a, b) => {
    if (a.meta.order !== b.meta.order) return a.meta.order - b.meta.order;
    return a.path.localeCompare(b.path);
  });

  const composedPrompt = files
    .filter((f) => f.meta.enabled)
    .map((f) => substituteVariables(f.rawContent, variables))
    .join("\n\n");

  const enabled = files.filter((f) => f.meta.enabled).length;
  console.log(
    `Soul: loaded ${files.length} files (${enabled} enabled), prompt: ${composedPrompt.length} chars`,
  );

  return { files, composedPrompt, loadedAt: new Date() };
}
