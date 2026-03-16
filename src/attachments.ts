import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Attachment, OutboundAttachment } from "./domain.js";

interface DocumentSnapshotEntry extends OutboundAttachment {
  hash: string;
}

export type DocumentSnapshot = Map<string, DocumentSnapshotEntry>;

export function mergeAttachments(
  existing: Attachment[] | undefined,
  incoming: Attachment[] | undefined
): Attachment[] {
  const merged = new Map<string, Attachment>();

  for (const attachment of [...(existing ?? []), ...(incoming ?? [])]) {
    merged.set(buildAttachmentKey(attachment), {
      ...merged.get(buildAttachmentKey(attachment)),
      ...attachment
    });
  }

  return [...merged.values()];
}

export function listAttachmentAddDirs(attachments: Attachment[] | undefined): string[] {
  return uniqueStrings(
    (attachments ?? [])
      .map((attachment) => attachment.localPath)
      .filter((value): value is string => Boolean(value))
      .map((filePath) => path.dirname(filePath))
  );
}

export function formatAttachmentsForPrompt(attachments: Attachment[] | undefined): string[] {
  const normalized = attachments ?? [];
  if (normalized.length === 0) {
    return ["- none"];
  }

  return normalized.map((attachment) => {
    const details = [
      attachment.kind,
      attachment.name ? `name=${JSON.stringify(attachment.name)}` : undefined,
      attachment.mimeType ? `mime=${attachment.mimeType}` : undefined,
      attachment.localPath ? `path=${attachment.localPath}` : undefined,
      attachment.url ? `url=${attachment.url}` : undefined
    ]
      .filter(Boolean)
      .join(", ");

    return `- ${details || attachment.id}`;
  });
}

export async function captureTrackedDocumentFiles(
  attachments: Attachment[] | undefined
): Promise<DocumentSnapshot> {
  const snapshot: DocumentSnapshot = new Map();
  const attachmentMetadata = new Map(
    (attachments ?? [])
      .filter((attachment): attachment is Attachment & { localPath: string } => Boolean(attachment.localPath))
      .map((attachment) => [
        attachment.localPath,
        {
          name: attachment.name ?? path.basename(attachment.localPath),
          mimeType: attachment.mimeType
        }
      ])
  );

  for (const dirPath of listAttachmentAddDirs(attachments)) {
    let entries;
    try {
      entries = await fs.readdir(dirPath, {
        withFileTypes: true
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(dirPath, entry.name);
      if (!isTrackedDocumentFile(filePath)) {
        continue;
      }

      snapshot.set(filePath, {
        name: attachmentMetadata.get(filePath)?.name ?? entry.name,
        localPath: filePath,
        mimeType: attachmentMetadata.get(filePath)?.mimeType ?? inferDocumentMimeType(filePath),
        hash: await hashFile(filePath)
      });
    }
  }

  return snapshot;
}

export function diffTrackedDocumentFiles(
  before: DocumentSnapshot,
  after: DocumentSnapshot
): OutboundAttachment[] {
  const changed: OutboundAttachment[] = [];

  for (const [filePath, next] of after.entries()) {
    const previous = before.get(filePath);
    if (!previous || previous.hash !== next.hash) {
      changed.push({
        name: next.name,
        localPath: next.localPath,
        mimeType: next.mimeType
      });
    }
  }

  return changed.sort((left, right) => left.name.localeCompare(right.name));
}

export function isTrackedDocumentFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".doc" || extension === ".docx";
}

export function inferDocumentMimeType(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".doc") {
    return "application/msword";
  }

  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  return undefined;
}

function buildAttachmentKey(attachment: Attachment): string {
  return attachment.localPath ?? `${attachment.kind}:${attachment.id}`;
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
