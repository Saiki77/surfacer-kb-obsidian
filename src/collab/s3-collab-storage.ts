/**
 * S3 operations for Yjs collaboration snapshots.
 * Handles persistence of CRDT state to S3 for recovery and session continuity.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import type { KBSyncSettings } from "../settings";

function getClient(settings: KBSyncSettings): S3Client {
  const credentials =
    settings.credentialMode === "profile"
      ? fromIni({ profile: settings.awsProfile })
      : {
          accessKeyId: settings.awsAccessKeyId,
          secretAccessKey: settings.awsSecretAccessKey,
        };

  return new S3Client({ region: settings.awsRegion, credentials });
}

function collabKey(settings: KBSyncSettings, docPath: string, file: string): string {
  return `${settings.s3Prefix}_collab/${docPath}/${file}`;
}

export async function writeSnapshot(
  settings: KBSyncSettings,
  docPath: string,
  state: Uint8Array
): Promise<void> {
  const s3 = getClient(settings);
  await s3.send(
    new PutObjectCommand({
      Bucket: settings.s3Bucket,
      Key: collabKey(settings, docPath, "snapshot.bin"),
      Body: state,
      ContentType: "application/octet-stream",
    })
  );
  // Write metadata alongside snapshot
  await s3.send(
    new PutObjectCommand({
      Bucket: settings.s3Bucket,
      Key: collabKey(settings, docPath, "snapshot-meta.json"),
      Body: JSON.stringify({
        timestamp: new Date().toISOString(),
        size: state.length,
      }),
      ContentType: "application/json",
    })
  );
}

export async function readSnapshot(
  settings: KBSyncSettings,
  docPath: string
): Promise<Uint8Array | null> {
  try {
    const s3 = getClient(settings);
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: settings.s3Bucket,
        Key: collabKey(settings, docPath, "snapshot.bin"),
      })
    );
    const bytes = await response.Body?.transformToByteArray();
    return bytes || null;
  } catch (err: any) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function deleteCollabData(
  settings: KBSyncSettings,
  docPath: string
): Promise<void> {
  const s3 = getClient(settings);
  const prefix = `${settings.s3Prefix}_collab/${docPath}/`;
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: settings.s3Bucket,
      Prefix: prefix,
      MaxKeys: 1000,
    })
  );
  for (const obj of response.Contents || []) {
    if (obj.Key) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: settings.s3Bucket,
          Key: obj.Key,
        })
      );
    }
  }
}

export async function cleanupStaleCollabData(
  settings: KBSyncSettings,
  maxAgeHours: number = 24
): Promise<void> {
  const s3 = getClient(settings);
  const prefix = `${settings.s3Prefix}_collab/`;
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: settings.s3Bucket,
      Prefix: prefix,
      MaxKeys: 1000,
    })
  );

  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  const staleKeys: string[] = [];

  for (const obj of response.Contents || []) {
    if (obj.Key && obj.LastModified && obj.LastModified < cutoff) {
      staleKeys.push(obj.Key);
    }
  }

  for (const key of staleKeys) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: settings.s3Bucket,
        Key: key,
      })
    );
  }
}
