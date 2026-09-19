import { describe, expect, it } from 'vitest';
import { APP_NAME, aboutHtml, privacyHtml, robotsTxt, termsHtml } from '../src/lib/public-pages';
import { PUBLIC_PATHS } from '../src/lib/hosted-auth';

/** These assertions encode Google's OAuth brand-verification requirements, so a regression fails here, not a day later in the Verification Center. */
describe('public pages for OAuth brand verification', () => {
  const pages = { about: aboutHtml(), privacy: privacyHtml(), terms: termsHtml() };
  it('serves script-free documents without external subresources', () => {
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<link[^>]+href="https?:\/\/(?!zecori\.befeast\.com)/i);
      expect(html).not.toMatch(/src="https?:\/\//i);
    }
  });
  it('names the app exactly in the about page title and heading, and describes what it does', () => {
    expect(pages.about).toContain(`<title>${APP_NAME}</title>`);
    expect(pages.about).toContain(`<h1>${APP_NAME}</h1>`);
    expect(pages.about).toContain(`og:site_name" content="${APP_NAME}"`);
    expect(pages.about).toMatch(/subscriptions|allowance|usage/);
    expect(pages.about).not.toMatch(/Sign in to open the books/);
  });
  it('links the absolute privacy and terms URLs on every page', () => {
    for (const html of Object.values(pages)) {
      expect(html).toContain('href="https://zecori.befeast.com/privacy"');
      expect(html).toContain('href="https://zecori.befeast.com/terms"');
    }
  });
  it('allows crawlers and is reachable without a session', () => {
    expect(robotsTxt()).toBe('User-agent: *\nAllow: /\n');
    for (const path of ['/about', '/privacy', '/terms', '/robots.txt']) expect(PUBLIC_PATHS).toContain(path);
  });
});
