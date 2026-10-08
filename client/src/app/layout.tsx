import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";

// Inter: the clean geometric sans of Zoom's web portal. globals.css builds --font-sans from it.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zoom Clone",
  description: "Start, join and schedule video meetings in the browser.",
  applicationName: "Zoom Clone",
};

export const viewport: Viewport = {
  themeColor: "#0b5cff",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // suppressHydrationWarning: the inline script sets data-theme on <html> before React hydrates.
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Applies the saved (or OS) light/dark theme before first paint, so there is no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
