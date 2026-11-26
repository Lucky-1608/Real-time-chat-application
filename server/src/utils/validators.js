import { z } from 'zod';
import mongoose from 'mongoose';
import { ALLOWED_REACTIONS } from '../models/Message.js';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '../services/storage.js';

const ALLOWED_MIME_KEYS = Object.keys(ALLOWED_UPLOAD_TYPES);

export const objectIdSchema = z
  .string()
  .refine((val) => mongoose.isValidObjectId(val), { message: 'Invalid room ID' });

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(128, 'Password must be at most 128 characters'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(10, 'New password must be at least 10 characters')
    .max(128, 'New password must be at most 128 characters'),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const messagesQuerySchema = z.object({
  before: z.string().datetime({ message: 'Invalid before cursor' }).optional(),
  after: z.string().datetime({ message: 'Invalid after cursor' }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  roomId: objectIdSchema.optional(),
});

export const attachmentSchema = z.object({
  key: z.string().min(1).max(300),
  name: z.string().trim().min(1, 'Attachment name is required').max(255),
  contentType: z.enum(ALLOWED_MIME_KEYS, { message: 'Unsupported file type' }),
  size: z
    .number()
    .int()
    .min(1, 'File cannot be empty')
    .max(MAX_UPLOAD_BYTES, 'File exceeds 10 MB limit'),
});

export const presignUploadSchema = z.object({
  roomId: objectIdSchema,
  filename: z.string().trim().min(1, 'Filename is required').max(255),
  contentType: z.enum(ALLOWED_MIME_KEYS, { message: 'Unsupported file type' }),
  size: z
    .number()
    .int()
    .min(1, 'File cannot be empty')
    .max(MAX_UPLOAD_BYTES, 'File exceeds 10 MB limit'),
});

export const messageSendSchema = z
  .object({
    text: z.string().trim().max(2000, 'Message cannot exceed 2000 characters').optional().default(''),
    roomId: objectIdSchema.optional(),
    attachments: z.array(attachmentSchema).max(4, 'Maximum 4 attachments per message').optional().default([]),
  })
  .refine((data) => data.text.length > 0 || data.attachments.length > 0, {
    message: 'Message cannot be empty',
  });

export const messageReadSchema = z.object({
  messageIds: z
    .array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid message ID'))
    .min(1)
    .max(100),
  roomId: objectIdSchema.optional(),
});

export const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, 'Room name must be at least 3 characters')
    .max(30, 'Room name must be at most 30 characters')
    .regex(
      /^[a-zA-Z0-9 _-]+$/,
      'Room name may only contain letters, numbers, spaces, hyphens, and underscores'
    ),
  type: z.enum(['public', 'private']),
  memberIds: z.array(objectIdSchema).max(50).optional().default([]),
});

export const createDmSchema = z.object({
  userId: objectIdSchema,
});

export const inviteMembersSchema = z.object({
  memberIds: z.array(objectIdSchema).min(1, 'Select at least one user').max(50),
});

export const publicRoomsQuerySchema = z.object({
  q: z.string().trim().max(50).optional().default(''),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const userSearchQuerySchema = z.object({
  q: z.string().trim().max(30).optional().default(''),
});

export const messageEditSchema = z.object({
  roomId: objectIdSchema,
  messageId: z.string().refine((val) => mongoose.isValidObjectId(val), {
    message: 'Invalid message ID',
  }),
  text: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message cannot exceed 2000 characters'),
});

export const messageDeleteSchema = z.object({
  roomId: objectIdSchema,
  messageId: z.string().refine((val) => mongoose.isValidObjectId(val), {
    message: 'Invalid message ID',
  }),
});

export const roomChangesQuerySchema = z.object({
  since: z.string().datetime({ message: 'Invalid since cursor' }),
});

export const reactionToggleSchema = z.object({
  roomId: objectIdSchema,
  messageId: z.string().refine((val) => mongoose.isValidObjectId(val), {
    message: 'Invalid message ID',
  }),
  emoji: z.enum(ALLOWED_REACTIONS, { message: 'Unsupported reaction emoji' }),
});

export const roomSummarySchema = z.object({
  sinceMessageId: z
    .string()
    .refine((val) => mongoose.isValidObjectId(val), { message: 'Invalid sinceMessageId' })
    .optional(),
  force: z.boolean().optional().default(false),
});

export const twoFactorCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit verification code'),
});

export const twoFactorVerifySchema = z
  .object({
    mfaToken: z.string().min(1, 'MFA token is required'),
    code: z.string().trim().optional(),
    recoveryCode: z.string().trim().optional(),
  })
  .refine((d) => Boolean(d.code || d.recoveryCode), {
    message: 'Verification code or recovery code is required',
  });

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit verification code'),
});
