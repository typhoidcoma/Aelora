import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join, extname, isAbsolute, dirname } from "node:path";
import { parse as parseYaml } from "yaml";

// --- Types ---

export type PersonaFileMeta = {
  order: number;
  enabled: boolean;
  label: string;
  section: string;
  description: string;
  botName: string;
};

export type PersonaFile = {
  /** Relative path from persona directory, e.g. "skills/creative-writing.md" */
  path: string;
  meta: PersonaFileMeta;
  /** Markdown content below frontmatter, before template substitution */
  rawContent: string;
};

export type PersonaState = {
  files: PersonaFile[];
  composedPrompt: string;
  activePersona: string;
  botName: string;
  loadedAt: Date;
};

export type PersonaVariables = {
  botName: string;
  [key: string]: string;
};

// --- Frontmatter ---

export function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
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
    console.warn("Persona: failed to parse frontmatter, using defaults");
  }

  return { meta, content };
}

export function buildFrontmatter(meta: Partial<PersonaFileMeta>): string {
  const lines: string[] = ["---"];
  if (meta.order !== undefined) lines.push(`order: ${meta.order}`);
  if (meta.enabled !== undefined) lines.push(`enabled: ${meta.enabled}`);
  if (meta.label) lines.push(`label: "${meta.label}"`);
  if (meta.section) lines.push(`section: ${meta.section}`);
  if (meta.description) lines.push(`description: "${meta.description}"`);
  if (meta.botName) lines.push(`botName: "${meta.botName}"`);
  lines.push("---");
  return lines.join("\n");
}

function extractMeta(meta: Record<string, unknown>): PersonaFileMeta {
  return {
    order: (meta.order as number) ?? 100,
    enabled: (meta.enabled as boolean) ?? true,
    label: (meta.label as string) ?? "",
    section: (meta.section as string) ?? "identity",
    description: (meta.description as string) ?? "",
    botName: (meta.botName as string) ?? "",
  };
}

// --- Path helpers ---

function sanitizePath(relPath: string): string | null {
  if (!relPath || relPath.includes("..") || isAbsolute(relPath) || relPath.includes("\\")) {
    return null;
  }
  return relPath;
}

export function discoverFiles(dir: string, basePath = ""): string[] {
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

// --- Variable substitution ---

function substituteVariables(content: string, variables: PersonaVariables): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
}

// --- Persona discovery ---

export function discoverPersonas(personaDir: string): string[] {
  if (!existsSync(personaDir)) return [];

  return readdirSync(personaDir).filter((entry) =>
    statSync(join(personaDir, entry)).isDirectory(),
  );
}

export function getPersonaDescriptions(personaDir: string): Array<{
  name: string;
  description: string;
  fileCount: number;
  botName: string;
}> {
  const personas = discoverPersonas(personaDir);
  return personas.map((name) => {
    const pDir = join(personaDir, name);
    const soulMdPath = join(pDir, "soul.md");
    const personaMdPath = join(pDir, "persona.md");
    let description = "";
    let botName = "";
    if (existsSync(soulMdPath)) {
      const { meta } = parseFrontmatter(readFileSync(soulMdPath, "utf-8"));
      description = (meta.description as string) ?? "";
      botName = (meta.botName as string) ?? "";
    }
    // Fallback: legacy persona.md for older persona formats
    if (!botName && existsSync(personaMdPath)) {
      const { meta } = parseFrontmatter(readFileSync(personaMdPath, "utf-8"));
      if (!description) description = (meta.description as string) ?? "";
      botName = (meta.botName as string) ?? "";
    }
    const fileCount = discoverFiles(pDir).length;
    return { name, description, fileCount, botName };
  });
}

// --- Persona loading ---

