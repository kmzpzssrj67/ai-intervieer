import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Technical Interviewer",
  description: "Local foundation for an adaptive AI technical interviewer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
