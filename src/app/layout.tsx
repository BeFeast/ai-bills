import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zecori — your AI treasurer',
  applicationName: 'Zecori',
  description: 'Zecori keeps the books on your AI resources: subscriptions, payments, prepaid credits, remaining quota, resets and upcoming renewals. By BeFeast.',
};

// Applies the persisted scheme before first paint so a dark reload does not flash light.
const themeScript = "(function(){try{if(localStorage.getItem('ai-bills-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}})()";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
