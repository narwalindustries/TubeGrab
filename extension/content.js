const TOOL = 'http://localhost:3000';   // <-- apne server ka URL yahan daalo
const idFrom = href => { try { const u = new URL(href, location.origin);
  if (u.pathname === '/watch') return u.searchParams.get('v');
  if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2]; } catch {} return null; };
const open = id => window.open(`${TOOL}/?dl=${id}`, '_blank');

function decorate() {
  document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]').forEach(a => {
    if (!a.querySelector('img, yt-image, .yt-core-image')) return;
    const id = idFrom(a.href); if (!id) return;
    let b = a.querySelector('.tg-btn');
    if (b && a.dataset.tgId === id) return;
    if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
    if (!b) {
      b = document.createElement('button'); b.className = 'tg-btn'; b.textContent = '⬇ Download';
      a.appendChild(b);
    }
    a.dataset.tgId = id;
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); open(id); };
  });
  let f = document.querySelector('.tg-float');
  const cur = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  if (cur && !f) { f = document.createElement('button'); f.className = 'tg-float'; f.textContent = '⬇ Download';
    f.onclick = () => open(new URLSearchParams(location.search).get('v')); document.body.appendChild(f); }
  if (!cur && f) f.remove();
}
new MutationObserver(decorate).observe(document.documentElement, { childList: true, subtree: true });
decorate();
