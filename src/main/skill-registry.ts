/**
 * Skill registry — the L1-promotion layer.
 *
 * Every installed ClawHub skill becomes a first-class tool the model can
 * call by name. The registry is populated at app boot from
 * `~/.clippyai/skills/<slug>/` and updated when install_skill / uninstall
 * runs. The brain sends the registry's manifest in /v1/turn payload so
 * the server can include the skills as FunctionDeclarations in the prompt.
 *
 * Naming convention: a skill with slug `weather-radar` becomes the tool
 * `skill__weather_radar` (slug dashes → underscores, prefix prevents
 * collision with native tools).
 *
 * This is the user's key ask: "when a skill is used, it should be
 * recognised in L1." This module is the L1 recognition.
 */

import { listInstalledSkills, runSkill, type SkillManifest } from './clawhub';
import { createLogger, serializeErr } from './logger';
import type { ToolResult } from './types/tool-result';

const log = createLogger('SkillRegistry');

/** slug → manifest. Source of truth for installed skills at runtime. */
let registry = new Map<string, SkillManifest>();

/** Convert a ClawHub slug to the tool name the model will call. */
export function slugToToolName(slug: string): string {
  return `skill__${slug.replace(/-/g, '_').toLowerCase()}`;
}

/** Inverse — used when the model calls a `skill__*` tool. */
export function toolNameToSlug(toolName: string): string | null {
  if (!toolName.startsWith('skill__')) return null;
  return toolName.substring('skill__'.length).replace(/_/g, '-');
}

/**
 * Boot-time + post-install repopulation. Walks the on-disk skill cache
 * and rebuilds the in-memory map. Called from initTools (boot) and from
 * the install_skill tool handler (refresh after a new install).
 */
export async function refreshSkillRegistry(): Promise<void> {
  try {
    const manifests = await listInstalledSkills();
    const next = new Map<string, SkillManifest>();
    for (const m of manifests) {
      next.set(m.slug, m);
    }
    registry = next;
    log.info('Skill registry refreshed', { count: registry.size, slugs: [...registry.keys()] });
  } catch (err) {
    log.warn('refreshSkillRegistry failed', serializeErr(err));
  }
}

export function getRegistry(): Map<string, SkillManifest> {
  return registry;
}

/**
 * Build the payload to send in /v1/turn so the server can expose
 * skill tools to the model. Each entry becomes a FunctionDeclaration
 * with name `skill__<slug>`, description from the SKILL.md, and a
 * single `params` object parameter (free-form because we don't know
 * what each skill accepts ahead of time).
 *
 * Returns [] when no skills are installed (back-compat with old server).
 */
export function getInstalledSkillsForPrompt(): Array<{
  name: string;
  description: string;
  slug: string;
  version: string;
  required_env: string[];
}> {
  return [...registry.values()].map((m) => ({
    name: slugToToolName(m.slug),
    description: `[skill] ${m.description} (installed from ClawHub: ${m.slug} v${m.version}). Pass params as a JSON object.`,
    slug: m.slug,
    version: m.version,
    required_env: m.requires.env || [],
  }));
}

/**
 * Tool-map dispatcher: when the model calls a `skill__<slug>` tool, route
 * to runSkill. This is what executeTool will call when it sees a tool
 * name with the `skill__` prefix.
 */
export async function executeSkillTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
  const slug = toolNameToSlug(toolName);
  if (!slug) return { text: `(error:NOT_A_SKILL_TOOL) ${toolName} doesn't look like a skill tool name.` };
  const manifest = registry.get(slug);
  if (!manifest) {
    return { text: `(error:SKILL_NOT_REGISTERED) ${slug} is not in the local registry. Re-install it via install_skill, or check that ~/.clippyai/skills/${slug}/ exists.` };
  }
  log.info('Executing skill', { slug, params: Object.keys(params || {}) });
  const text = await runSkill(slug, params);
  return { text };
}

/** Check if a tool name belongs to the skill namespace. Used by executeTool. */
export function isSkillTool(toolName: string): boolean {
  return toolName.startsWith('skill__');
}
