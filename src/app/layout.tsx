import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI usage + billing',
  description: 'Live LAN dashboard: AI provider usage, quotas and billing.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
