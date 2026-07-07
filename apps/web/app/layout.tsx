import type { ReactNode } from "react";

export const metadata = {
  title: "DocQA",
  description: "Upload documents, ask questions, get cited answers.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
