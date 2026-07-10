function renderTabbar(active) {
  const tabs = [
    { href: 'index.html', icon: '⛳', label: 'Play' },
    { href: 'players.html', icon: '🏆', label: 'Players' },
    { href: 'courses.html', icon: '📋', label: 'Courses' },
    { href: 'export.html', icon: '⬇︎', label: 'Backup' },
  ];
  const html = tabs.map(t => `
    <a href="${t.href}" class="${t.href === active ? 'active' : ''}">
      <span class="icon">${t.icon}</span>
      <span>${t.label}</span>
    </a>
  `).join('');
  document.body.insertAdjacentHTML('beforeend', `<nav class="tabbar">${html}</nav>`);
}

function showToast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
