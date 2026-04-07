/**
 * Document template store. Team-shared templates in S3.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface TemplateMeta {
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
}

export async function listTemplates(
  settings: KBSyncSettings
): Promise<TemplateMeta[]> {
  const items = await s3.listObjects(settings, "_templates/", 100);
  const templates: TemplateMeta[] = [];
  for (const item of items) {
    if (!item.key.endsWith(".meta.json")) continue;
    try {
      const { body } = await s3.getObject(settings, item.key);
      templates.push(JSON.parse(body));
    } catch { /* skip */ }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadTemplate(
  settings: KBSyncSettings,
  name: string
): Promise<string> {
  const { body } = await s3.getObject(settings, `_templates/${name}.md`);
  return body;
}

export async function saveTemplate(
  settings: KBSyncSettings,
  name: string,
  content: string,
  description: string,
  createdBy: string
): Promise<void> {
  const meta: TemplateMeta = {
    name,
    description,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  await s3.putObject(settings, `_templates/${name}.md`, content, {}, "text/markdown");
  await s3.putObject(
    settings,
    `_templates/${name}.meta.json`,
    JSON.stringify(meta, null, 2),
    {},
    "application/json"
  );
}

export async function deleteTemplate(
  settings: KBSyncSettings,
  name: string
): Promise<void> {
  await s3.deleteObject(settings, `_templates/${name}.md`);
  await s3.deleteObject(settings, `_templates/${name}.meta.json`);
}
