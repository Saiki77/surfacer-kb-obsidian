import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import type { KBSyncSettings } from "../settings";

let client: S3Client | null = null;
let lastSettingsHash = "";

function settingsHash(settings: KBSyncSettings): string {
  return `${settings.s3Bucket}:${settings.awsRegion}:${settings.credentialMode}:${settings.awsProfile}:${settings.awsAccessKeyId}`;
}

function getClient(settings: KBSyncSettings): S3Client {
  const hash = settingsHash(settings);
  if (!client || hash !== lastSettingsHash) {
    const credentials =
      settings.credentialMode === "profile"
        ? fromIni({ profile: settings.awsProfile })
        : {
            accessKeyId: settings.awsAccessKeyId,
            secretAccessKey: settings.awsSecretAccessKey,
          };

    client = new S3Client({
      region: settings.awsRegion,
      credentials,
    });
    lastSettingsHash = hash;
  }
  return client;
}

export async function checkConnectivity(
  settings: KBSyncSettings
): Promise<boolean> {
  try {
    const s3 = getClient(settings);
    await s3.send(new HeadBucketCommand({ Bucket: settings.s3Bucket }));
    return true;
  } catch {
    return false;
  }
}

export interface S3ListItem {
  key: string;
  lastModified: string;
  size: number;
}

export async function listAllObjects(
  settings: KBSyncSettings
): Promise<S3ListItem[]> {
  const s3 = getClient(settings);
  const items: S3ListItem[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: settings.s3Bucket,
        Prefix: settings.s3Prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of response.Contents || []) {
      if (obj.Key && obj.Size && obj.Size > 0) {
        items.push({
          key: obj.Key.replace(settings.s3Prefix, ""),
          lastModified: obj.LastModified?.toISOString() || "unknown",
          size: obj.Size,
        });
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return items;
}

export async function getObject(
  settings: KBSyncSettings,
  key: string
): Promise<{ body: string; metadata: Record<string, string> }> {
  const s3 = getClient(settings);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: settings.s3Bucket,
      Key: settings.s3Prefix + key,
    })
  );
  const body = (await response.Body?.transformToString()) || "";
  return { body, metadata: response.Metadata || {} };
}

export async function putObject(
  settings: KBSyncSettings,
  key: string,
  body: string,
  metadata: Record<string, string>,
  contentType: string = "text/markdown"
): Promise<void> {
  const s3 = getClient(settings);
  await s3.send(
    new PutObjectCommand({
      Bucket: settings.s3Bucket,
      Key: settings.s3Prefix + key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
    })
  );
}

export async function listObjects(
  settings: KBSyncSettings,
  prefix: string,
  maxKeys: number = 100
): Promise<S3ListItem[]> {
  const s3 = getClient(settings);
  const items: S3ListItem[] = [];
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: settings.s3Bucket,
      Prefix: settings.s3Prefix + prefix,
      MaxKeys: maxKeys,
    })
  );
  for (const obj of response.Contents || []) {
    if (obj.Key && obj.Size && obj.Size > 0) {
      items.push({
        key: obj.Key.replace(settings.s3Prefix, ""),
        lastModified: obj.LastModified?.toISOString() || "unknown",
        size: obj.Size,
      });
    }
  }
  return items;
}

export async function deleteObject(
  settings: KBSyncSettings,
  key: string
): Promise<void> {
  const s3 = getClient(settings);
  await s3.send(
    new DeleteObjectCommand({
      Bucket: settings.s3Bucket,
      Key: settings.s3Prefix + key,
    })
  );
}

export async function copyObject(
  settings: KBSyncSettings,
  sourceKey: string,
  destKey: string
): Promise<void> {
  const s3 = getClient(settings);
  await s3.send(
    new CopyObjectCommand({
      Bucket: settings.s3Bucket,
      CopySource: `${settings.s3Bucket}/${settings.s3Prefix}${sourceKey}`,
      Key: settings.s3Prefix + destKey,
    })
  );
}

/**
 * Rename all objects under oldPrefix to newPrefix (copy + delete).
 * Returns the list of [oldKey, newKey] pairs that were moved.
 */
export async function renamePrefix(
  settings: KBSyncSettings,
  oldPrefix: string,
  newPrefix: string
): Promise<Array<[string, string]>> {
  const items = await listAllObjects(settings);
  const moved: Array<[string, string]> = [];

  for (const item of items) {
    if (item.key.startsWith(oldPrefix)) {
      const newKey = newPrefix + item.key.slice(oldPrefix.length);
      await copyObject(settings, item.key, newKey);
      await deleteObject(settings, item.key);
      moved.push([item.key, newKey]);
    }
  }

  return moved;
}
