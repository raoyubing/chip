/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        pine: {
          50: "#f4f8f6",
          100: "#e8f0ed",
          500: "#2e7d59",
          700: "#1a6b4a",
          900: "#0f4c3a",
        },
      },
      boxShadow: {
        pine: "0 12px 32px rgba(15, 76, 58, 0.08)",
      },
    },
  },
  plugins: [],
};
