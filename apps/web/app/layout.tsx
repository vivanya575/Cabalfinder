import type { Metadata } from "next";
import { Anton, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const displayFont = Anton({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400"
});

const bodyFont = IBM_Plex_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"]
});

const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"]
});

export const metadata: Metadata = {
  title: "Cabalfinder // Helius Signal Desk",
  description: "Helius-native Solana holder intelligence dashboard for active scans, wallet-cluster analysis, and future agent workflows."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}>{children}</body>
    </html>
  );
}
