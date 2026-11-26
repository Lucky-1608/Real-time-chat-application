import { z } from 'zod';
import mongoose from 'mongoose';

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
    .min(6, 'Password must be at least 6 characters')
    .max(128, 'Password must be at most 128 characters'),
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

export const messageSendSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message cannot exceed 2000 characters'),
  roomId: objectIdSchema.optional(),
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