export function loadPersona(
  personaDir: string,
  variables: PersonaVariables,
  activePersona = "default",
): PersonaState {
  const personaPath = join(personaDir, activePersona);
  const rawPaths = discoverFiles(personaPath);

  // Prefix with persona name for consistent addressing from persona root
  const filePaths = rawPaths.map((p) => `${activePersona}/${p}`);

  const files: PersonaFile[] = [];

  for (const relPath of filePaths) {
    const fullPath = join(personaDir, relPath);
    const raw = readFileSync(fullPath, "utf-8");
    const { meta, content } = parseFrontmatter(raw);

    files.push({
      path: relPath,
      meta: { ...extractMeta(meta), label: (meta.label as string) ?? relPath },
      rawContent: content,
    });
  }

  // Sort by order, then alphabetically for stable ordering within same order
  files.sort((a, b) => {
    if (a.meta.order !== b.meta.order) return a.meta.order - b.meta.order;
    return a.path.localeCompare(b.path);
  });

  // Extract per-character botName from soul.md frontmatter (fallback: legacy persona.md)
  const soulFile = files.find((f) => f.path === `${activePersona}/soul.md`);
  const legacyPersonaFile = files.find((f) => f.path === `${activePersona}/persona.md`);
  const resolvedBotName = soulFile?.meta.botName || legacyPersonaFile?.meta.botName || variables.botName;
  const resolvedVariables = { ...variables, botName: resolvedBotName };

  const composedPrompt = files
    .filter((f) => f.meta.enabled)
    .map((f) => substituteVariables(f.rawContent, resolvedVariables))
    .join("\n\n");

  const enabled = files.filter((f) => f.meta.enabled).length;
  console.log(
    `Persona: loaded ${files.length} files (${enabled} enabled), persona: "${activePersona}", character: "${resolvedBotName}", prompt: ${composedPrompt.length} chars`,
  );

  return { files, composedPrompt, activePersona, botName: resolvedBotName, loadedAt: new Date() };
}

// --- File CRUD ---

export function getFileContent(
  personaDir: string,
  relPath: string,
): { path: string; meta: PersonaFileMeta; content: string } | null {
  const safe = sanitizePath(relPath);
  if (!safe) return null;

  const fullPath = join(personaDir, safe);
  if (!existsSync(fullPath)) return null;

  const raw = readFileSync(fullPath, "utf-8");
  const { meta, content } = parseFrontmatter(raw);

  return {
    path: safe,
    meta: { ...extractMeta(meta), label: (meta.label as string) ?? safe },
    content,
  };
}

export function saveFile(
  personaDir: string,
  relPath: string,
  content: string,
  meta: Partial<PersonaFileMeta>,
): { success: boolean; error?: string } {
  const safe = sanitizePath(relPath);
  if (!safe) return { success: false, error: "Invalid path" };

  const fullPath = join(personaDir, safe);
  if (!existsSync(fullPath)) return { success: false, error: "File not found" };

  const fileContent = buildFrontmatter(meta) + "\n\n" + content;
  writeFileSync(fullPath, fileContent, "utf-8");
  console.log(`Persona: saved file "${safe}"`);
  return { success: true };
}

export function createFile(
  personaDir: string,
  relPath: string,
  content: string,
  meta: Partial<PersonaFileMeta>,
): { success: boolean; error?: string } {
  const safe = sanitizePath(relPath);
  if (!safe) return { success: false, error: "Invalid path" };
  if (!safe.endsWith(".md")) return { success: false, error: "File must end in .md" };

  const fullPath = join(personaDir, safe);
  if (existsSync(fullPath)) return { success: false, error: "File already exists" };

  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fileContent = buildFrontmatter(meta) + "\n\n" + content;
  writeFileSync(fullPath, fileContent, "utf-8");
  console.log(`Persona: created file "${safe}"`);
  return { success: true };
}

export function deleteFile(
  personaDir: string,
  relPath: string,
): { success: boolean; error?: string } {
  const safe = sanitizePath(relPath);
  if (!safe) return { success: false, error: "Invalid path" };

  const fullPath = join(personaDir, safe);
  if (!existsSync(fullPath)) return { success: false, error: "File not found" };

  unlinkSync(fullPath);
  console.log(`Persona: deleted file "${safe}"`);
  return { success: true };
}

// --- Persona CRUD ---

