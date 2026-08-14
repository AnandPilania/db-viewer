/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(240 4% 20%)",
        input: "hsl(240 4% 20%)",
        ring: "hsl(200 90% 55%)",
        background: "hsl(240 6% 8%)",
        foreground: "hsl(0 0% 95%)",
        muted: {
          DEFAULT: "hsl(240 4% 16%)",
          foreground: "hsl(240 3% 65%)",
        },
        accent: {
          DEFAULT: "hsl(200 90% 55%)",
          foreground: "hsl(240 6% 8%)",
        },
        card: {
          DEFAULT: "hsl(240 5% 11%)",
          foreground: "hsl(0 0% 95%)",
        },
        destructive: {
          DEFAULT: "hsl(0 70% 55%)",
          foreground: "hsl(0 0% 98%)",
        },
      },
      borderRadius: {
        lg: "8px",
        md: "6px",
        sm: "4px",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
