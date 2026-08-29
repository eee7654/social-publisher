/** @type {import('tailwindcss').Config} */
const svgToDataUri = require("mini-svg-data-uri");
const { default: flattenColorPalette } = require("tailwindcss/lib/util/flattenColorPalette");
const themeColors = require("./src/constants/colors"); // 👈 ایمپورت رنگ‌ها
const plugin = require("tailwindcss/plugin");

module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bgBase: 'var(--bg-base)',
        bgSurface: 'var(--bg-surface)',
        textBase: 'var(--text-base)',
        textMuted: 'var(--text-muted)',
        textSecondary: 'var(--text-muted)', // نام مستعار
        primary: 'var(--color-primary)',
        primaryActive: 'var(--color-primary-active)',
        accent: 'var(--color-accent)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        borderColor: 'var(--color-border)',
      },
      fontFamily: {
        iransans: [
          'var(--font-iran-sans)', 
          { fontFeatureSettings: '"ss02"' }
        ],
        opensans: ['var(--font-open-sans)', 'sans-serif']
      },
      animation: {
        aurora: "aurora 60s linear infinite",
        spin: 'spin 2s linear infinite',
        pulseScale: 'pulseScale 2s ease-in-out infinite',
      },
      keyframes: {
        aurora: {
          from: { backgroundPosition: "50% 50%, 50% 50%" },
          to: { backgroundPosition: "350% 50%, 350% 50%" },
        },
        spin: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' }
        },
        pulseScale: {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.05)', opacity: '0.5' },
        },
      },
    },
  },
  plugins: [
    // 🚀 پلاگین جدید ما برای تزریق اتوماتیک متغیرهای CSS
    plugin(function({ addBase }) {
      addBase({
        ':root': {
          '--bg-base': themeColors.light.bgBase,
          '--bg-surface': themeColors.light.bgSurface,
          '--text-base': themeColors.light.textBase,
          '--text-muted': themeColors.light.textMuted,
          '--color-primary': themeColors.light.primary,
          '--color-primary-active': themeColors.light.primaryActive,
          '--color-accent': themeColors.light.accent,
          '--color-success': themeColors.light.success,
          '--color-warning': themeColors.light.warning,
          '--color-border': themeColors.light.border,
        },
        '.dark': {
          '--bg-base': themeColors.dark.bgBase,
          '--bg-surface': themeColors.dark.bgSurface,
          '--text-base': themeColors.dark.textBase,
          '--text-muted': themeColors.dark.textMuted,
          '--color-primary': themeColors.dark.primary,
          '--color-primary-active': themeColors.dark.primaryActive,
          '--color-accent': themeColors.dark.accent,
          '--color-success': themeColors.dark.success,
          '--color-warning': themeColors.dark.warning,
          '--color-border': themeColors.dark.border,
        }
      })
    }),
    addVariablesForColors, // پلاگین قبلی خودت
    function ({ matchUtilities, theme }) {
      matchUtilities(
        {
          "bg-grid": (value) => ({
            backgroundImage: `url("${svgToDataUri(
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="${value}"><path d="M0 .5H31.5V32"/></svg>`
            )}")`,
          }),
          "bg-grid-small": (value) => ({
            backgroundImage: `url("${svgToDataUri(
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="8" height="8" fill="none" stroke="${value}"><path d="M0 .5H31.5V32"/></svg>`
            )}")`,
          }),
          "bg-dot": (value) => ({
            backgroundImage: `url("${svgToDataUri(
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16" fill="none"><circle fill="${value}" id="pattern-circle" cx="10" cy="10" r="1.6257413380501518"></circle></svg>`
            )}")`,
          }),
        },
        { values: flattenColorPalette(theme("backgroundColor")), type: "color" }
      );
    },
  ],
};

function addVariablesForColors({ addBase, theme }) {
  let allColors = flattenColorPalette(theme("colors"));
  let newVars = Object.fromEntries(
    Object.entries(allColors).map(([key, val]) => [`--tw-clr-${key}`, val])
  );
  addBase({ ":root": newVars });
}