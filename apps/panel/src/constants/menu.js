

export const SYSTEM_MENUS = [
  { key: '1', label: 'home', icon: <i className='bi bi-house-door'/>, route: '/panel/home' },
  { key: '0', label: 'roles', icon: <i className='bi bi-shield-check'/>, route: '/panel/roles', action: 'read', subject: 'Role' },
  { key: '2', label: 'organizations', icon: <i className='bi bi-grid-1x2'/>, route: '/panel/organs', action: 'read', subject: 'Organization' },
  { key: '3', label: 'users', icon: <i className='bi bi-people'/>, route: '/panel/users', action: 'read', subject: 'User' },
  { key: '10', label: 'settings', icon: <i className='bi bi-gear'/>, route: '/panel/settings' },
];