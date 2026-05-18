/** @type {import('tailwindcss').Config} */
const defaultTheme = require("tailwindcss/defaultTheme");
const scrollbarPlugin = require("tailwind-scrollbar");

module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    screens: {
      xxs: "375px",
      xs: "425px",

      ...defaultTheme.screens,
    },
    extend: {
      animation: {
        text: "text 5s ease infinite",
      },
      keyframes: {
        text: {
          "0%, 100%": {
            "background-size": "200% 200%",
            "background-position": "left center",
          },
          "50%": {
            "background-size": "200% 200%",
            "background-position": "right center",
          },
        },
      },
      boxShadow: {
        menu: "0 0 10px 0px rgba(255, 107, 0, 0.1)",
        light: "0 2px 10px 2px rgba(0, 0, 0, 0.1)",
        button: "0 0px 5px 0.5px rgba(0, 0, 0, 0.1)",
        poster: "0 8px 32px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)",
        glow: "0 0 24px rgba(233, 69, 96, 0.35)",
      },
      borderRadius: {
        card: "12px",
        poster: "8px",
        badge: "5px",
      },
      textColor: {
        "gray-500": "#6c757d",
      },
      fontWeight: {
        bold: "700",
      },
      padding: {
        nav: "5.3rem",
      },
      colors: {
        // Single source of truth: lib/theme.ts. Edit there to rebrand.
        // `primary` aligned on the info page background (#0c0d10) so the
        // home/index, watch page and info page share one black.
        primary: "#0c0d10",
        secondary: "#212127",
        action: "var(--brand-primary, #E94560)",
        image: "#3B3C41",
        txt: "var(--text-body, #dbdcdd)",
        tersier: "var(--surface-tertiary, #0c0d10)",
        as: {
          bg: "var(--surface-bg, #0e0e16)",
          card: "var(--surface-card, #1a1a24)",
          surface: "var(--surface-surface, #22222e)",
          accent: "var(--brand-primary, #E94560)",
          accent2: "var(--brand-secondary, #FF7F57)",
          score: "#FFD700",
          episodes: "#0F3460",
          watching: "#10B981",
          rewatching: "#06B6D4",
          completed: "#3B82F6",
          planning: "#A855F7",
          paused: "#F59E0B",
          dropped: "#EF4444",
        },
      },
    },
    fontFamily: {
      outfit: ["Outfit", "sans-serif"],
      karla: ["Karla", "sans-serif"],
      roboto: ["Roboto", "sans-serif"],
      inter: ["Inter", "sans-serif"],
    },
  },
  variants: {
    extend: {
      display: ["group-focus"],
      opacity: ["group-focus"],
      inset: ["group-focus"],
      backgroundImage: ["dark"],
    },
    textColor: ["responsive", "hover", "focus"],
    fontWeight: ["responsive", "hover", "focus"],
    scrollbar: ["rounded"],
  },
  plugins: [
    scrollbarPlugin({
      nocompatible: true,
    }),
    require("tailwind-scrollbar-hide"),
    require("@vidstack/react/tailwind.cjs")({
      // Change the media variants prefix.
      prefix: "media",
    }),
    require("tailwindcss-animate"),
    customVariants,
  ],
};

function customVariants({ addVariant, matchVariant }) {
  // Strict version of `.group` to help with nesting.
  matchVariant("parent-data", (value) => `.parent[data-${value}] > &`);
  addVariant("hocus", ["&:hover", "&:focus-visible"]);
  addVariant("group-hocus", [".group:hover &", ".group:focus-visible &"]);
}
