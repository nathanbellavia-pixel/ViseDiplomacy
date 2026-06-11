// Purely decorative SVG elements shared across pages.

export function CornerSparkle() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 64 64"
      className="pointer-events-none fixed bottom-5 right-5 z-0 h-10 w-10 text-amber-500/50"
      fill="currentColor"
    >
      <path d="M32 4l5 19 19 5-19 5-5 19-5-19-19-5 19-5z" />
      <path d="M52 40l2.5 8.5L63 51l-8.5 2.5L52 62l-2.5-8.5L41 51l8.5-2.5z" opacity="0.7" />
    </svg>
  );
}

// Abstract low-poly continents, floated on the left half of the landing page.
export function WorldMapBackdrop() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 520 600"
      className="pointer-events-none fixed left-0 top-16 z-0 h-[85vh] w-auto max-w-[55vw] opacity-10"
      fill="none"
      stroke="#f8fafc"
      strokeWidth="1.5"
    >
      {/* north-western landmass */}
      <polygon points="40,120 110,70 200,90 235,150 190,210 215,260 150,300 80,270 55,200" />
      <polygon points="225,95 290,60 350,85 330,140 260,150" />
      {/* central continent */}
      <polygon points="150,320 240,290 330,310 380,380 340,470 250,520 170,470 140,390" />
      <polygon points="345,300 430,270 490,320 470,400 400,420 365,360" />
      {/* eastern archipelago */}
      <polygon points="420,440 470,430 495,470 460,505 425,485" />
      <polygon points="300,540 350,525 370,560 330,585" />
      {/* meridians for the strategic-map feel */}
      <path d="M20 80 Q 260 30 500 80" opacity="0.5" />
      <path d="M20 300 Q 260 260 500 300" opacity="0.5" />
      <path d="M20 520 Q 260 480 500 520" opacity="0.5" />
    </svg>
  );
}
