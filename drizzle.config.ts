import { defineConfig } from 'drizzle-kit';

/** `npx drizzle-kit generate` writes SQL migrations into drizzle/; the app applies them at boot (src/lib/db.ts). */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost/zecori' },
});
