/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        surface: "#0a0a0a",
        "surface-elevated": "#111111",
        "surface-hover": "#0f0f0f",
        accent: "#ff2b2b",
        muted: "#666666",
      },
      fontFamily: {
        serif: ['"Instrument Serif"', "serif"],
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      animation: {
        "fade-up": "fadeUp 0.8s ease-out both",
        "fade-up-delay": "fadeUp 0.8s ease-out 0.3s both",
        "fade-up-delay-2": "fadeUp 0.8s ease-out 0.5s both",
        "scroll-logs": "scrollLogs 20s linear infinite",
        bounce: "bounce 2s ease-in-out infinite",
        "log-fade-in": "logFadeIn 0.2s ease-out",
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(30px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        scrollLogs: {
          "0%": { transform: "translateY(0)" },
          "100%": { transform: "translateY(-50%)" },
        },
        bounce: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(4px)" },
        },
        logFadeIn: {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
