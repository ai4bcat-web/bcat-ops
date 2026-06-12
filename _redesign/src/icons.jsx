// Lucide-style icon set, built inline so we have no external dep.
// Each icon: 1.5px stroke, 16x16 viewBox by default.
const Ic = ({ d, size = 16, fill = "none", stroke = "currentColor", sw = 1.6, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...p}>
    {d}
  </svg>
);

const Icons = {
  dashboard: (p) => <Ic {...p} d={<><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>} />,
  calendar: (p) => <Ic {...p} d={<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></>} />,
  loads: (p) => <Ic {...p} d={<><path d="M3 7l9-4 9 4M3 7v10l9 4 9-4V7M3 7l9 4 9-4M12 11v10"/></>} />,
  intake: (p) => <Ic {...p} d={<><path d="M3 7l9 6 9-6"/><rect x="3" y="5" width="18" height="14" rx="2"/></>} />,
  tasks: (p) => <Ic {...p} d={<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>} />,
  drivers: (p) => <Ic {...p} d={<><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15 20c0-2.2 1.5-4 4-4s2 1 2 4"/></>} />,
  fleet: (p) => <Ic {...p} d={<><path d="M3 7h11v10H3zM14 10h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></>} />,
  maintenance: (p) => <Ic {...p} d={<><path d="M14.7 6.3a4 4 0 1 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.3 2.3-2.4-2.4 2.3-2.3z"/></>} />,
  expenses: (p) => <Ic {...p} d={<><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>} />,
  schedules: (p) => <Ic {...p} d={<><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></>} />,
  audit: (p) => <Ic {...p} d={<><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></>} />,
  users: (p) => <Ic {...p} d={<><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></>} />,
  search: (p) => <Ic {...p} d={<><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>} />,
  bell: (p) => <Ic {...p} d={<><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16l-2-2zM10 21a2 2 0 0 0 4 0"/></>} />,
  settings: (p) => <Ic {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>} />,
  plus: (p) => <Ic {...p} d={<><path d="M12 5v14M5 12h14"/></>} />,
  refresh: (p) => <Ic {...p} d={<><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></>} />,
  chevR: (p) => <Ic {...p} d={<path d="M9 18l6-6-6-6"/>} />,
  chevL: (p) => <Ic {...p} d={<path d="M15 18l-6-6 6-6"/>} />,
  chevD: (p) => <Ic {...p} d={<path d="M6 9l6 6 6-6"/>} />,
  chevU: (p) => <Ic {...p} d={<path d="M18 15l-6-6-6 6"/>} />,
  x: (p) => <Ic {...p} d={<><path d="M18 6L6 18M6 6l12 12"/></>} />,
  check: (p) => <Ic {...p} d={<path d="M20 6L9 17l-5-5"/>} />,
  copy: (p) => <Ic {...p} d={<><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>} />,
  ext: (p) => <Ic {...p} d={<><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></>} />,
  trash: (p) => <Ic {...p} d={<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>} />,
  edit: (p) => <Ic {...p} d={<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>} />,
  eye: (p) => <Ic {...p} d={<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>} />,
  phone: (p) => <Ic {...p} d={<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.5 2.1l-1.3 1.3a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2z"/>} />,
  mail: (p) => <Ic {...p} d={<><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 7L2 7"/></>} />,
  msg: (p) => <Ic {...p} d={<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>} />,
  pin: (p) => <Ic {...p} d={<><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></>} />,
  truck: (p) => <Ic {...p} d={<><rect x="1" y="6" width="14" height="10" rx="1.5"/><path d="M15 9h4l3 3v4h-7"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>} />,
  trailer: (p) => <Ic {...p} d={<><rect x="2" y="6" width="20" height="10" rx="1.5"/><circle cx="8" cy="18" r="2"/><circle cx="16" cy="18" r="2"/></>} />,
  fuel: (p) => <Ic {...p} d={<><path d="M3 22V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v18M3 22h11"/><path d="M14 9h3a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2V8L19 5"/><path d="M7 9h2"/></>} />,
  alert: (p) => <Ic {...p} d={<><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></>} />,
  info: (p) => <Ic {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></>} />,
  filter: (p) => <Ic {...p} d={<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z"/>} />,
  download: (p) => <Ic {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></>} />,
  upload: (p) => <Ic {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></>} />,
  arrowR: (p) => <Ic {...p} d={<path d="M5 12h14M13 5l7 7-7 7"/>} />,
  arrowU: (p) => <Ic {...p} d={<path d="M12 19V5M5 12l7-7 7 7"/>} />,
  arrowD: (p) => <Ic {...p} d={<path d="M12 5v14M19 12l-7 7-7-7"/>} />,
  dollar: (p) => <Ic {...p} d={<><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>} />,
  box: (p) => <Ic {...p} d={<><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></>} />,
  invoice: (p) => <Ic {...p} d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>} />,
  pulse: (p) => <Ic {...p} d={<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>} />,
  more: (p) => <Ic {...p} d={<><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></>} />,
  collapse: (p) => <Ic {...p} d={<><path d="M3 12h18M3 6h18M3 18h18"/></>} />,
  command: (p) => <Ic {...p} d={<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>} />,
  zap: (p) => <Ic {...p} d={<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>} />,
  spark: (p) => <Ic {...p} d={<path d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.5-6.3 4.5 2.3-7.2L2 9.4h7.6z"/>} />,
};

window.Icons = Icons;
