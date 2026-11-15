import { z } from 'zod';

/** Every env var the API needs. The app refuses to start if one is missing/invalid. */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Signs access tokens (refresh tokens are random and stored hashed) */
  JWT_ACCESS_SECRET: z.string().min(32, 'Use at least 32 random characters'),
  /** Set when running behind a proxy/load balancer so rate limits see real IPs */
  TRUST_PROXY: z.stringbool().default(false),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return parsed.data;
}
