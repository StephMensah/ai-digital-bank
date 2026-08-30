/* =========================================================================
   AI-DIGITAL BANK ICONS
   One hand-built set, 24×24, stroke-based, inheriting currentColor so a single
   icon works on white, on grey and on matte black. The block / node / chain
   family carries the distributed-ledger motif that runs through the products.
   Usage:  I('send')          → 24px
           I('send', 20)      → sized
           I('send', 20, 2)   → heavier stroke
   ========================================================================= */
const ICONS = {
  /* --- money movement ------------------------------------------------- */
  send:      '<path d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15"/>',
  receive:   '<path d="M17.5 6.5 6.5 17.5M15 17.5H6.5V9"/>',
  swap:      '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  bills:     '<path d="M13 3 5 13.5h5.5L10 21l8-10.5h-5.5L13 3Z"/>',
  airtime:   '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M10.8 18.4h2.4"/>',
  card:      '<rect x="2.5" y="5" width="19" height="14" rx="2.8"/><path d="M2.5 9.7h19M6 15h3.4"/>',
  wallet:    '<path d="M20.5 8.5V7a2 2 0 0 0-2-2H5a2.5 2.5 0 0 0 0 5h13.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2.5 2.5 0 0 1-2.5-2.5V7.5"/><circle cx="16.6" cy="14.5" r="1.1" fill="currentColor" stroke="none"/>',
  cash:      '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>',

  /* --- ledger / blockchain family -------------------------------------- */
  block:     '<path d="M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4L12 2.8Z"/><path d="M12 12.1 20.5 7.4M12 12.1v9.1M12 12.1 3.5 7.4"/>',
  node:      '<path d="M12 3.2 19.4 7.6v8.8L12 20.8 4.6 16.4V7.6L12 3.2Z"/><circle cx="12" cy="12" r="2.2"/><path d="M12 9.8V6.1M14 13.2l3.1 1.9M10 13.2l-3.1 1.9"/>',
  chain:     '<path d="M9.6 14.4a3.6 3.6 0 0 1 0-5l2.1-2.1a3.6 3.6 0 0 1 5.1 5.1l-1 1"/><path d="M14.4 9.6a3.6 3.6 0 0 1 0 5l-2.1 2.1a3.6 3.6 0 0 1-5.1-5.1l1-1"/>',
  ledger:    '<rect x="3" y="4" width="18" height="5" rx="1.6"/><rect x="3" y="10.5" width="18" height="5" rx="1.6"/><rect x="3" y="17" width="18" height="3.5" rx="1.4"/>',
  network:   '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M10.4 7 6.6 15.8M13.6 7l3.8 8.8M7.4 18h9.2"/>',

  /* --- saving & investing ---------------------------------------------- */
  save:      '<path d="M12 3.2 19.4 7.6v8.8L12 20.8 4.6 16.4V7.6L12 3.2Z"/><path d="M9.4 12.2h5.2M12 9.6v5.2"/>',
  invest:    '<path d="M4 17.5 9.5 12l3.4 3.3L20 8"/><path d="M15.4 8H20v4.5"/>',
  goal:      '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  vault:     '<rect x="3" y="4" width="18" height="16" rx="2.4"/><circle cx="12" cy="12" r="3.6"/><path d="M12 8.4V6M12 18v-2.4"/>',
  chart:     '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',

  /* --- people & business ------------------------------------------------ */
  user:      '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  users:     '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0"/><path d="M16.2 5.2a3.2 3.2 0 0 1 0 5.9M17.6 19.5a6.3 6.3 0 0 0-2-4.6"/>',
  invoice:   '<path d="M6 2.8h9.2L19 6.6V21H6a1.2 1.2 0 0 1-1.2-1.2V4a1.2 1.2 0 0 1 1.2-1.2Z"/><path d="M14.6 2.9v4h4M8.4 12.6h7M8.4 16.2h4.6"/>',
  pos:       '<rect x="4" y="2.8" width="16" height="18.4" rx="2.2"/><path d="M7.6 7.2h8.8M7.6 11.4h3M13.4 11.4h3M7.6 15.4h3M13.4 15.4h3"/>',
  briefcase: '<rect x="2.8" y="7" width="18.4" height="13" rx="2.2"/><path d="M8.6 7V5.2A1.8 1.8 0 0 1 10.4 3.4h3.2A1.8 1.8 0 0 1 15.4 5.2V7"/>',

  /* --- utilities & billers ---------------------------------------------- */
  power:     '<path d="M13 2.5 5.5 13.2h5.6L10.5 21.5 18.5 10.8h-5.6L13 2.5Z"/>',
  water:     '<path d="M12 3.2s6 6.2 6 10.1a6 6 0 0 1-12 0C6 9.4 12 3.2 12 3.2Z"/>',
  tv:        '<rect x="2.8" y="5.5" width="18.4" height="12.4" rx="2"/><path d="M8.6 21.2h6.8"/>',
  wifi:      '<path d="M3.4 9.2a13 13 0 0 1 17.2 0M6.6 12.6a8.4 8.4 0 0 1 10.8 0M9.8 16a4 4 0 0 1 4.4 0"/><circle cx="12" cy="19.2" r="1" fill="currentColor" stroke="none"/>',
  school:    '<path d="M12 4 2.8 8.6 12 13.2l9.2-4.6L12 4Z"/><path d="M6.4 10.8v5.1c0 1.6 2.5 3.1 5.6 3.1s5.6-1.5 5.6-3.1v-5.1"/>',
  gov:       '<path d="M3.4 9.6 12 4.4l8.6 5.2"/><path d="M5.6 9.6v8.8M10 9.6v8.8M14 9.6v8.8M18.4 9.6v8.8M3 20.4h18"/>',
  shield:    '<path d="M12 3 5 5.8v5.5c0 4.2 2.9 7.9 7 9.2 4.1-1.3 7-5 7-9.2V5.8L12 3Z"/>',


  /* --- banking & business ------------------------------------------------ */
  bank:      '<path d="M3.2 9.6 12 4.2l8.8 5.4"/><path d="M5.6 11.4v6.4M10 11.4v6.4M14 11.4v6.4M18.4 11.4v6.4"/><path d="M3 20.2h18"/>',
  transfer:  '<rect x="2.6" y="6.4" width="18.8" height="11.2" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.6v.01M18 14.4v.01"/>',
  banknote:  '<rect x="2.6" y="6.4" width="18.8" height="11.2" rx="2"/><circle cx="12" cy="12" r="2.4"/><path d="M5.8 12h.01M18.2 12h.01"/>',
  coins:     '<ellipse cx="9" cy="7" rx="6" ry="2.8"/><path d="M3 7v4c0 1.55 2.69 2.8 6 2.8s6-1.25 6-2.8V7"/><path d="M15 11.4c3.03.2 6 1.4 6 2.9v3.3c0 1.55-2.69 2.8-6 2.8-2.5 0-4.66-.71-5.6-1.72"/><path d="M3 11v4c0 1.55 2.69 2.8 6 2.8"/>',
  piggy:     '<path d="M20.4 12.6c0-3.6-3.6-6.2-8-6.2-1.2 0-2.34.19-3.36.54L6.6 5.2v2.9C4.9 9.2 3.6 10.8 3.6 12.6H2.4v3.4h2c.5.9 1.3 1.68 2.3 2.26V20h2.8v-.86c.62.1 1.26.16 1.9.16.5 0 1-.03 1.48-.1V20h2.8v-1.5c2.28-1.1 3.72-3 3.72-5.2Z"/><circle cx="16.6" cy="12" r=".9" fill="currentColor" stroke="none"/><path d="M12.4 6.5V4.8"/>',
  vault:     '<rect x="2.8" y="4" width="18.4" height="16" rx="2.4"/><circle cx="11" cy="12" r="4"/><path d="M11 8.4V6.6M11 17.4v-1.8M14.6 12h1.8M5.6 12h1.8"/><path d="M18.6 8v8"/>',
  receipt:   '<path d="M5.4 2.8h13.2v18.4l-2.4-1.6-2.2 1.6-2.4-1.6-2.2 1.6-2.4-1.6-1.6 1.1V2.8Z"/><path d="M8.6 8h6.8M8.6 12h6.8M8.6 16h4"/>',
  invoice:   '<path d="M6 2.8h9.2L19 6.6V21H6a1.2 1.2 0 0 1-1.2-1.2V4A1.2 1.2 0 0 1 6 2.8Z"/><path d="M14.6 2.9v4h4M8.4 12.6h7M8.4 16.2h4.6"/>',
  growth:    '<path d="M3.4 17.6 9 12l3.4 3.3 7-7.4"/><path d="M15 8.2h4.6v4.6"/><path d="M3 20.6h18"/>',
  exchange:  '<circle cx="7.6" cy="7.6" r="4.4"/><circle cx="16.4" cy="16.4" r="4.4"/><path d="M12.4 6.2h5.2l-1.8-1.9M11.6 17.8H6.4l1.8 1.9"/>',
  loan:      '<path d="M3.4 14.6a2.1 2.1 0 0 1 2.1-2.1h2.3l2.4 1.7h3.1a1.7 1.7 0 0 1 0 3.4h-3.4"/><path d="M3.4 14.6v5.2M6.6 19.8h6.8l6.4-3.2a1.8 1.8 0 0 0-1.9-3"/><circle cx="15.6" cy="6.4" r="3.6"/>',
  statement: '<path d="M6.4 2.8h8L19 7.4V21H6.4A1.4 1.4 0 0 1 5 19.6V4.2a1.4 1.4 0 0 1 1.4-1.4Z"/><path d="M13.8 2.9v4.2h4.2"/><path d="M8.6 17.4v-3M11.6 17.4v-5.6M14.6 17.4v-2"/>',
  scales:    '<path d="M12 3.6v16.8M7.4 20.4h9.2M4.4 6.6l15.2-1.4"/><path d="M4.4 6.6 1.8 13a3.2 3.2 0 0 0 5.2 0L4.4 6.6Z"/><path d="M19.6 5.2 17 11.6a3.2 3.2 0 0 0 5.2 0L19.6 5.2Z"/>',
  stamp:     '<path d="M9 3.6h6a2 2 0 0 1 2 2.2l-.5 4.4a1.6 1.6 0 0 0 1.6 1.8H19a2 2 0 0 1 2 2v2H3v-2a2 2 0 0 1 2-2h.9a1.6 1.6 0 0 0 1.6-1.8L7 5.8a2 2 0 0 1 2-2.2Z"/><path d="M4.4 20.4h15.2"/>',
  payroll:   '<circle cx="8.6" cy="7.4" r="3.2"/><path d="M2.6 18.6a6 6 0 0 1 12 0"/><circle cx="18" cy="14.6" r="3.6"/><path d="M18 12.9v3.4M16.9 13.9h1.6a.75.75 0 0 1 0 1.5h-1a.75.75 0 0 0 0 1.5h1.6"/>',
  bulk:      '<path d="M3.4 6.4h9.2M3.4 12h9.2M3.4 17.6h9.2"/><path d="M16.4 6.4h4.2l-1.8-1.9M16.4 12h4.2l-1.8-1.9M16.4 17.6h4.2l-1.8-1.9"/>',
  dashboard: '<rect x="3" y="3.2" width="8" height="10" rx="1.8"/><rect x="13" y="3.2" width="8" height="6" rx="1.8"/><rect x="13" y="11.4" width="8" height="9.4" rx="1.8"/><rect x="3" y="15.2" width="8" height="5.6" rx="1.8"/>',
  headset:   '<path d="M4.4 14.6v-2.8a7.6 7.6 0 0 1 15.2 0v2.8"/><rect x="2.4" y="13.4" width="4.4" height="6" rx="2.2"/><rect x="17.2" y="13.4" width="4.4" height="6" rx="2.2"/><path d="M19.6 19.4v.6a2.4 2.4 0 0 1-2.4 2.4h-2.8"/>',
  atm:       '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4"/><rect x="7" y="7" width="10" height="4.4" rx="1"/><path d="M7 15.2h3.4M13.6 15.2H17"/>',
  cheque:    '<rect x="2.6" y="5.6" width="18.8" height="12.8" rx="2"/><path d="M6 10.4h5.4M6 14h3.2"/><path d="M14 14.6c1.2-2.6 2.2-3.9 3-3.9.8 0 .5 2.6 1.2 2.6.5 0 .9-.6 1.2-1.1"/>',
  target:    '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  percent:   '<path d="M19 5 5 19"/><circle cx="7.4" cy="7.4" r="2.8"/><circle cx="16.6" cy="16.6" r="2.8"/>',
  handshake: '<path d="M11.6 7.4 9.2 9.8a1.9 1.9 0 0 0 2.7 2.7l1.3-1.3 3.4 3.4a1.7 1.7 0 0 1-2.4 2.4"/><path d="M14.2 17a1.7 1.7 0 0 1-2.4 2.4l-.9-.9"/><path d="M2.8 8.6 6.4 6l4 1.4 3.2-1.4 3.4 1.2 4.2-1"/><path d="M21.2 15.4 17.6 17"/>',
  wallet2:   '<path d="M3 7.4A2.4 2.4 0 0 1 5.4 5h12A1.6 1.6 0 0 1 19 6.6v1.8"/><rect x="3" y="7.4" width="18" height="11.6" rx="2.4"/><circle cx="16.4" cy="13.2" r="1.3" fill="currentColor" stroke="none"/>',

  /* --- interface --------------------------------------------------------- */
  home:      '<path d="M3.5 10.4 12 3.6l8.5 6.8V20a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9.6Z"/>',
  grid:      '<rect x="3.4" y="3.4" width="7" height="7" rx="1.8"/><rect x="13.6" y="3.4" width="7" height="7" rx="1.8"/><rect x="3.4" y="13.6" width="7" height="7" rx="1.8"/><rect x="13.6" y="13.6" width="7" height="7" rx="1.8"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  close:     '<path d="M6 6l12 12M18 6 6 18"/>',
  check:     '<path d="M4.5 12.5 9.5 17.5 19.5 7"/>',
  chevron:   '<path d="M9 5.5 15.5 12 9 18.5"/>',
  back:      '<path d="M15 5.5 8.5 12 15 18.5"/>',
  bell:      '<path d="M18 8.6a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4Z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
  chat:      '<path d="M20.5 12.4a7.7 7.7 0 0 1-8.3 7.7 8.9 8.9 0 0 1-2.9-.5L4 21l1.5-4.6a7.6 7.6 0 0 1-1-3.8 7.7 7.7 0 0 1 7.7-7.7 7.7 7.7 0 0 1 8.3 7.5Z"/>',
  doc:       '<path d="M6.4 2.8h8L19 7.4V21H6.4A1.4 1.4 0 0 1 5 19.6V4.2a1.4 1.4 0 0 1 1.4-1.4Z"/><path d="M13.8 2.9v4.2h4.2M8.6 12.4h7M8.6 16h5"/>',
  pin:       '<path d="M12 21s7-5.6 7-11a7 7 0 0 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  lock:      '<rect x="4.6" y="10.4" width="14.8" height="10.2" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>',
  eye:       '<path d="M2.4 12S5.9 5.8 12 5.8 21.6 12 21.6 12 18.1 18.2 12 18.2 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeoff:    '<path d="M2.4 12S5.9 5.8 12 5.8 21.6 12 21.6 12 18.1 18.2 12 18.2 2.4 12 2.4 12Z"/><path d="M3.2 3.2l17.6 17.6"/>',
  freeze:    '<path d="M12 2.6v18.8M4 7.3l16 9.4M20 7.3 4 16.7"/><path d="M9.4 4.6 12 6.9l2.6-2.3M9.4 19.4 12 17.1l2.6 2.3"/>',
  repeat:    '<path d="M4 9.4A5 5 0 0 1 9 4.5h9l-2.6-2.4M20 14.6a5 5 0 0 1-5 4.9H6l2.6 2.4"/>',
  clock:     '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.2 2"/>',
  search:    '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M15.8 15.8 21 21"/>',
  alert:     '<path d="M12 3.6 21 19.4H3L12 3.6Z"/><path d="M12 9.8v4.4"/><circle cx="12" cy="16.9" r=".9" fill="currentColor" stroke="none"/>',
  info:      '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5"/><circle cx="12" cy="8.2" r=".9" fill="currentColor" stroke="none"/>',
  download:  '<path d="M12 3.6v11.2M7.6 10.6 12 15l4.4-4.4M4.5 19.4h15"/>',
  settings:  '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M4.5 12H2M22 12h-2.5M6.7 6.7 4.9 4.9M19.1 19.1l-1.8-1.8M17.3 6.7l1.8-1.8M4.9 19.1l1.8-1.8"/>',
  logout:    '<path d="M14.6 16.5V19a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19V5A1.6 1.6 0 0 1 5.6 3.4H13a1.6 1.6 0 0 1 1.6 1.6v2.5"/><path d="M9.6 12H20m-3.4-3.4L20 12l-3.4 3.4"/>',
};


