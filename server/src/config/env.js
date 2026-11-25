import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters long for HS256 security'),
  CLIENT_URL: z.string().url('CLIENT_URL must be a valid URL (e.g. http://localhost:5173)'),
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
