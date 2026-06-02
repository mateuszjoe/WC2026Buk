import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages: ustaw base na "/NAZWA_REPOZYTORIUM/", np. "/WC2026Buk/".
  // Dla strony user/organization pages zostaw "/".
  base: "/WC2026Buk/"
});