/* =========================================================================
   SOLID SET — the primary banking actions.
   Stroke icons disappear at tile size. These are filled shapes with a knocked
   -out counter, so they hold their weight at 26px on a coloured tile and still
   read on a phone at arm's length.
   ========================================================================= */
const SOLIDS = {
  send:    '<path d="M20.6 3.4 3.9 9.7c-1.2.45-1.15 2.18.07 2.56l6.3 1.95 1.95 6.3c.38 1.22 2.11 1.27 2.56.07L21.1 3.9a.55.55 0 0 0-.5-.5Z"/>',
  receive: '<path d="M3.4 20.6 20.1 14.3c1.2-.45 1.15-2.18-.07-2.56l-6.3-1.95-1.95-6.3c-.38-1.22-2.11-1.27-2.56-.07L2.9 20.1a.55.55 0 0 0 .5.5Z"/>',
  swap:    '<path d="M3.4 8.9h12.3v2.6c0 .82.96 1.26 1.58.73l4.3-3.7a.96.96 0 0 0 0-1.46l-4.3-3.7c-.62-.53-1.58-.09-1.58.73V6.3H3.4a1.3 1.3 0 0 0 0 2.6Z"/><path d="M20.6 15.1H8.3v-2.6c0-.82-.96-1.26-1.58-.73l-4.3 3.7a.96.96 0 0 0 0 1.46l4.3 3.7c.62.53 1.58.09 1.58-.73v-2.2h12.3a1.3 1.3 0 0 0 0-2.6Z"/>',
  bills:   '<path d="M13.9 1.9a.8.8 0 0 1 .74 1.1l-2.3 6.1h4.7c.72 0 1.12.83.67 1.39l-9.1 11.4a.8.8 0 0 1-1.4-.72l2.3-6.9H5.1a.85.85 0 0 1-.72-1.3l8.1-10.6a.8.8 0 0 1 .62-.47Z"/>',
  airtime: '<rect x="6" y="1.6" width="12" height="20.8" rx="3.2"/><rect x="10.1" y="18.1" width="3.8" height="1.7" rx=".85" fill="#fff"/><rect x="7.7" y="4.2" width="8.6" height="11.6" rx="1.4" fill="#fff" opacity=".28"/>',
  card:    '<rect x="1.8" y="4.4" width="20.4" height="15.2" rx="3.2"/><rect x="1.8" y="8.2" width="20.4" height="2.9" fill="#fff" opacity=".85"/><rect x="5" y="14.4" width="5.2" height="2" rx="1" fill="#fff" opacity=".6"/>',
  goal:    '<path d="M12 1.9 21 7.1v9.8L12 22.1 3 16.9V7.1L12 1.9Z"/><circle cx="12" cy="12" r="3.4" fill="#fff"/><circle cx="12" cy="12" r="1.3"/>',
  invest:  '<path d="M3.2 15.7 9 9.9l3.5 3.4 6.1-6.1h-2.9a1.25 1.25 0 0 1 0-2.5h5.5c.5 0 .9.4.9.9v5.5a1.25 1.25 0 0 1-2.5 0V8.2l-7.1 7.1a1.25 1.25 0 0 1-1.76 0L9 11.9l-4 4a1.27 1.27 0 0 1-1.8-1.8Z"/><rect x="2.6" y="18.4" width="18.8" height="2.5" rx="1.25"/>',
  vault:   '<rect x="2.2" y="3.4" width="19.6" height="17.2" rx="3.4"/><circle cx="12" cy="12" r="4.6" fill="#fff"/><circle cx="12" cy="12" r="1.7"/><rect x="10.9" y="5.4" width="2.2" height="2.4" rx="1.1" fill="#fff"/>',
  grid:    '<rect x="2.6" y="2.6" width="8" height="8" rx="2.4"/><rect x="13.4" y="2.6" width="8" height="8" rx="2.4"/><rect x="2.6" y="13.4" width="8" height="8" rx="2.4"/><rect x="13.4" y="13.4" width="8" height="8" rx="2.4"/>',
  users:   '<circle cx="9" cy="7.4" r="3.9"/><path d="M1.9 20.4a7.1 7.1 0 0 1 14.2 0 1.1 1.1 0 0 1-1.1 1.1H3a1.1 1.1 0 0 1-1.1-1.1Z"/><circle cx="17.4" cy="8.6" r="3"/><path d="M17.6 13.2a5.6 5.6 0 0 1 4.5 6.1 1 1 0 0 1-1 .9h-2.4a9.4 9.4 0 0 0-1.9-6.9Z"/>',
  invoice: '<path d="M6.2 1.9h7.9L19.4 7v14.2a.9.9 0 0 1-.9.9H6.2a1.5 1.5 0 0 1-1.5-1.5V3.4a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M13.6 2.2v4.4h4.6" fill="#fff" opacity=".45"/><rect x="7.7" y="11.4" width="8" height="1.8" rx=".9" fill="#fff"/><rect x="7.7" y="15.2" width="5.2" height="1.8" rx=".9" fill="#fff" opacity=".75"/>',
  pos:     '<rect x="3.4" y="1.9" width="17.2" height="20.2" rx="3.2"/><rect x="6.6" y="5.2" width="10.8" height="4" rx="1.4" fill="#fff"/><circle cx="8.4" cy="13" r="1.35" fill="#fff"/><circle cx="12" cy="13" r="1.35" fill="#fff"/><circle cx="15.6" cy="13" r="1.35" fill="#fff"/><circle cx="8.4" cy="17.4" r="1.35" fill="#fff"/><circle cx="12" cy="17.4" r="1.35" fill="#fff"/><circle cx="15.6" cy="17.4" r="1.35" fill="#fff"/>',
  home:    '<path d="M11.1 2.4 3 8.9a2.2 2.2 0 0 0-.8 1.7v9.1a1.9 1.9 0 0 0 1.9 1.9h4.6v-6.2a1.4 1.4 0 0 1 1.4-1.4h3.8a1.4 1.4 0 0 1 1.4 1.4v6.2h4.6a1.9 1.9 0 0 0 1.9-1.9v-9.1a2.2 2.2 0 0 0-.8-1.7l-8.1-6.5a1.9 1.9 0 0 0-2.4 0Z"/>',
  user:    '<circle cx="12" cy="7.6" r="4.3"/><path d="M3.4 21a8.6 8.6 0 0 1 17.2 0 1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1Z"/>',
  chat:    '<path d="M12 2.6c5.6 0 9.6 3.9 9.6 8.7 0 4.8-4 8.7-9.6 8.7a11 11 0 0 1-2.9-.4l-4.7 1.7a.7.7 0 0 1-.9-.9l1.5-4.2a8.2 8.2 0 0 1-2.2-5.6C2.8 6.5 6.7 2.6 12 2.6Z"/>',
  shield:  '<path d="M12 1.9 4.4 5v6.2c0 4.7 3.2 8.9 7.6 10.1 4.4-1.2 7.6-5.4 7.6-10.1V5L12 1.9Z"/><path d="m8.6 11.9 2.4 2.4 4.6-4.6" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  plus:    '<rect x="10.6" y="3.4" width="2.8" height="17.2" rx="1.4"/><rect x="3.4" y="10.6" width="17.2" height="2.8" rx="1.4"/>',
  doc:     '<path d="M6.4 1.9h7.7L19.4 7v13.6a1.5 1.5 0 0 1-1.5 1.5H6.4a1.5 1.5 0 0 1-1.5-1.5V3.4a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M13.7 2.2v4.5h4.5" fill="#fff" opacity=".45"/>',
  node:    '<path d="M12 1.9 21 7.1v9.8L12 22.1 3 16.9V7.1L12 1.9Z" opacity=".22"/><circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="4.4" r="1.9"/><circle cx="5.2" cy="16.4" r="1.9"/><circle cx="18.8" cy="16.4" r="1.9"/><path d="M12 6.3v3.1M13.9 13.6l3.2 1.9M10.1 13.6l-3.2 1.9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  freeze:  '<path d="M12 1.8a1.2 1.2 0 0 1 1.2 1.2v3l1.6-1.6a1.15 1.15 0 0 1 1.65 1.6L13.2 9.2v2.1l1.85-1.07 1.1-4.1a1.15 1.15 0 1 1 2.22.6l-.6 2.22 2.6-1.5a1.2 1.2 0 0 1 1.2 2.08l-2.6 1.5 2.22.6a1.15 1.15 0 1 1-.6 2.22l-4.1-1.1L14.6 12l1.85 1.07 4.1-1.1a1.15 1.15 0 0 1 .6 2.22l-2.22.6 2.6 1.5a1.2 1.2 0 0 1-1.2 2.08l-2.6-1.5.6 2.22a1.15 1.15 0 1 1-2.22.6l-1.1-4.1-1.85-1.07v2.1l3.25 3.25a1.15 1.15 0 0 1-1.65 1.6l-1.6-1.6v3a1.2 1.2 0 0 1-2.4 0v-3l-1.6 1.6a1.15 1.15 0 0 1-1.65-1.6l3.25-3.25v-2.1l-1.85 1.07-1.1 4.1a1.15 1.15 0 1 1-2.22-.6l.6-2.22-2.6 1.5a1.2 1.2 0 1 1-1.2-2.08l2.6-1.5-2.22-.6a1.15 1.15 0 1 1 .6-2.22l4.1 1.1L9.4 12l-1.85-1.07-4.1 1.1a1.15 1.15 0 1 1-.6-2.22l2.22-.6-2.6-1.5A1.2 1.2 0 0 1 3.67 5.63l2.6 1.5-.6-2.22a1.15 1.15 0 1 1 2.22-.6l1.1 4.1L10.8 9.5V7.4L7.55 4.15a1.15 1.15 0 0 1 1.65-1.6l1.6 1.6v-3A1.2 1.2 0 0 1 12 1.8Z"/>',
  bell:    '<path d="M12 1.9a6.9 6.9 0 0 0-6.9 6.9c0 4.4-1.9 6-1.9 6a1.1 1.1 0 0 0 .9 1.8h15.8a1.1 1.1 0 0 0 .9-1.8s-1.9-1.6-1.9-6A6.9 6.9 0 0 0 12 1.9Z"/><path d="M9.6 18.4a2.6 2.6 0 0 0 4.8 0Z"/>',
  check:   '<circle cx="12" cy="12" r="10.2"/><path d="m7.4 12.3 3.1 3.1 6.1-6.7" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:   '<path d="M13.7 3.3 22.6 18.9a2 2 0 0 1-1.7 3H3.1a2 2 0 0 1-1.7-3L10.3 3.3a2 2 0 0 1 3.4 0Z"/><rect x="10.8" y="8.3" width="2.4" height="6.4" rx="1.2" fill="#fff"/><circle cx="12" cy="17.6" r="1.35" fill="#fff"/>',
  wallet:  '<path d="M4.4 3.9h13.2a2 2 0 0 1 2 2v1.6H4.9a1.8 1.8 0 0 1 0-3.6Z" opacity=".55"/><path d="M3.1 8.2a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10.1a2 2 0 0 1-2 2H5.1a2 2 0 0 1-2-2Z"/><circle cx="16.8" cy="13.3" r="1.7" fill="#fff"/>',
  chart:   '<rect x="2.4" y="11.4" width="4.4" height="9.8" rx="1.6"/><rect x="9.8" y="4.6" width="4.4" height="16.6" rx="1.6"/><rect x="17.2" y="8.4" width="4.4" height="12.8" rx="1.6"/>',
  ledger:  '<rect x="2.6" y="3.4" width="18.8" height="5.2" rx="1.9"/><rect x="2.6" y="10.4" width="18.8" height="5.2" rx="1.9" opacity=".7"/><rect x="2.6" y="17.4" width="18.8" height="3.4" rx="1.6" opacity=".45"/>',
  lock:    '<rect x="3.9" y="10" width="16.2" height="11.6" rx="3"/><path d="M7.6 10V7.4a4.4 4.4 0 0 1 8.8 0V10" stroke="currentColor" stroke-width="2.3" fill="none" stroke-linecap="round"/><circle cx="12" cy="15.4" r="1.9" fill="#fff"/>',
  pin:     '<path d="M12 1.9a7.7 7.7 0 0 0-7.7 7.7c0 5.6 6.8 11.9 7.1 12.2a.9.9 0 0 0 1.2 0c.3-.3 7.1-6.6 7.1-12.2A7.7 7.7 0 0 0 12 1.9Z"/><circle cx="12" cy="9.5" r="2.9" fill="#fff"/>',
  power:   '<path d="M13.9 1.9a.8.8 0 0 1 .74 1.1l-2.3 6.1h4.7c.72 0 1.12.83.67 1.39l-9.1 11.4a.8.8 0 0 1-1.4-.72l2.3-6.9H5.1a.85.85 0 0 1-.72-1.3l8.1-10.6a.8.8 0 0 1 .62-.47Z"/>',
};