export function createPersona(
  personaDir: string,
  personaName: string,
  description?: string,
  botName?: string,
): { success: boolean; error?: string } {
  // Validate name: lowercase, alphanumeric, hyphens
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(personaName)) {
    return { success: false, error: "Persona name must be lowercase alphanumeric with hyphens (e.g. 'my-persona')" };
  }

  const pDir = join(personaDir, personaName);
  if (existsSync(pDir)) {
    return { success: false, error: `Persona "${personaName}" already exists` };
  }

  const displayName = personaName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const charName = botName || displayName;

  mkdirSync(pDir, { recursive: true });

  // Create soul.md (consolidated identity + soul + metadata)
  const soulContent =
    buildFrontmatter({
      order: 10,
      enabled: true,
      label: `${charName} Soul`,
      section: "soul",
      description: description || "",
      botName: charName,
    }) +
    "\n\n" +
    `# Soul: ${charName}\n\n` +
    `## Identity\n\n` +
    `You are **{{botName}}**.\n\n` +
    `- **Full Name**: ${charName}\n` +
    `- **Role**: Define this character's role\n` +
    `- **Nature**: What makes this character distinct\n\n` +
    `## Backstory\n\n` +
    `Write this character's history and lore here.\n\n` +
    `## Identity Statement\n\n` +
    `A brief definitive statement of who ${charName} is.\n\n` +
    `## Core Directive\n\n` +
    `Define the fundamental operating principle for ${charName}.\n\n` +
    `## Personality\n\n` +
    `Describe how ${charName} behaves — tone, style, emotional range.\n\n` +
    `## Behavioral Standards\n\n` +
    `Rules ${charName} follows in all interactions.\n`;

  writeFileSync(join(pDir, "soul.md"), soulContent, "utf-8");

  // Create bootstrap.md (self-contained personas get their own bootstrap)
  const bootstrapContent =
    buildFrontmatter({
      order: 5,
      enabled: true,
      label: "Bootstrap",
      section: "bootstrap",
    }) +
    "\n\n" +
    `# Operating Instructions\n\n` +
    `## Response Format\n\n` +
    `- You are speaking in a Discord server. Keep responses appropriate for Discord.\n` +
    `- Default to concise. If it can be said in 3-6 sentences, do that.\n` +
    `- When writing creative content, you can be longer and more detailed.\n\n` +
    `## Behavioral Rules\n\n` +
    `- Stay in character as **{{botName}}** at all times.\n` +
    `- Do not hallucinate capabilities.\n` +
    `- If something is ambiguous, make a smart assumption and move forward.\n`;

  writeFileSync(join(pDir, "bootstrap.md"), bootstrapContent, "utf-8");

  // Create skills.md
  const skillsContent =
    buildFrontmatter({
      order: 50,
      enabled: true,
      label: "Skills",
      section: "skill",
    }) +
    "\n\n" +
    `# Skills\n\n` +
    `Define ${charName}'s specialized skills here. Use H2 headings for each skill area.\n`;

  writeFileSync(join(pDir, "skills.md"), skillsContent, "utf-8");

  console.log(`Persona: created persona "${personaName}" with template files`);
  return { success: true };
}

export function deletePersona(
  personaDir: string,
  personaName: string,
  activePersona: string,
): { success: boolean; error?: string } {
  if (personaName === "default") {
    return { success: false, error: 'Cannot delete the "default" persona' };
  }
  if (personaName === activePersona) {
    return { success: false, error: "Cannot delete the currently active persona. Switch first." };
  }

  const pDir = join(personaDir, personaName);
  if (!existsSync(pDir)) {
    return { success: false, error: `Persona "${personaName}" not found` };
  }

  try {
    rmSync(pDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Persona: failed to delete "${personaName}":`, err);
    return { success: false, error: `Failed to delete: ${(err as Error).message}` };
  }

  if (existsSync(pDir)) {
    console.warn(`Persona: directory "${personaName}" still exists after deletion`);
    return { success: false, error: "Directory still exists after deletion — it may be locked by another process" };
  }

  console.log(`Persona: deleted persona "${personaName}"`);
  return { success: true };
}
