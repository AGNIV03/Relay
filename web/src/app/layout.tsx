import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { PlayerProvider } from "@/context/PlayerContext";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Stream — your music",
  description: "Self-hosted music streaming",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <PlayerProvider>
            <AppShell>{children}</AppShell>
          </PlayerProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
