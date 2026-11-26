import crypto from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import env from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

// SVG is intentionally excluded: SVGs can embed <script> tags and execute JS if viewed inline (XSS risk).
export const ALLOWED_UPLOAD_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const PRESIGN_PUT_TTL_SECONDS = 300; // 5 minutes
export const PRESIGN_GET_TTL_SECONDS = 900; // 15 minutes

function sanitizeDownloadFilename(name) {
  return String(name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function createDefaultS3Client() {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    return null;
  }

  return new S3Client({
    region: env.S3_REGION || 'auto',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Dependency-injectable S3 storage helper so integration tests can mock
 * presigning and HEAD checks without hitting live cloud storage.
 */
export function createStorageService({
  s3Client = createDefaultS3Client(),
  presigner = getSignedUrl,
  bucket = env.S3_BUCKET,
} = {}) {
  function isConfigured() {
    return Boolean(s3Client && bucket);
  }

  async function createPresignedUpload({ roomId, contentType, size }) {
    if (!isConfigured()) {
      throw new AppError('File uploads are not configured on this server', 503);
    }

    const ext = ALLOWED_UPLOAD_TYPES[contentType];
    if (!ext) {
      throw new AppError('Unsupported file type', 400);
    }

    // Generate a random UUID key under quarantine/<roomId>/ so untrusted bytes are
    // scanned and EXIF-stripped before being promoted to uploads/<roomId>/.
    const key = `quarantine/${roomId}/${crypto.randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size,
    });

    const uploadUrl = await presigner(s3Client, command, {
      expiresIn: PRESIGN_PUT_TTL_SECONDS,
    });

    return {
      uploadUrl,
      key,
      expiresIn: PRESIGN_PUT_TTL_SECONDS,
    };
  }

  async function verifyUploadedObject({ key, expectedSize }) {
    if (!isConfigured()) return;
    try {
      const head = await s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      if (
        typeof head?.ContentLength === 'number' &&
        expectedSize &&
        head.ContentLength > MAX_UPLOAD_BYTES
      ) {
        throw new AppError('Uploaded file exceeds maximum allowed size', 400);
      }
    } catch (err) {
      if (err.isOperational) throw err;
      throw new AppError('Uploaded attachment could not be verified in storage', 400);
    }
  }

  async function createPresignedDownloadUrl(attachment) {
    if (!isConfigured() || !attachment?.key) return null;

    const isImage = attachment.contentType?.startsWith('image/');
    const safeName = sanitizeDownloadFilename(attachment.name);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: attachment.key,
      // Force download for non-image files (e.g. PDF/TXT) to prevent browser inline execution.
      ...(isImage ? {} : { ResponseContentDisposition: `attachment; filename="${safeName}"` }),
    });

    return presigner(s3Client, command, {
      expiresIn: PRESIGN_GET_TTL_SECONDS,
    });
  }

  async function getObjectBuffer(key) {
    if (!isConfigured()) {
      throw new AppError('File uploads are not configured on this server', 503);
    }
    const res = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async function putObjectBuffer({ key, buffer, contentType }) {
    if (!isConfigured()) {
      throw new AppError('File uploads are not configured on this server', 503);
    }
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
      })
    );
  }

  async function deleteObject(key) {
    if (!isConfigured() || !key) return;
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
  }

  // Trade-off: Presigned GET URLs are generated on read instead of using a public bucket + CDN.
  // This guarantees only room members can access private/DM files, at the cost of not sharing CDN edge caches.
  // Files remain non-downloadable (url: null) until the scan worker marks scanStatus === 'clean'.
  async function attachDownloadUrls(messageObj) {
    if (!messageObj?.attachments?.length || !isConfigured()) {
      return messageObj;
    }
    const attachments = await Promise.all(
      messageObj.attachments.map(async (att) => ({
        ...att,
        url: att.scanStatus === 'clean' ? await createPresignedDownloadUrl(att) : null,
      }))
    );
    return { ...messageObj, attachments };
  }

  return {
    isConfigured,
    createPresignedUpload,
    verifyUploadedObject,
    getObjectBuffer,
    putObjectBuffer,
    deleteObject,
    createPresignedDownloadUrl,
    attachDownloadUrls,
  };
}

export const defaultStorageService = createStorageService();
