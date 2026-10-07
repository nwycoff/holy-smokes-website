// The three-bar button on the shared site header (assets/menu/nav.css): opens and closes the
// page links on smaller screens.
const toggle = document.querySelector('.th-nav__toggle');
const panel = document.getElementById(toggle?.getAttribute('aria-controls') || '');
if (toggle && panel) {
  const set = open => { panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
  toggle.addEventListener('click', () => set(panel.hidden));
  panel.addEventListener('click', event => { if (event.target.closest('a')) set(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { set(false); toggle.focus(); } });
}
