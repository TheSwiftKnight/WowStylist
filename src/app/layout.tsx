import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "收藏的靈感",
  description: "從 LINE 分享進來的 Instagram 貼文與 Reels",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
