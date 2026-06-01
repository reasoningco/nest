import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#141413",
          700: "#3a3a37",
          500: "#6b6b66",
          300: "#c9c7c0",
          100: "#eceae3",
          50: "#f5f3ec",
        },
        surface: {
          DEFAULT: "#faf9f5",
          raised: "#ffffff",
        },
        accent: {
          DEFAULT: "#c15f3c",
          soft: "#e8dccb",
        },
      },
      borderWidth: {
        hairline: "0.5px",
      },
      borderRadius: {
        lg: "14px",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontWeight: {
        normal: "400",
        medium: "500",
      },
    },
  },
  plugins: [],
};

export default config;
