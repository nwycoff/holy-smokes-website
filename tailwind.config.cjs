// The website's Tailwind theme (formerly inline on each page for the Play CDN). Build with `npm run css`.
module.exports = {
  content: ['./index.html', './menu.html', './blog.html', './blog/**/*.html', './server/site/**/*.mjs',
    './assets/menu/**/*.js', './assets/tablet/**/*.js'],
  theme: {
    extend: {
      colors: {
        bark: '#2C1810', 'bark-light': '#4A2C20',
        canopy: '#2D5016', 'canopy-light': '#4A7C28', 'canopy-muted': '#516C40', // section labels: 4.5:1 on cream, white and the header patterns (was #6B8F55)
        moss: '#8BA872', sage: '#B5C5A3', 'sage-light': '#D4DFC8',
        cream: '#F5F0E8', 'cream-dark': '#EDE5D6',
        amber: '#C8943E', 'amber-light': '#E0B860',
      },
      fontFamily: {
        display: ['"DM Serif Display"', 'Georgia', 'serif'],
        body: ['"Outfit"', 'system-ui', 'sans-serif'],
      }
    }
  }
};
