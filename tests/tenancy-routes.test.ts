import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PATHS } from '../src/lib/hosted-auth';

/** Every API route handler except the public ones must decide the tenant before doing anything else. */
const root = join(__dirname, '..', 'src', 'app', 'api');
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? routeFiles(path) : name === 'route.ts' ? [path] : []; });
}
const publicRoutes = new Set(PUBLIC_PATHS.filter(path => path.startsWith('/api/')));
const handlerPattern = /^export (?:async function (GET|POST|PUT|PATCH|DELETE)\b|const (GET|POST|PUT|PATCH|DELETE) = )/gm;

describe('tenant guard on API routes', () => {
  const files = routeFiles(root);
  it('finds the API routes', () => { expect(files.length).toBeGreaterThan(5); });
  for (const file of files) {
    const route = '/' + relative(join(__dirname, '..', 'src', 'app'), file).replace(/\/route\.ts$/, '');
    const source = readFileSync(file, 'utf8');
    if (publicRoutes.has(route)) {
      it(`${route} is public and does not require a tenant`, () => { expect(source).not.toContain('requireTenant'); });
      continue;
    }
    it(`${route} requires the tenant before handling`, () => {
      expect(source).toContain("from '@/lib/tenant'");
      const handlers = [...source.matchAll(handlerPattern)];
      expect(handlers.length).toBeGreaterThan(0);
      // Each exported handler calls the guard itself, or every handler delegates to one function that does (routing's `forward`).
      const guardCalls = (source.match(/await requireTenant\((?:\{ device: true \})?\); if \(forbidden\) return forbidden;/g) ?? []).length;
      const delegating = handlers.filter(match => match[2]).length;
      expect(guardCalls).toBeGreaterThanOrEqual(delegating === handlers.length ? 1 : handlers.length);
    });
    // A device token is read-only by construction: exactly one route may accept it, and it must be the widget.
    it(`${route} ${route === '/api/widget' ? 'accepts' : 'refuses'} a device token`, () => {
      expect(/requireTenant\(\{/.test(source)).toBe(route === '/api/widget');
    });
  }
});
