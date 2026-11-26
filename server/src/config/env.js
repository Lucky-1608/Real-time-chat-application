import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    JWT_SECRET: z
      .string()
      .min(32, 'JWT_SECRET must be at least 32 characters long for HS256 security'),
    CLIENT_URL: z.string().url('CLIENT_URL must be a valid URL (e.g. http://localhost:5173)'),

    // Optional S3-compatible storage credentials (AWS S3 / Cloudflare R2).
    // If any S3_* variable is set, all required S3 credentials must be present.
    S3_ENDPOINT: z.string().url().optional().or(z.literal('')),
    S3_REGION: z.string().min(1).default('auto'),
    S3_BUCKET: z.string().optional().default(''),
    S3_ACCESS_KEY_ID: z.string().optional().default(''),
    S3_SECRET_ACCESS_KEY: z.string().optional().default(''),

    // Optional: Anthropic Claude API for room summaries (never exposed to client)
    ANTHROPIC_API_KEY: z.string().optional().default(''),
    ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),

    // Session & token lifetimes
    ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    REFRESH_IDLE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    REFRESH_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(10_000),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),

    // Password hashing (argon2id) & HIBP breached-password check
    ARGON2_MEMORY_KB: z.coerce.number().int().min(16384).default(65536),
    ARGON2_TIME_COST: z.coerce.number().int().min(1).default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),
    PASSWORD_PEPPER: z.string().optional().default(''),
    HIBP_ENABLED: z.enum(['true', 'false']).default('true'),

    // Field-level encryption (AES-256-GCM) with key ID for rotation
    ENCRYPTION_KEY_ID: z.string().min(1).default('k1'),
    ENCRYPTION_KEY: z
      .string()
      .min(32, 'ENCRYPTION_KEY must be at least 32 characters for AES-256-GCM'),
    ENCRYPTION_PREVIOUS_KEYS: z.string().optional().default(''),

    // Flood control
    NEW_ACCOUNT_RESTRICTION_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),
  })
  .superRefine((data, ctx) => {
    const anyS3Set = Boolean(
      data.S3_ENDPOINT || data.S3_BUCKET || data.S3_ACCESS_KEY_ID || data.S3_SECRET_ACCESS_KEY
    );
    if (anyS3Set) {
      if (!data.S3_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_BUCKET'],
          message: 'S3_BUCKET is required when S3 storage is configured',
        });
      }
      if (!data.S3_ACCESS_KEY_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_ACCESS_KEY_ID'],
          message: 'S3_ACCESS_KEY_ID is required when S3 storage is configured',
        });
      }
      if (!data.S3_SECRET_ACCESS_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_SECRET_ACCESS_KEY'],
          message: 'S3_SECRET_ACCESS_KEY is required when S3 storage is configured',
        });
      }
    }
  });

/**
 * Validates raw environment variables against the schema.
 * Extracted as a pure function so startup validation can be unit-tested
 * without terminating the test runner process.
 */
export function parseEnv(rawEnv) {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }

  return result.data;
}

let env;
try {
  env = parseEnv(process.env);
} catch (err) {
  console.error(err.message);
  // Fail fast on startup so misconfigured deployments never accept traffic.
  process.exit(1);
}

export default env;
