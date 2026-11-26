export const NAV = [
  {
    label: 'Monitor',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'ports', label: 'Ports', icon: 'ports' },
      { id: 'connections', label: 'Connections', icon: 'connections' },
      { id: 'processes', label: 'Processes', icon: 'processes' },
    ],
  },
  {
    label: 'Organize',
    items: [
      { id: 'projects', label: 'Projects', icon: 'projects' },
      { id: 'planner', label: 'Port Planner', icon: 'planner' },
      { id: 'profiles', label: 'Profiles', icon: 'profiles' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'activity', label: 'Activity', icon: 'activity' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

export const PAGE_IDS = NAV.flatMap((g) => g.items.map((i) => i.id));
