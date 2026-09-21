/**
 * Boot hook (Next.js instrumentation). The database client is Node-only; the import sits inside the
 * runtime check so the edge compilation of this file (forced by the middleware) never sees it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initialiseDatabase } = await import('./instrumentation-node');
    await initialiseDatabase();
  }
}
