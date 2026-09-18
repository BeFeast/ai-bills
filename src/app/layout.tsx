import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI bills — subscriptions & usage',
  description: 'Your AI subscriptions, renewal dates, costs and usage in one place.',
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
