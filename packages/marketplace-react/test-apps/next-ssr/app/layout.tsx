import type { ReactNode } from "react";
import { Providers } from "./providers";

// Server component (App Router root layout). No "use client", no window access.
export const metadata = {
  title: "AgenC marketplace-react SSR fixture",
  description:
    "Next.js 15 App Router SSR fixture proving <AgencProvider> + useListings render with no hydration errors.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
