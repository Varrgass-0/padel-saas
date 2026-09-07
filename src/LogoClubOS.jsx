// Logo oficial de ClubOS — SVG nativo (viewBox, no un PNG/JPG exportado), así
// que escala a cualquier tamaño (favicon, header del panel, pantalla de
// login, membrete de un PDF) sin pixelarse nunca. Requiere que la tipografía
// "Sora" (weights 700/800) esté cargada por la página — ver el <link> de
// Google Fonts agregado en index.html — si no carga a tiempo, el navegador
// hace fallback a la pila `sans-serif` del propio SVG mientras tanto, así
// que el logo nunca se queda en blanco.
export const LogoClubOS = ({ className = 'h-12 w-auto' }) => (
  <svg
    viewBox="0 0 520 120"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="ClubOS"
    className={className}
  >
    {/* CLUB en blanco con la fuente Sora / Sans bold */}
    <text x="10" y="85" fill="#FFFFFF" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="88" letterSpacing="-2">
      CLUB
    </text>
    {/* O con el corte neón (#B8FF1A) */}
    <g transform="translate(285, 12)">
      <path
        d="M42 12C18.8 12 0 30.8 0 54s18.8 42 42 42c18.5 0 34.2-12 39.5-28.5H52c-3.2 5.2-9 8.5-15.5 8.5-10 0-18-8-18-18s8-18 18-18c6.5 0 12.3 3.3 15.5 8.5h29.5C76.2 24 60.5 12 42 12z"
        fill="#B8FF1A"
      />
      <rect x="32" y="48" width="30" height="12" rx="6" fill="#B8FF1A" />
    </g>
    {/* S en verde neón (#B8FF1A) */}
    <text x="395" y="85" fill="#B8FF1A" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="88" letterSpacing="-2">
      S
    </text>
  </svg>
);

export default LogoClubOS;