/** Solid icon, for tiles and tab bars. Falls back to the stroke set. */
function IS(name, size = 26){
  const p = SOLIDS[name];
  if (!p) return I(name, size, 2.1);
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"
    aria-hidden="true" focusable="false">${p}</svg>`;
}

/** Render an icon. Returns an inline SVG string using currentColor. */
function I(name, size = 24, w = 2){
  const p = ICONS[name] || ICONS.info;
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${p}</svg>`;
}

/** The lattice that textures dark surfaces — nodes and links, not decoration
    for its own sake: it is the same motif as the block/node/chain icons. */
function lattice(id = 'lat'){
  return `<svg class="lattice" aria-hidden="true"><defs>
    <pattern id="${id}" width="58" height="50" patternUnits="userSpaceOnUse">
      <g fill="none" stroke="currentColor" stroke-width="1">
        <path d="M29 2 51 14.5v25L29 52 7 39.5v-25L29 2Z"/>
        <path d="M29 2v12.5M7 14.5 29 27M51 14.5 29 27M29 27v25"/>
      </g>
      <circle cx="29" cy="27" r="2" fill="currentColor"/>
      <circle cx="29" cy="2" r="1.6" fill="currentColor"/>
      <circle cx="7" cy="14.5" r="1.6" fill="currentColor"/>
      <circle cx="51" cy="14.5" r="1.6" fill="currentColor"/>
    </pattern></defs>
    <rect width="100%" height="100%" fill="url(#${id})"/></svg>`;
}
