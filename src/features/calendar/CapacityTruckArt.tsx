/* eslint-disable no-restricted-syntax -- data colour: the per-card identity palette and the truck drawing (a picture, not UI chrome) */
import type { TruckKind } from './capacityCardStyle'

const CAB = '#e8ebf0'
const CAB_SHADE = '#c3c9d3'
const GLASS = '#8fb4d8'
const FRAME = '#374151'
const TIRE = '#1f2937'
const HUB = '#aab2bf'
const CHROME = '#cbd5e1'

function Wheel({ cx, cy = 66, r = 9 }: { cx: number; cy?: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={TIRE} />
      <circle cx={cx} cy={cy} r={r * 0.48} fill={HUB} />
      <circle cx={cx} cy={cy} r={r * 0.16} fill={TIRE} />
    </g>
  )
}

/** The tractor (or straight-truck cab) at the right edge: window, door line, grille, headlight. */
function Cab({ x = 150, h = 34, accent, stripe = true }: { x?: number; h?: number; accent: string; stripe?: boolean }) {
  const top = 62 - h
  return (
    <g>
      <path d={`M${x} 62 V${top + 8} Q${x} ${top} ${x + 8} ${top} H${x + 30} Q${x + 36} ${top} ${x + 40} ${top + 8} L${x + 46} ${top + 22} V62 Z`} fill={CAB} />
      <path d={`M${x + 8} ${top + 5} H${x + 29} Q${x + 33} ${top + 5} ${x + 36} ${top + 11} L${x + 39} ${top + 19} H${x + 8} Z`} fill={GLASS} />
      <path d={`M${x + 4} 62 V${top + 22} H${x + 46} V62 Z`} fill={CAB_SHADE} opacity="0.55" />
      {stripe && <rect x={x} y={top + 24} width={46} height={5} fill={accent} />}
      <rect x={x + 41} y={top + 31} width={5} height={5} rx={1.5} fill="#fde68a" />
      <rect x={x + 38} y={52} width={9} height={6} rx={1} fill={FRAME} opacity="0.7" />
    </g>
  )
}

/** A flat shine on the top of a box and a darker strip on its underside, so a flat color reads as a solid. */
function Shade({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h * 0.22} fill="#ffffff" opacity="0.22" />
      <rect x={x} y={y + h * 0.82} width={w} height={h * 0.18} fill="#000000" opacity="0.16" />
    </g>
  )
}

function Ribs({ x, y, w, h, n }: { x: number; y: number; w: number; h: number; n: number }) {
  return (
    <g stroke="#000000" strokeOpacity="0.14" strokeWidth="1.2">
      {Array.from({ length: n }, (_, i) => {
        const rx = x + ((i + 1) * w) / (n + 1)
        return <line key={i} x1={rx} y1={y + 4} x2={rx} y2={y + h - 4} />
      })}
    </g>
  )
}

