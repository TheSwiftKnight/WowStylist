import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WowStylist — 靈感板",
  description: "收藏夾、style 風向標、年度總結，釘在同一面牆上。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;600&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Noto+Serif+TC:wght@300;400;500;600&family=Special+Elite&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
