// Shared decorative action icons. The owning control supplies its accessible name.
const paths = {
  close: 'M6 6l12 12M6 18L18 6',
  plus: 'M12 5v14M5 12h14',
  more: 'M12 5v.01M12 12v.01M12 19v.01',
  menu: 'M4 6h16M4 12h16M4 18h16',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  image: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M16 7h.01',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-3a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v3',
  bot: 'M5 7h14v14H5zM12 7V3M9 13h.01M15 13h.01M9 17h6M2 11v6M22 11v6',
  check: 'M5 12l4 4L19 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9',
  upload: 'M12 16V3M7 8l5-5 5 5M4 16v5h16v-5',
  'arrow-up': 'M12 20V4M5 11l7-7 7 7',
  'arrow-down': 'M12 4v16M5 13l7 7 7-7',
  'arrow-left': 'M20 12H4M11 5l-7 7 7 7',
  'arrow-right': 'M4 12h16M13 5l7 7-7 7',
  'external-link': 'M14 3h7v7M21 3L10 14M10 5H4v15h15v-6',
  maximize: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5',
  minimize: 'M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3',
  edit: 'M15 5l4 4M4 20l5-1L21 7l-4-4L5 15z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  terminal: 'M3 4h18v16H3zM7 8l4 4-4 4M13 16h4',
  tool: 'M14 3a6 6 0 0 0-7 8l-4 4a3 3 0 0 0 4 4l4-4a6 6 0 0 0 8-7l-4 4-3-3z',
  folder: 'M3 7V4h6l3 3h9v13H3z',
  'folder-open': 'M3 20V4h6l3 3h8v4M3 20l4-9h15l-4 9z',
  file: 'M14 3H5v18h14V8zM14 3v5h5',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a4 9 0 0 1 0 18 4 9 0 0 1 0-18',
  settings: 'M9 3h6v2l2 1 2-1 3 5-2 1v2l2 1-3 5-2-1-2 1v2H9v-2l-2-1-2 1-3-5 2-1v-2l-2-1 3-5 2 1 2-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  star: 'M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[name]} />
  </svg>;
}
