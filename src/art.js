/* =========================================================================
   FIDELITY ILLUSTRATIONS
   Built in the language of the strategy deck: flat geometry, three oranges,
   two greys, white space doing the work. No black anywhere. Every scene is
   inline SVG, so it scales, recolours with the theme and costs no request.
       ART.goal()      → savings
       ART.welcome()   → the bank itself
   All return a full <svg> sized by its container.
   ========================================================================= */
const ART = (() => {
  const O  = '#F07C1C', OD = '#D2610A', OL = '#FFA65C', OT = '#FFE3CA';
  const G  = '#C3CAD2', GD = '#9AA3AD', GL = '#E8ECF0', W = '#FFFFFF';

  const wrap = (vb, body, cls = '') =>
    `<svg class="art ${cls}" viewBox="${vb}" fill="none" xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true" focusable="false">${body}</svg>`;

  /* hexagon path helper — the node motif, reused across scenes */
  const hex = (cx, cy, r, fill, stroke, sw = 0) => {
    const p = [0,1,2,3,4,5].map(i => {
      const a = Math.PI/180 * (60*i - 90);
      return `${(cx + r*Math.cos(a)).toFixed(1)},${(cy + r*Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${p}" fill="${fill||'none'}" ${stroke?`stroke="${stroke}" stroke-width="${sw||2}"`:''}
      stroke-linejoin="round"/>`;
  };

  /* ---------------------------------------------------- the bank itself */
  const welcome = () => wrap('0 0 340 240', `
    <circle cx="252" cy="82" r="74" fill="${OT}"/>
    <rect x="28" y="52" width="176" height="112" rx="18" fill="${W}" stroke="${GL}" stroke-width="2"/>
    <rect x="28" y="52" width="176" height="30" rx="18" fill="${O}"/>
    <rect x="28" y="68" width="176" height="14" fill="${O}"/>
    <rect x="46" y="98" width="86" height="9" rx="4.5" fill="${G}"/>
    <rect x="46" y="116" width="126" height="16" rx="8" fill="${GL}"/>
    <rect x="46" y="142" width="52" height="9" rx="4.5" fill="${OT}"/>
    <rect x="112" y="142" width="34" height="9" rx="4.5" fill="${GL}"/>
    <rect x="150" y="96" width="122" height="76" rx="16" fill="${W}" stroke="${GL}" stroke-width="2"/>
    <rect x="166" y="112" width="44" height="8" rx="4" fill="${GD}"/>
    <rect x="166" y="128" width="80" height="20" rx="10" fill="${OT}"/>
    <rect x="166" y="128" width="46" height="20" rx="10" fill="${O}"/>
    <rect x="166" y="158" width="30" height="6" rx="3" fill="${GL}"/>
    ${hex(300, 168, 26, OT)}
    ${hex(300, 168, 26, 'none', O, 2)}
    <circle cx="300" cy="168" r="6" fill="${O}"/>
    ${hex(58, 196, 18, W, G, 2)}
    <circle cx="58" cy="196" r="4.5" fill="${GD}"/>
    <path d="M76 196h56" stroke="${G}" stroke-width="2" stroke-dasharray="4 5" stroke-linecap="round"/>
    ${hex(150, 196, 18, OT, O, 2)}
    <circle cx="150" cy="196" r="4.5" fill="${O}"/>
    <path d="M168 196h56" stroke="${G}" stroke-width="2" stroke-dasharray="4 5" stroke-linecap="round"/>
    ${hex(242, 196, 18, W, G, 2)}
    <circle cx="242" cy="196" r="4.5" fill="${GD}"/>
    <circle cx="214" cy="44" r="9" fill="${OL}"/>
    <circle cx="20" cy="120" r="6" fill="${G}"/>`);

  /* ------------------------------------------------------------ savings */
  const goal = () => wrap('0 0 320 220', `
    <circle cx="160" cy="112" r="88" fill="${OT}" opacity=".55"/>
    <circle cx="160" cy="112" r="66" fill="none" stroke="${W}" stroke-width="14"/>
    <circle cx="160" cy="112" r="66" fill="none" stroke="${GL}" stroke-width="10"/>
    <circle cx="160" cy="112" r="66" fill="none" stroke="${O}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="414" stroke-dashoffset="128" transform="rotate(-90 160 112)"/>
    <rect x="120" y="128" width="80" height="14" rx="7" fill="${W}"/>
    <rect x="126" y="110" width="68" height="14" rx="7" fill="${OL}"/>
    <rect x="132" y="92" width="56" height="14" rx="7" fill="${O}"/>
    <rect x="138" y="74" width="44" height="14" rx="7" fill="${OD}"/>
    ${hex(56, 62, 22, W, G, 2)}
    <circle cx="56" cy="62" r="6" fill="${OL}"/>
    ${hex(268, 170, 20, OT, O, 2)}
    <circle cx="268" cy="170" r="5" fill="${O}"/>
    <circle cx="272" cy="52" r="10" fill="${G}"/>
    <circle cx="44" cy="168" r="7" fill="${OL}"/>`);

  /* ------------------------------------------------------------- growth */
  const growth = () => wrap('0 0 320 200', `
    <rect x="24" y="24" width="272" height="152" rx="20" fill="${W}" stroke="${GL}" stroke-width="2"/>
    <rect x="48" y="112" width="30" height="42" rx="9" fill="${GL}"/>
    <rect x="94" y="92" width="30" height="62" rx="9" fill="${G}"/>
    <rect x="140" y="70" width="30" height="84" rx="9" fill="${OL}"/>
    <rect x="186" y="52" width="30" height="102" rx="9" fill="${O}"/>
    <rect x="232" y="34" width="30" height="120" rx="9" fill="${OD}"/>
    <path d="M56 96c40-26 78-40 122-56 22-8 44-12 66-14" stroke="${O}" stroke-width="3"
      stroke-linecap="round" stroke-dasharray="6 7"/>
    <circle cx="244" cy="26" r="9" fill="${W}" stroke="${O}" stroke-width="3"/>`);

  /* --------------------------------------------------------- protection */
  const secure = () => wrap('0 0 300 220', `
    <circle cx="150" cy="108" r="86" fill="${OT}" opacity=".5"/>
    <path d="M150 34 84 60v50c0 40 27 74 66 86 39-12 66-46 66-86V60l-66-26Z"
      fill="${W}" stroke="${O}" stroke-width="3"/>
    <path d="M150 52 100 72v38c0 31 21 57 50 67 29-10 50-36 50-67V72l-50-20Z" fill="${OT}"/>
    <path d="M126 112l18 18 32-36" stroke="${OD}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    ${hex(46, 56, 18, W, G, 2)}<circle cx="46" cy="56" r="4.5" fill="${GD}"/>
    ${hex(258, 158, 18, W, O, 2)}<circle cx="258" cy="158" r="4.5" fill="${O}"/>
    <circle cx="262" cy="52" r="8" fill="${OL}"/>
    <circle cx="40" cy="164" r="6" fill="${G}"/>`);

  /* ------------------------------------------------------------- cards */
  const cards = () => wrap('0 0 320 200', `
    <circle cx="238" cy="70" r="66" fill="${OT}" opacity=".6"/>
    <rect x="42" y="66" width="168" height="104" rx="16" fill="${GL}" transform="rotate(-8 126 118)"/>
    <rect x="64" y="48" width="168" height="104" rx="16" fill="${W}" stroke="${G}" stroke-width="2"
      transform="rotate(-3 148 100)"/>
    <rect x="86" y="34" width="168" height="104" rx="16" fill="${O}"/>
    <rect x="104" y="56" width="30" height="22" rx="5" fill="${OT}"/>
    <rect x="104" y="96" width="96" height="9" rx="4.5" fill="${W}" opacity=".85"/>
    <rect x="104" y="114" width="46" height="7" rx="3.5" fill="${W}" opacity=".55"/>
    ${hex(226, 62, 15, 'none', W, 2)}
    <circle cx="226" cy="62" r="4" fill="${W}"/>
    <circle cx="44" cy="42" r="8" fill="${OL}"/>
    ${hex(276, 156, 18, W, G, 2)}<circle cx="276" cy="156" r="4.5" fill="${GD}"/>`);

  /* ------------------------------------------------------------ support */
  const support = () => wrap('0 0 300 210', `
    <circle cx="150" cy="104" r="84" fill="${OT}" opacity=".5"/>
    <rect x="42" y="46" width="146" height="88" rx="20" fill="${W}" stroke="${GL}" stroke-width="2"/>
    <path d="M74 134v22l26-22H74Z" fill="${W}" stroke="${GL}" stroke-width="2"/>
    <rect x="64" y="72" width="82" height="9" rx="4.5" fill="${G}"/>
    <rect x="64" y="92" width="54" height="9" rx="4.5" fill="${GL}"/>
    <rect x="136" y="96" width="124" height="72" rx="20" fill="${O}"/>
    <path d="M226 168v20l-24-20h24Z" fill="${O}"/>
    <rect x="156" y="118" width="72" height="9" rx="4.5" fill="${W}" opacity=".9"/>
    <rect x="156" y="136" width="44" height="9" rx="4.5" fill="${W}" opacity=".6"/>
    <circle cx="252" cy="52" r="22" fill="${W}" stroke="${O}" stroke-width="3"/>
    <circle cx="252" cy="45" r="7" fill="${OL}"/>
    <path d="M240 63a12 12 0 0 1 24 0" stroke="${OL}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="36" cy="150" r="7" fill="${G}"/>`);

  /* ------------------------------------------------ nothing here yet */
  const empty = () => wrap('0 0 280 180', `
    <circle cx="140" cy="90" r="66" fill="${GL}" opacity=".7"/>
    <rect x="72" y="52" width="136" height="86" rx="16" fill="${W}" stroke="${GL}" stroke-width="2"/>
    <rect x="92" y="76" width="60" height="8" rx="4" fill="${GL}"/>
    <rect x="92" y="94" width="94" height="8" rx="4" fill="${GL}"/>
    <rect x="92" y="112" width="42" height="8" rx="4" fill="${OT}"/>
    ${hex(220, 132, 17, W, O, 2)}<circle cx="220" cy="132" r="4.5" fill="${O}"/>
    <circle cx="58" cy="46" r="7" fill="${G}"/>`);

  /* --------------------------------------------------- the network idea */
  const network = () => wrap('0 0 320 200', `
    <circle cx="160" cy="100" r="82" fill="${OT}" opacity=".45"/>
    <path d="M96 62 160 40l64 22M96 62v66l64 30 64-30V62M96 128l64-30 64 30M160 40v58"
      stroke="${G}" stroke-width="2" stroke-linejoin="round"/>
    ${hex(160, 40, 18, W, O, 2.5)}<circle cx="160" cy="40" r="5" fill="${O}"/>
    ${hex(96, 62, 15, W, G, 2)}<circle cx="96" cy="62" r="4" fill="${GD}"/>
    ${hex(224, 62, 15, W, G, 2)}<circle cx="224" cy="62" r="4" fill="${GD}"/>
    ${hex(96, 128, 15, OT, O, 2)}<circle cx="96" cy="128" r="4" fill="${O}"/>
    ${hex(224, 128, 15, W, G, 2)}<circle cx="224" cy="128" r="4" fill="${GD}"/>
    ${hex(160, 158, 18, O, OD, 2.5)}<circle cx="160" cy="158" r="5" fill="${W}"/>
    <circle cx="40" cy="52" r="8" fill="${OL}"/>
    <circle cx="284" cy="150" r="6" fill="${G}"/>`);

  /* --------------------------------------------------------- celebration */
  const done = () => wrap('0 0 280 200', `
    <circle cx="140" cy="98" r="72" fill="${OT}"/>
    <circle cx="140" cy="98" r="52" fill="${W}"/>
    <path d="M114 98l18 19 36-40" stroke="${O}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="34" y="40" width="12" height="12" rx="3" fill="${OL}" transform="rotate(20 40 46)"/>
    <rect x="234" y="52" width="10" height="10" rx="3" fill="${O}" transform="rotate(-15 239 57)"/>
    <circle cx="52" cy="140" r="7" fill="${G}"/>
    <circle cx="228" cy="146" r="9" fill="${OL}"/>
    ${hex(258, 96, 14, W, O, 2)}
    ${hex(28, 92, 12, W, G, 2)}`);

  return {welcome, goal, growth, secure, cards, support, empty, network, done};
})();
