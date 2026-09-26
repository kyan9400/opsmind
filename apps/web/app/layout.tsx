import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsMind",
  description: "AI-powered operations and knowledge platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
