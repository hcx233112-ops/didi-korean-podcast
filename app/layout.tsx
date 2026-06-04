import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Didi Korean Podcast",
  description: "Didi Korean Podcast 播客播放器，锁屏不断播",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Didi Podcast" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className="h-full">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
