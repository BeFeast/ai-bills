import { expect, test } from 'vitest';
import { canOpenAccountBrowser } from '../src/lib/account-browser-types';

test('failed acquisition never opens an idle profile URL, but a live browser can request sign-in', () => {
  const remoteUrl = 'https://browser.example.test/vnc.html';
  expect(canOpenAccountBrowser({ status: 'unavailable', remoteUrl }, 503)).toBe(false);
  expect(canOpenAccountBrowser({ status: 'unavailable', remoteUrl }, 409)).toBe(false);
  expect(canOpenAccountBrowser({ status: 'ready', remoteUrl }, 500)).toBe(false);
  expect(canOpenAccountBrowser({ status: 'login_required', remoteUrl }, 200)).toBe(true);
  expect(canOpenAccountBrowser({ status: 'identity_unknown', remoteUrl }, 409)).toBe(true);
  expect(canOpenAccountBrowser({ status: 'ready', remoteUrl }, 200)).toBe(true);
});
