// The artwork on the sign-in / sign-up screens: a meeting window with a gallery of
// participants, drawn here (not Zoom's own illustration). Colours are fixed, so it reads the
// same on the light and the dark panel.

const TILE_WIDTH = 86;
const TILE_HEIGHT = 62;

/** One participant tile: a blue rectangle with a head-and-shoulders silhouette. */
function Tile({ x, y, tile, figure, speaking = false }: { x: number; y: number; tile: string; figure: string; speaking?: boolean }) {
  const cx = x + TILE_WIDTH / 2;
  const bottom = y + TILE_HEIGHT;
  return (
    <g>
      <rect x={x} y={y} width={TILE_WIDTH} height={TILE_HEIGHT} rx="6" fill={tile} />
      <circle cx={cx} cy={y + 24} r="11" fill={figure} />
      <path d={`M ${cx - 24} ${bottom} Q ${cx - 24} ${bottom - 22} ${cx} ${bottom - 22} Q ${cx + 24} ${bottom - 22} ${cx + 24} ${bottom} Z`} fill={figure} />
      {speaking && (
        <rect x={x + 1.5} y={y + 1.5} width={TILE_WIDTH - 3} height={TILE_HEIGHT - 3} rx="5" fill="none" stroke="#23d959" strokeWidth="3" />
      )}
    </g>
  );
}

export function AuthIllustration({ className = "" }: { className?: string }) {
  const columns = [88, 180, 272];
  const rows = [66, 134];
  return (
    <svg viewBox="0 0 440 300" aria-hidden="true" className={className}>
      <ellipse cx="222" cy="282" rx="170" ry="9" fill="#0b2a66" opacity="0.08" />

      {/* the meeting window */}
      <rect x="72" y="28" width="302" height="236" rx="12" fill="#0b2a66" />
      <path d="M72 40a12 12 0 0 1 12-12h278a12 12 0 0 1 12 12v12H72Z" fill="#dfe7f7" />
      <circle cx="88" cy="40" r="3.5" fill="#ff5f57" />
      <circle cx="100" cy="40" r="3.5" fill="#febc2e" />
      <circle cx="112" cy="40" r="3.5" fill="#28c840" />

      {rows.map((y, row) =>
        columns.map((x, column) => (
          <Tile
            key={`${row}-${column}`}
            x={x}
            y={y}
            tile={(row + column) % 2 === 0 ? "#1a66ff" : "#1557dc"}
            figure="#0a3aa8"
            speaking={row === 0 && column === 1}
          />
        )),
      )}

      {/* toolbar: mic, camera, participants, and the red End button */}
      <rect x="72" y="212" width="302" height="52" rx="12" fill="#081f4d" />
      <rect x="72" y="212" width="302" height="14" fill="#081f4d" />
      <circle cx="104" cy="238" r="7" fill="#5b7bbd" />
      <circle cx="130" cy="238" r="7" fill="#5b7bbd" />
      <circle cx="223" cy="238" r="7" fill="#5b7bbd" />
      <rect x="318" y="229" width="40" height="18" rx="9" fill="#e02828" />

      {/* two people on their way in */}
      <g transform="rotate(-11 62 222)">
        <rect x="18" y="190" width={TILE_WIDTH} height={TILE_HEIGHT} rx="6" fill="#0b2a66" opacity="0.12" transform="translate(3 5)" />
        <Tile x={18} y={190} tile="#4b8dff" figure="#1a56d6" />
      </g>
      <g transform="rotate(9 384 64)">
        <rect x="340" y="34" width={TILE_WIDTH} height={TILE_HEIGHT} rx="6" fill="#0b2a66" opacity="0.12" transform="translate(3 5)" />
        <Tile x={340} y={34} tile="#4b8dff" figure="#1a56d6" />
      </g>
    </svg>
  );
}
