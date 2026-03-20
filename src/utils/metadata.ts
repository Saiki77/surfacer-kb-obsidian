export interface DocumentMetadata {
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
  tags?: string[];
  category?: string;
  relatedDocuments?: string[];
  aiProcessed?: string;
}

export function parseFrontmatter(content: string): {
  metadata: DocumentMetadata;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const metadata: DocumentMetadata = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case "title":
        metadata.title = value;
        break;
      case "author":
        metadata.author = value;
        break;
      case "created":
        metadata.created = value;
        break;
      case "modified":
        metadata.modified = value;
        break;
      case "category":
        metadata.category = value;
        break;
      case "aiProcessed":
        metadata.aiProcessed = value;
        break;
      case "tags":
        if (value.startsWith("[") && value.endsWith("]")) {
          metadata.tags = value
            .slice(1, -1)
            .split(",")
            .map((t) => t.trim());
        }
        break;
      case "relatedDocuments":
        if (value.startsWith("[") && value.endsWith("]")) {
          metadata.relatedDocuments = value
            .slice(1, -1)
            .split(",")
            .map((t) => t.trim());
        }
        break;
    }
  }

  return { metadata, body: match[2] };
}

export function generateFrontmatter(metadata: DocumentMetadata): string {
  const lines: string[] = ["---"];
  if (metadata.title) lines.push(`title: ${metadata.title}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.created) lines.push(`created: ${metadata.created}`);
  if (metadata.modified) lines.push(`modified: ${metadata.modified}`);
  if (metadata.tags && metadata.tags.length > 0) {
    lines.push(`tags: [${metadata.tags.join(", ")}]`);
  }
  if (metadata.category) lines.push(`category: ${metadata.category}`);
  if (metadata.relatedDocuments && metadata.relatedDocuments.length > 0) {
    lines.push(`relatedDocuments: [${metadata.relatedDocuments.join(", ")}]`);
  }
  if (metadata.aiProcessed) lines.push(`aiProcessed: ${metadata.aiProcessed}`);
  lines.push("---");
  return lines.join("\n");
}

export function buildDocumentContent(
  body: string,
  metadata: DocumentMetadata
): string {
  const frontmatter = generateFrontmatter(metadata);
  return `${frontmatter}\n${body}`;
}

export function metadataToS3Headers(
  metadata: DocumentMetadata
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (metadata.author) headers["author"] = metadata.author;
  if (metadata.created) headers["created"] = metadata.created;
  if (metadata.modified) headers["modified"] = metadata.modified;
  if (metadata.tags) headers["tags"] = metadata.tags.join(",");
  if (metadata.category) headers["category"] = metadata.category;
  if (metadata.relatedDocuments)
    headers["relateddocuments"] = metadata.relatedDocuments.join(",");
  if (metadata.aiProcessed) headers["aiprocessed"] = metadata.aiProcessed;
  return headers;
}

export function s3HeadersToMetadata(
  headers: Record<string, string>
): DocumentMetadata {
  const metadata: DocumentMetadata = {};
  if (headers["author"]) metadata.author = headers["author"];
  if (headers["created"]) metadata.created = headers["created"];
  if (headers["modified"]) metadata.modified = headers["modified"];
  if (headers["tags"]) metadata.tags = headers["tags"].split(",");
  if (headers["category"]) metadata.category = headers["category"];
  if (headers["relateddocuments"])
    metadata.relatedDocuments = headers["relateddocuments"].split(",");
  if (headers["aiprocessed"]) metadata.aiProcessed = headers["aiprocessed"];
  return metadata;
}