/** A ratchet strap over a load: a dark band with a small buckle. */
function Strap({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return (
    <g>
      <rect x={x - 1.2} y={y1} width={2.4} height={y2 - y1} fill="#111827" opacity="0.8" />
      <rect x={x - 2.4} y={y1 + (y2 - y1) * 0.45} width={4.8} height={3.4} rx={0.8} fill="#e5e7eb" />
    </g>
  )
}

/**
 * The tractor every semi-trailer type hooks to: day cab, exhaust stack, fifth wheel, two drive axles and a steer axle. The trailer is
 * drawn before it, ending at x = 140, with a visible gap before the cab.
 */
function Tractor({ accent }: { accent: string }) {
  return (
    <g>
      <rect x={116} y={60} width={80} height={5} rx={2} fill={FRAME} />
      <rect x={118} y={56.5} width={28} height={4} rx={1.5} fill="#4b5563" />
      <rect x={140} y={57} width={4} height={3} fill="#111827" />
      <rect x={145.5} y={12} width={3} height={46} rx={1.5} fill={CHROME} />
      <rect x={145.5} y={12} width={3} height={5} rx={1} fill="#94a3b8" />
      <Cab accent={accent} />
      <Wheel cx={128} r={8.5} /><Wheel cx={146} r={8.5} /><Wheel cx={182} />
    </g>
  )
}

/** Trailer tandem and the landing gear that props up the front when it is not hooked up. */
function TrailerRunning({ gearX = 100 }: { gearX?: number }) {
  return (
    <g>
      <rect x={gearX} y={58} width={2.4} height={13} fill={FRAME} />
      <rect x={gearX + 7} y={58} width={2.4} height={13} fill={FRAME} />
      <rect x={gearX - 1.5} y={70.5} width={13} height={2.2} rx={1} fill={FRAME} />
      <Wheel cx={22} /><Wheel cx={40} />
    </g>
  )
}

function Art({ kind, accent }: { kind: TruckKind; accent: string }) {
  switch (kind) {
    case 'straight':
      // One chassis, a box body that stands taller than the cab, a single rear axle, a folded lift gate. No trailer, no gap.
      return (
        <g>
          <rect x={10} y={60} width={186} height={5} rx={2} fill={FRAME} />
          <rect x={24} y={9} width={112} height={51} rx={4} fill={accent} />
          <Shade x={24} y={9} w={112} h={51} />
          <rect x={24} y={14} width={112} height={3} fill="#ffffff" opacity="0.32" />
          <g stroke="#000000" strokeOpacity="0.14" strokeWidth="1.2">
            {[22, 28, 34, 40, 46, 52].map((y) => <line key={y} x1={28} y1={y} x2={46} y2={y} />)}
          </g>
          <rect x={17} y={18} width={7} height={40} rx={1.5} fill={FRAME} />
          <rect x={14} y={57} width={13} height={4} rx={1.5} fill="#111827" />
          <rect x={128} y={14} width={8} height={46} fill="#000000" opacity="0.14" />
          <rect x={136} y={46} width={6} height={14} fill="#000000" opacity="0.28" />
          <Cab x={140} h={34} accent={accent} />
          <Wheel cx={62} r={9.5} /><Wheel cx={74} r={9.5} /><Wheel cx={182} />
        </g>
      )
    case 'reefer':
      // A box trailer with the refrigeration unit standing on its nose and a fuel tank under the floor.
      return (
        <g>
          <rect x={6} y={58} width={134} height={4} rx={2} fill={FRAME} />
          <rect x={6} y={14} width={134} height={44} rx={4} fill={accent} />
          <Shade x={6} y={14} w={134} h={44} />
          <rect x={44} y={46} width={58} height={9} rx={2} fill="#000000" opacity="0.2" />
          <rect x={64} y={62} width={26} height={7} rx={3} fill="#4b5563" />
          <rect x={122} y={6} width={22} height={30} rx={3} fill="#f3f4f6" />
          <rect x={122} y={6} width={22} height={5} rx={2.5} fill="#d1d5db" />
          <circle cx={133} cy={23} r={7} fill="#9ca3af" />
          <g stroke="#475569" strokeWidth="1.2" strokeLinecap="round" transform="translate(133 23)">
            <line x1={0} y1={-5} x2={0} y2={5} /><line x1={-4.3} y1={-2.5} x2={4.3} y2={2.5} /><line x1={-4.3} y1={2.5} x2={4.3} y2={-2.5} />
          </g>
          <g stroke="#ffffff" strokeOpacity="0.92" strokeWidth="2" strokeLinecap="round" fill="none" transform="translate(66 31)">
            <path d="M0 -11 V11 M-9.5 -5.5 L9.5 5.5 M-9.5 5.5 L9.5 -5.5" />
            <path d="M-3 -9 L0 -6 L3 -9 M-3 9 L0 6 L3 9" />
          </g>
          <TrailerRunning />
          <Tractor accent={accent} />
        </g>
      )
    case 'flatbed':
      // A single flat deck with a stack of lumber under ratchet straps and a headboard against the cab.
      return (
        <g>
          <rect x={6} y={53} width={136} height={6} rx={2} fill={FRAME} />
          <rect x={6} y={51} width={136} height={4} fill="#6b7280" />
          <rect x={136} y={22} width={5} height={30} rx={1.5} fill="#4b5563" />
          {[0, 1, 2].map((col) => (
            [0, 1].map((row) => (
              <g key={`${col}-${row}`}>
                <rect x={14 + col * 40} y={33 + row * 9} width={38} height={9} rx={1.5} fill={accent} opacity={row === 0 ? 0.95 : 0.8} />
                <rect x={14 + col * 40} y={33 + row * 9} width={38} height={2.4} rx={1} fill="#ffffff" opacity="0.28" />
              </g>
            ))
          ))}
          <rect x={14} y={24} width={118} height={9} rx={1.5} fill={accent} opacity="0.7" />
          <Strap x={32} y1={22} y2={52} /><Strap x={72} y1={22} y2={52} /><Strap x={112} y1={22} y2={52} />
          <TrailerRunning gearX={104} />
          <Tractor accent={accent} />
        </g>
      )
    case 'stepdeck':
      // Two levels: a raised deck over the tractor, a long low deck behind it, and a tracked machine strapped on the low deck.
      return (
        <g>
          <path d="M6 55 H88 L96 45 H140 V51 H100 L93 61 H6 Z" fill={FRAME} />
          <rect x={6} y={53} width={82} height={3} fill="#6b7280" />
          <rect x={96} y={43} width={44} height={3} fill="#6b7280" />
          <rect x={136} y={30} width={5} height={14} rx={1.5} fill="#4b5563" />
          <rect x={14} y={46} width={44} height={8} rx={4} fill="#1f2937" />
          <g fill="#4b5563"><circle cx={20} cy={50} r={2} /><circle cx={36} cy={50} r={2} /><circle cx={52} cy={50} r={2} /></g>
          <rect x={20} y={33} width={30} height={13} rx={2.5} fill={accent} />
          <Shade x={20} y={33} w={30} h={13} />
          <path d="M38 33 V24 Q38 22 40 22 H48 Q50 22 50 24 V33 Z" fill={accent} />
          <rect x={40.5} y={24.5} width={7} height={6.5} rx={1} fill={GLASS} />
          <path d="M22 37 L8 28 L8 32 L20 42" stroke={accent} strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round" fill="none" />
          <Strap x={30} y1={31} y2={55} /><Strap x={44} y1={31} y2={55} />
          <rect x={102} y={32} width={30} height={11} rx={2} fill={accent} opacity="0.75" />
          <Shade x={102} y={32} w={30} h={11} />
          <Strap x={117} y1={30} y2={44} />
          <Wheel cx={24} cy={67} r={7.5} /><Wheel cx={40} cy={67} r={7.5} />
          <Tractor accent={accent} />
        </g>
      )
    case 'power':
      // A bare tractor with its sleeper, stacks and fifth wheel, and a dashed outline of the trailer it is waiting to pull.
      return (
        <g>
          <rect x={6} y={14} width={90} height={44} rx={4} fill="none" stroke="#94a3b8" strokeOpacity="0.55" strokeWidth="1.6" strokeDasharray="5 4" />
          <g transform="translate(-14 0)">
            <rect x={96} y={60} width={100} height={5} rx={2} fill={FRAME} />
            <rect x={98} y={55.5} width={34} height={5} rx={2} fill="#4b5563" />
            <path d="M104 56 L114 56 L111 60 L107 60 Z" fill="#111827" />
            <rect x={122} y={6} width={3} height={52} rx={1.5} fill={CHROME} />
            <rect x={128} y={10} width={3} height={48} rx={1.5} fill={CHROME} />
            <rect x={122} y={6} width={9} height={3.4} rx={1.2} fill="#94a3b8" />
            <rect x={124} y={22} width={28} height={40} rx={3} fill={CAB} />
            <rect x={124} y={22} width={28} height={5} rx={2} fill="#ffffff" opacity="0.4" />
            <rect x={124} y={44} width={28} height={18} fill={CAB_SHADE} opacity="0.55" />
            <rect x={124} y={36} width={28} height={5} fill={accent} />
            <rect x={132} y={50} width={20} height={9} rx={2} fill={FRAME} opacity="0.7" />
            <Cab x={152} h={34} accent={accent} />
            <rect x={156} y={50} width={24} height={8} rx={2} fill={FRAME} opacity="0.7" />
            <Wheel cx={112} r={8.5} /><Wheel cx={130} r={8.5} /><Wheel cx={188} />
          </g>
        </g>
      )
    case 'container':
      // An intermodal container on a skeleton chassis: corrugated sides, corner castings, locking bars on the door end.
      return (
        <g>
          <rect x={6} y={56} width={134} height={4} rx={1.5} fill={FRAME} />
          <rect x={6} y={60} width={134} height={2} fill={FRAME} opacity="0.5" />
          <rect x={10} y={14} width={128} height={42} rx={1.5} fill={accent} />
          <Shade x={10} y={14} w={128} h={42} />
          <Ribs x={10} y={14} w={128} h={42} n={16} />
          <rect x={10} y={14} width={128} height={3} fill="#000000" opacity="0.2" />
          <rect x={10} y={53} width={128} height={3} fill="#000000" opacity="0.2" />
          {[10, 134].map((x) => [14, 52].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width={4} height={4} fill="#111827" />))}
          <g stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.2">
            <line x1={17} y1={20} x2={17} y2={50} /><line x1={22} y1={20} x2={22} y2={50} />
          </g>
          <rect x={64} y={26} width={30} height={9} rx={1.5} fill="#ffffff" opacity="0.7" />
          <rect x={69} y={29} width={20} height={2.2} fill={accent} opacity="0.7" />
          <TrailerRunning />
          <Tractor accent={accent} />
        </g>
      )
    case 'hotshot':
      // A pickup pulling a gooseneck flatbed: the arm rises over the pickup bed, with strapped pallets on the deck and dual rear tires.
      return (
        <g>
          <rect x={6} y={52} width={86} height={5} rx={2} fill={FRAME} />
          <rect x={6} y={50} width={86} height={3.4} fill="#6b7280" />
          <path d="M92 52 L108 40 L116 40" stroke={FRAME} strokeWidth="3.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <rect x={112} y={38} width={9} height={3} rx={1.2} fill="#4b5563" />
          {[0, 1].map((col) => [0, 1].map((row) => (
            <rect key={`${col}-${row}`} x={14 + col * 34} y={32 + row * 9} width={32} height={9} rx={1.5} fill={accent} opacity={row === 0 ? 0.92 : 0.78} />
          )))}
          <Strap x={30} y1={28} y2={51} /><Strap x={64} y1={28} y2={51} />
          <path d="M106 58 V46 H124 V32 Q124 27 129 27 H147 Q152 27 155 32 L161 43 H190 Q196 43 196 49 V58 Z" fill={CAB} />
          <path d="M127 31 H146 Q149 31 151 35 L155 42 H127 Z" fill={GLASS} />
          <rect x={106} y={46} width={18} height={12} fill={CAB_SHADE} opacity="0.55" />
          <rect x={125} y={44} width={71} height={4} fill={accent} />
          <rect x={190} y={49} width={6} height={5} rx={1.4} fill="#fde68a" />
          <rect x={178} y={50} width={14} height={7} rx={1.5} fill={FRAME} opacity="0.55" />
          <path d="M106 58 H196" stroke={FRAME} strokeWidth="3" />
          <Wheel cx={24} cy={65.5} r={8} /><Wheel cx={42} cy={65.5} r={8} />
          <Wheel cx={133} cy={64} r={9} /><Wheel cx={141} cy={64} r={9} /><Wheel cx={182} cy={64} r={9} />
        </g>
      )
    case 'conestoga':
      // A flatbed under a rolling tarp: a tarp arched over hoops, with the front section slid back to show the load and the open hoops.
      return (
        <g>
          <rect x={6} y={53} width={136} height={6} rx={2} fill={FRAME} />
          <rect x={6} y={51} width={136} height={4} fill="#6b7280" />
          <rect x={104} y={30} width={34} height={21} rx={2} fill={accent} opacity="0.7" />
          <rect x={104} y={30} width={34} height={5} rx={1.5} fill="#ffffff" opacity="0.2" />
          <path d="M8 51 V34 Q8 14 28 14 H92 Q104 14 104 26 V51 Z" fill={accent} />
          <Shade x={8} y={14} w={96} h={37} />
          <g stroke="#000000" strokeOpacity="0.18" strokeWidth="1.2">
            <path d="M26 15 V51" /><path d="M46 14 V51" /><path d="M66 14 V51" /><path d="M86 14 V51" />
          </g>
          <path d="M8 40 H104" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="1.4" strokeDasharray="3 3" />
          <path d="M104 51 V24 Q104 14 114 14 Q138 14 138 38 V51" fill="none" stroke="#e5e7eb" strokeWidth="1.8" />
          <path d="M116 51 V17 M126 51 V17.5 M136 51 V30" fill="none" stroke="#e5e7eb" strokeWidth="1.4" />
          <rect x={8} y={12.5} width={128} height={2.4} rx={1.2} fill="#374151" opacity="0.5" />
          <TrailerRunning gearX={106} />
          <Tractor accent={accent} />
        </g>
      )
    case 'van':
    default:
      // The standard 53-foot trailer: smooth box with ribs, a kingpin gap to the tractor, landing gear and a tandem.
      return (
        <g>
          <rect x={6} y={58} width={134} height={4} rx={2} fill={FRAME} />
          <rect x={6} y={10} width={134} height={48} rx={4} fill={accent} />
          <Shade x={6} y={10} w={134} h={48} />
          <Ribs x={6} y={10} w={134} h={48} n={11} />
          <rect x={6} y={33} width={134} height={3} fill="#ffffff" opacity="0.5" />
          <rect x={6} y={10} width={9} height={48} rx={3} fill="#000000" opacity="0.12" />
          <rect x={130} y={10} width={10} height={48} fill="#000000" opacity="0.1" />
          <rect x={44} y={47} width={58} height={8} rx={2} fill="#000000" opacity="0.16" />
          <TrailerRunning />
          <Tractor accent={accent} />
        </g>
      )
  }
}

/** The truck drawing at the top of a capacity card: the body is tinted with the card's accent. Covered cards are drawn flat grey by the card. */
export function CapacityTruckArt({ kind, accent, label }: { kind: TruckKind; accent: string; label: string }) {
  return (
    <svg viewBox="0 0 200 76" role="img" aria-label={label} data-truck={kind} style={{ display: 'block', width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet">
      <ellipse cx="100" cy="73" rx="92" ry="3" fill="#000000" opacity="0.1" />
      <Art kind={kind} accent={accent} />
    </svg>
  )
}
