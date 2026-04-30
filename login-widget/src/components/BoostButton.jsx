// Nav button that flips the shared show-boost-open signal in index.jsx.
// The actual modal is rendered by ShowBoostHost so the API can open it
// from outside (lazy-load placeholder click in index.html).
//
// Visual: white SVG bolt + label on a Bitcoin-orange pill. The static
// placeholder in index.html / boosts.html is styled to match exactly,
// so the swap to the React button is invisible.
export default function BoostButton({ onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // Inline style for the orange — Tailwind's `bg-orange-500` is a
      // slightly different hue. Keeping the exact #f7931a Bitcoin
      // orange so the placeholder→React swap doesn't flicker color.
      style={{
        background: '#f7931a',
        border: 'none',
        cursor: 'pointer',
        font: 'inherit',
        color: '#ffffff',
      }}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.78rem] font-semibold transition-colors hover:!bg-[#d97b0e]"
      aria-label="Boost the Show"
      title="Boost the Show"
    >
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        width="11"
        height="11"
        className="flex-shrink-0"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z"
          clipRule="evenodd"
        />
      </svg>
      <span className="hidden sm:inline">Boost the Show</span>
      <span className="sm:hidden">Boost</span>
    </button>
  )
}
