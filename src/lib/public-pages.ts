/** Public, server-rendered, script-free pages for OAuth brand verification and plain reading.
 * Google's checker reads the raw document: the app name in <title> and <h1> must equal the
 * consent-screen name exactly, the page must describe what the app does (not only a login),
 * and the privacy link must equal the one entered in Branding. No <script>, no external
 * subresources; Next.js pages would emit hydration scripts, so these are route handlers. */
export const APP_NAME = 'Zecori';
export const PUBLIC_ORIGIN = () => (process.env.AI_BILLS_PUBLIC_ORIGIN || 'https://zecori.befeast.com').replace(/\/$/, '');
export const CONTACT_EMAIL = 'support@befeast.com';

const css = `body{margin:0;background:#f5f7fb;color:#0c1424;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:720px;margin:0 auto;padding:40px 20px 64px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}p,li{margin:0 0 12px}a{color:#163065}nav{font-size:14px;margin-bottom:24px}footer{margin-top:40px;padding-top:16px;border-top:1px solid #dfe5ee;font-size:14px;color:#4b586c}`;

export function page(title: string, body: string, description: string): string {
  const origin = PUBLIC_ORIGIN();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${title}">
<meta name="robots" content="index, follow">
<link rel="icon" href="${origin}/favicon.ico">
<style>${css}</style>
</head>
<body>
<main>
<nav><a href="${origin}/about">About</a> · <a href="${origin}/privacy">Privacy policy</a> · <a href="${origin}/terms">Terms of service</a> · <a href="${origin}/">Sign in</a></nav>
${body}
<footer>${APP_NAME} by BeFeast · <a href="${origin}/privacy">Privacy policy</a> · <a href="${origin}/terms">Terms of service</a> · Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></footer>
</main>
</body>
</html>
`;
}

export const aboutHtml = () => page(APP_NAME, `
<h1>${APP_NAME}</h1>
<p>${APP_NAME} is a dashboard that keeps the books on the AI services a person or a small team pays for: subscriptions and their renewal dates, real payments, prepaid credits, the allowance that is still left on each provider account, when each limit window resets, and how usage is spread across tools and models.</p>
<h2>What it does</h2>
<ul>
<li>Shows, for every connected AI account, which limit window is constraining it right now and how much of it is left.</li>
<li>Lists subscriptions with their price, billing period and next renewal or end date, and links to the provider's billing pages.</li>
<li>Records usage as an append-only ledger of token counts and turns it into an API-equivalent estimate that is shown separately from actual payments.</li>
<li>Raises notifications when an allowance runs low, a provider rate-limits requests, a renewal is close, or a data source stops reporting.</li>
</ul>
<h2>How it gets its data</h2>
<p>A collector that the operator runs on their own machines gathers provider quota observations, usage records and subscription details and sends a consolidated snapshot to the dashboard. ${APP_NAME} does not move money, does not place orders with providers, and does not route or execute AI requests.</p>
<h2>Signing in</h2>
<p>Access is by invitation. Sign-in is handled by Clerk; with Google sign-in, ${APP_NAME} receives only your name, email address and profile picture, and uses the email address to decide whether you are on the instance's access list.</p>
<p>Privacy policy: <a href="${PUBLIC_ORIGIN()}/privacy">${PUBLIC_ORIGIN()}/privacy</a> · Terms of service: <a href="${PUBLIC_ORIGIN()}/terms">${PUBLIC_ORIGIN()}/terms</a></p>
`, `${APP_NAME} keeps the books on AI subscriptions, payments, prepaid credits, remaining quota, resets and renewals.`);

export const privacyHtml = () => page(`Privacy policy — ${APP_NAME}`, `
<h1>Privacy policy</h1>
<p>This policy describes what ${APP_NAME} (operated by BeFeast, contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>) stores and why. Last updated 19 September 2026.</p>
<h2>Sign-in data</h2>
<p>Authentication is provided by Clerk. When you sign in with Google or with an email code, ${APP_NAME} receives your email address, your name and your profile picture. The email address is compared with the instance's access list on every request; nothing else from your Google account is requested or stored, and ${APP_NAME} does not read your Google data.</p>
<h2>Operational data</h2>
<p>An instance holds the operator's own accounting data: the names and email addresses of the provider accounts the operator connected, quota observations from those providers, subscription entries (plan, price, renewal date), payment records the operator imported, aggregated usage counts (tokens and requests by client, model and account) and the state of alert rules. Provider passwords, OAuth tokens and API keys never reach the dashboard; identifiers that look like keys are stored as fingerprints.</p>
<h2>Cookies</h2>
<p>Clerk sets a session cookie so that you stay signed in, and ${APP_NAME} keeps your chosen colour scheme in your browser's local storage. There are no advertising or analytics cookies.</p>
<h2>Retention and location</h2>
<p>The consolidated snapshot is replaced each time the collector runs; usage and alert history are append-only files kept for as long as the instance exists. Data is stored on servers operated by BeFeast in the European Union. Removing your address from the access list ends your access immediately; the operator can delete an instance and its data on request.</p>
<h2>Sharing</h2>
<p>Data is not sold and not shared with third parties other than Clerk (authentication) and, for Google sign-in, Google. Notifications, when enabled by the operator, are sent to the operator's own notification service.</p>
<h2>Contact</h2>
<p>Questions about this policy: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`, `How ${APP_NAME} handles sign-in data, operational accounting data, cookies and retention.`);

export const termsHtml = () => page(`Terms of service — ${APP_NAME}`, `
<h1>Terms of service</h1>
<p>${APP_NAME} is provided by BeFeast (contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>). By signing in you agree to these terms. Last updated 19 September 2026.</p>
<h2>Access</h2>
<p>Access is by invitation of the instance operator and may be withdrawn at any time. You must not share your session with others or attempt to reach data of an instance you were not invited to.</p>
<h2>What the service is</h2>
<p>${APP_NAME} presents the accounting data that the operator's own collector supplies. Figures such as remaining allowance, API-equivalent cost and renewal dates are observations and estimates with the freshness and coverage the dashboard shows beside them; they are not statements of account from a provider and not financial advice.</p>
<h2>Availability and liability</h2>
<p>The service is provided as is, without warranty of uninterrupted availability or of the accuracy of third-party data. To the extent permitted by law, BeFeast is not liable for decisions taken on the basis of the dashboard, nor for indirect or consequential loss.</p>
<h2>Changes</h2>
<p>These terms may change; the date above marks the current version. Continued use after a change means acceptance.</p>
<p>Privacy policy: <a href="${PUBLIC_ORIGIN()}/privacy">${PUBLIC_ORIGIN()}/privacy</a></p>
`, `Terms under which ${APP_NAME} is provided.`);

export const robotsTxt = () => `User-agent: *\nAllow: /\n`;
