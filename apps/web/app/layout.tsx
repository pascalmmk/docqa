import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "DocQA",
  description: "Upload documents, ask questions, get cited answers.",
};

// Set the theme before first paint to avoid a flash of the wrong theme.
const themeInit = `
try {
  var t = localStorage.getItem("docqa-theme");
  if (!t) t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
