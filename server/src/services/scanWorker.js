import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import NodeClam from 'clamscan';
import Message from '../models/Message.js';
import { ALLOWED_UPLOAD_TYPES, defaultStorageService } from './storage.js';
import { audit } from './auditService.js';

const DEFAULT_LEASE_MS = 60_000;

/**
 * Connects to a clamd daemon (e.g. via Docker Compose) for streaming malware scans.
 */
export async function createClamdScanner({ host, port = 3310 } = {}) {
  const clamscan = await new NodeClam().init({
    removeInfected: false,
    quarantineInfected: false,
    debugMode: false,
    preference: 'clamdscan',
    clamdscan: {
      host,
      port,
      timeout: 15_000,
      localFallback: false,
    },
  });

  return {
    async scanBuffer(buffer) {
      const { isInfected, viruses } = await clamscan.scanStream(Readable.from(buffer));
      return {
        isInfected: Boolean(isInfected),
        viruses: viruses || [],
      };
    },
  };
}

function isSafePlainText(buffer) {
  if (buffer.includes(0x00)) return false;
  const text = buffer.toString('utf8');
  const trimmed = text.trimStart().slice(0, 256).toLowerCase();
  if (
    trimmed.startsWith('<svg') ||
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<script')
  ) {
    return false;
  }
  return true;
}

/**
 * Validates actual file content via magic bytes (never trusting the client's
 * Content-Type) and re-encodes images with sharp to strip EXIF/GPS metadata
 * and neutralize polyglot payloads.
 */
export async function verifyAndSanitizeUpload({ buffer, declaredType }) {
  if (declaredType === 'text/plain') {
    const detected = await fileTypeFromBuffer(buffer);
    if (detected || !isSafePlainText(buffer)) {
      return { ok: false, reason: 'type_mismatch' };
    }
    return { ok: true, buffer };
  }

  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || detected.mime !== declaredType) {
    return { ok: false, reason: 'type_mismatch' };
  }

  if (declaredType === 'application/pdf') {
    return { ok: true, buffer };
  }

  try {
    // sharp strips EXIF, GPS, XMP, and IPTC metadata by default when .withMetadata() is omitted.
    const pipeline = sharp(buffer, { animated: declaredType === 'image/gif' }).rotate();
    let cleanBuffer;
    if (declaredType === 'image/png') {
      cleanBuffer = await pipeline.png().toBuffer();
    } else if (declaredType === 'image/jpeg') {
      cleanBuffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
    } else if (declaredType === 'image/webp') {
      cleanBuffer = await pipeline.webp({ quality: 90 }).toBuffer();
    } else if (declaredType === 'image/gif') {
      cleanBuffer = await pipeline.gif().toBuffer();
    } else {
      return { ok: false, reason: 'type_mismatch' };
    }
    return { ok: true, buffer: cleanBuffer };
  } catch {
    return { ok: false, reason: 'corrupt_image' };
  }
}

/**
 * Dependency-injectable quarantine scan worker. Claims pending attachments
 * atomically via findOneAndUpdate so concurrent workers never double-process.
 */
export function createScanWorker({
  storageService = defaultStorageService,
  scanner,
  io = null,
  pollIntervalMs = 2000,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  let timer = null;
  let running = false;

  async function markRejected({ msg, att, reason, userMessage, viruses = [] }) {
    await storageService.deleteObject(att.key).catch(() => {});

    await Message.updateOne(
      { _id: msg._id, workspace: msg.workspace, 'attachments.key': att.key },
      {
        $set: {
          'attachments.$.scanStatus': 'rejected',
          'attachments.$.scanReason': userMessage,
          'attachments.$.scanClaimedAt': null,
        },
      }
    );

    await audit('upload.rejected', {
      actor: msg.sender,
      targetType: 'message',
      targetId: msg._id.toString(),
      metadata: {
        roomId: msg.room.toString(),
        reason,
        viruses,
      },
    });

    if (io) {
      const roomId = msg.room.toString();
      io.to(`room:${roomId}`).emit('attachment:status', {
        roomId,
        messageId: msg._id.toString(),
        attachmentKey: att.key,
        status: 'rejected',
        reason: userMessage,
      });
      io.to(`user:${msg.sender.toString()}`).emit('notification:notice', {
        type: 'upload_rejected',
        message: `Your upload "${att.name}" was rejected: ${userMessage}`,
      });
    }
  }

  async function processNext() {
    if (!storageService.isConfigured() || !scanner) {
      return false;
    }

    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - leaseMs);

    const msg = await Message.findOneAndUpdate(
      {
        deletedAt: null,
        attachments: {
          $elemMatch: {
            scanStatus: 'pending',
            $or: [{ scanClaimedAt: null }, { scanClaimedAt: { $lt: leaseCutoff } }],
          },
        },
      },
      {
        $set: { 'attachments.$.scanClaimedAt': now },
      },
      { new: true, bypassTenantScope: true }
    );

    if (!msg) return false;

    const att = msg.attachments.find((a) => a.scanStatus === 'pending');
    if (!att) return false;

    try {
      const buffer = await storageService.getObjectBuffer(att.key);

      const scanRes = await scanner.scanBuffer(buffer);
      if (scanRes.isInfected) {
        await markRejected({
          msg,
          att,
          reason: 'malware',
          userMessage: 'Malware detected',
          viruses: scanRes.viruses,
        });
        return true;
      }

      const sanitized = await verifyAndSanitizeUpload({
        buffer,
        declaredType: att.contentType,
      });
      if (!sanitized.ok) {
        await markRejected({
          msg,
          att,
          reason: sanitized.reason,
          userMessage: 'File content does not match declared type',
        });
        return true;
      }

      const ext = ALLOWED_UPLOAD_TYPES[att.contentType] || 'bin';
      const roomId = msg.room.toString();
      const finalKey = `uploads/${roomId}/${crypto.randomUUID()}.${ext}`;

      await storageService.putObjectBuffer({
        key: finalKey,
        buffer: sanitized.buffer,
        contentType: att.contentType,
      });
      await storageService.deleteObject(att.key).catch(() => {});

      await Message.updateOne(
        { _id: msg._id, workspace: msg.workspace, 'attachments.key': att.key },
        {
          $set: {
            'attachments.$.key': finalKey,
            'attachments.$.size': sanitized.buffer.length,
            'attachments.$.scanStatus': 'clean',
            'attachments.$.scanReason': null,
            'attachments.$.scanClaimedAt': null,
          },
        }
      );

      const cleanAtt = {
        key: finalKey,
        name: att.name,
        contentType: att.contentType,
        size: sanitized.buffer.length,
        scanStatus: 'clean',
      };
      const url = await storageService.createPresignedDownloadUrl(cleanAtt);

      if (io) {
        io.to(`room:${roomId}`).emit('attachment:status', {
          roomId,
          messageId: msg._id.toString(),
          attachmentKey: att.key,
          newKey: finalKey,
          status: 'clean',
          size: sanitized.buffer.length,
          url,
        });
      }

      return true;
    } catch (err) {
      // Release the claim lease on transient errors so another poll can retry.
      await Message.updateOne(
        {
          _id: msg._id,
          workspace: msg.workspace,
          'attachments.key': att.key,
          'attachments.scanStatus': 'pending',
        },
        { $set: { 'attachments.$.scanClaimedAt': null } }
      ).catch(() => {});
      console.error('[scanWorker] Error processing attachment:', err);
      return false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        while (await processNext()) {
          // Drain available pending jobs
        }
      } finally {
        running = false;
      }
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { processNext, start, stop };
}
