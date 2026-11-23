import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Didi Korean Podcast",
  description: "韩语播客，锁屏不断播",
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Didi播客', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: '#0b0b10',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className="h-full">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
