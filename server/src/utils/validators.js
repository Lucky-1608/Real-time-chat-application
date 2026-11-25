import { z } from 'zod';

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
  roomId: z.string().trim().min(1).max(64).default('global'),
});

export const messageSendSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message cannot exceed 2000 characters'),
  roomId: z.string().trim().min(1).max(64).default('global'),
});
