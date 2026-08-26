import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cyan: { DEFAULT: "#3bc9ff", bright: "#5ad8ff", deep: "#1aa3e0" },
        ink: { DEFAULT: "#0a1222", panel: "#0e1a30", line: "#1e3a5f" },
        amber: "#ffb02e",
      },
      boxShadow: {
        glow: "0 0 14px rgba(59,201,255,0.45)",
      },
    },
  },
  plugins: [],
};

export default config;
