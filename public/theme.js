const MANGLET_THEMES = {
  orange: {
    bg: '#17100c',
    sidebar: '#24160f',
    hover: '#382216',
    accent: '#ff8c32'
  },
  black: {
    bg: '#050505',
    sidebar: '#101010',
    hover: '#202020',
    accent: '#ff7a1a'
  },
  midnight: {
    bg: '#0c0c0cff',
    sidebar: '#202020ff',
    hover: '#be4600ff',
    accent: '#df5200ff'
  }
};

function applyMangletTheme(themeName) {
  const t = MANGLET_THEMES[themeName] || MANGLET_THEMES.orange;
  const root = document.documentElement.style;

  root.setProperty('--bg-color', t.bg);
  root.setProperty('--sidebar-color', t.sidebar);
  root.setProperty('--sidebar-hover', t.hover);
  root.setProperty('--token-accent', t.accent);

  try {
    localStorage.setItem('mangletTheme', themeName);
  } catch (e) {}
}

(function () {
  try {
    const cached = localStorage.getItem('mangletTheme');
    applyMangletTheme(
      cached && MANGLET_THEMES[cached] ? cached : 'orange'
    );
  } catch (e) {
    applyMangletTheme('orange');
  }
})();

function showOwnerNav(isOwner) {
  if (!isOwner) return;
  const nav = document.querySelector('.sidebar-nav');
  if (!nav || document.getElementById('ownerNavLink')) return;
  const a = document.createElement('a');
  a.id = 'ownerNavLink';
  a.href = '/owner';
  a.textContent = 'Owner Panel';
  if (window.location.pathname === '/owner') {
    a.classList.add('active');
  }
  nav.appendChild(a);
}