// The light/dark switch, shared by the landing page and the docs. The page follows
// the system setting until the visitor clicks the button; then their choice is kept
// in localStorage ('dotpals.theme') and set as <html data-theme>. The inline script
// at the top of each page's <head> applies a saved choice before anything paints.

const KEY = 'dotpals.theme';
const root = document.documentElement;
const osLight = matchMedia('(prefers-color-scheme: light)');
const current = () => (['light', 'dark'].includes(root.dataset.theme) ? root.dataset.theme : osLight.matches ? 'light' : 'dark');

function sync() {
  const label = `Switch to ${current() === 'light' ? 'dark' : 'light'} theme`;
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  // The browser bar follows the page, not only the system setting.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = bg;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.theme-toggle')) return;
  const theme = current() === 'light' ? 'dark' : 'light';
  root.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch {}
  sync();
});
osLight.addEventListener?.('change', sync);
sync();
