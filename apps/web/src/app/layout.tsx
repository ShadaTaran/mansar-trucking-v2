import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Mansar Trucking Management System v2',
  description:
    'Admin web application for Mansar Trucking Management System v2.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
