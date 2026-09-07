import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI bills — subscriptions & usage',
  description: 'Your AI subscriptions, renewal dates, costs and usage in one place.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
