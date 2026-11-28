/* eslint-disable no-restricted-syntax -- data colour: the per-card identity palette and the truck drawing (a picture, not UI chrome) */
import type { TruckKind } from './capacityCardStyle'

const CAB = '#e8ebf0'
const CAB_SHADE = '#c3c9d3'
const GLASS = '#8fb4d8'
const FRAME = '#374151'
const TIRE = '#1f2937'
const HUB = '#aab2bf'

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

function Chassis({ x1, x2 }: { x1: number; x2: number }) {
  return <rect x={x1} y={60} width={x2 - x1} height={5} rx={2} fill={FRAME} />
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

function Art({ kind, accent }: { kind: TruckKind; accent: string }) {
  switch (kind) {
    case 'box':
      return (
        <g>
          <Chassis x1={14} x2={196} />
          <rect x={20} y={14} width={124} height={46} rx={4} fill={accent} />
          <Shade x={20} y={14} w={124} h={46} />
          <rect x={26} y={20} width={4} height={34} rx={2} fill="#000000" opacity="0.14" />
          <path d="M138 26 H141 V56 H138 Z" fill="#000000" opacity="0.18" />
          <Cab x={146} h={36} accent={accent} />
          <Wheel cx={42} /><Wheel cx={60} /><Wheel cx={172} />
        </g>
      )
    case 'reefer':
      return (
        <g>
          <Chassis x1={8} x2={150} />
          <rect x={8} y={10} width={136} height={50} rx={4} fill={accent} />
          <Shade x={8} y={10} w={136} h={50} />
          <rect x={134} y={14} width={8} height={18} rx={2} fill="#ffffff" opacity="0.85" />
          <g stroke="#ffffff" strokeOpacity="0.8" strokeWidth="1.4">
            <line x1={136} y1={18} x2={140} y2={18} /><line x1={136} y1={22} x2={140} y2={22} /><line x1={136} y1={26} x2={140} y2={26} />
          </g>
          <g stroke="#ffffff" strokeOpacity="0.9" strokeWidth="2" strokeLinecap="round" fill="none" transform="translate(72 36)">
            <path d="M0 -11 V11 M-9.5 -5.5 L9.5 5.5 M-9.5 5.5 L9.5 -5.5" />
            <path d="M-3 -9 L0 -6 L3 -9 M-3 9 L0 6 L3 9" />
          </g>
          <Cab accent={accent} />
          <Wheel cx={26} /><Wheel cx={44} /><Wheel cx={168} />
        </g>
      )
    case 'flatbed':
      return (
        <g>
          <rect x={6} y={52} width={146} height={8} rx={2} fill={FRAME} />
          <rect x={6} y={50} width={146} height={4} fill={accent} />
          <rect x={14} y={30} width={50} height={20} rx={2} fill={accent} opacity="0.92" />
          <Shade x={14} y={30} w={50} h={20} />
          <rect x={68} y={36} width={44} height={14} rx={2} fill={accent} opacity="0.75" />
          <Shade x={68} y={36} w={44} h={14} />
          <rect x={118} y={22} width={5} height={28} rx={1} fill="#6b7280" />
          <Cab accent={accent} />
          <Wheel cx={26} /><Wheel cx={44} /><Wheel cx={168} />
        </g>
      )
    case 'stepdeck':
      return (
        <g>
          <path d="M6 56 H92 V48 H152 V56 Z" fill={FRAME} />
          <rect x={6} y={54} width={86} height={4} fill={accent} />
          <rect x={92} y={46} width={60} height={4} fill={accent} />
          <rect x={14} y={34} width={42} height={20} rx={2} fill={accent} opacity="0.92" />
          <Shade x={14} y={34} w={42} h={20} />
          <rect x={96} y={30} width={44} height={16} rx={2} fill={accent} opacity="0.75" />
          <Shade x={96} y={30} w={44} h={16} />
          <Cab accent={accent} />
          <Wheel cx={26} /><Wheel cx={44} /><Wheel cx={168} />
        </g>
      )
    case 'power':
      return (
        <g>
          <Chassis x1={100} x2={196} />
          <rect x={102} y={54} width={30} height={7} rx={2} fill={FRAME} />
          <circle cx={117} cy={53} r={6} fill="#9ca3af" />
          <Cab x={124} h={44} accent={accent} />
          <rect x={112} y={20} width={12} height={34} rx={2} fill={accent} opacity="0.9" />
          <Wheel cx={114} /><Wheel cx={134} /><Wheel cx={172} />
        </g>
      )
    case 'container':
      return (
        <g>
          <rect x={6} y={56} width={146} height={5} rx={2} fill={FRAME} />
          <rect x={10} y={12} width={136} height={44} rx={2} fill={accent} />
          <Shade x={10} y={12} w={136} h={44} />
          <Ribs x={10} y={12} w={136} h={44} n={14} />
          <rect x={10} y={12} width={136} height={4} fill="#000000" opacity="0.18" />
          <rect x={10} y={52} width={136} height={4} fill="#000000" opacity="0.18" />
          <Cab accent={accent} />
          <Wheel cx={26} /><Wheel cx={44} /><Wheel cx={168} />
        </g>
      )
    case 'hotshot':
      return (
        <g>
          <path d="M96 62 V30 Q96 24 102 24 H136 Q142 24 146 31 L156 44 V62 Z" fill={CAB} />
          <path d="M104 29 H136 Q140 29 143 34 L148 42 H104 Z" fill={GLASS} />
          <path d="M100 62 V44 H156 V62 Z" fill={CAB_SHADE} opacity="0.55" />
          <rect x={100} y={46} width={56} height={4} fill={accent} />
          <rect x={150} y={51} width={9} height={6} rx={1} fill={FRAME} opacity="0.7" />
          <rect x={10} y={50} width={96} height={6} rx={2} fill={FRAME} />
          <rect x={10} y={48} width={96} height={4} fill={accent} />
          <path d="M100 44 L112 38 V30 H108" stroke={FRAME} strokeWidth="3" fill="none" strokeLinecap="round" />
          <rect x={20} y={32} width={42} height={16} rx={2} fill={accent} opacity="0.85" />
          <Shade x={20} y={32} w={42} h={16} />
          <Wheel cx={28} cy={64} r={8} /><Wheel cx={46} cy={64} r={8} /><Wheel cx={112} cy={64} r={9} /><Wheel cx={146} cy={64} r={9} />
        </g>
      )
    case 'conestoga':
      return (
        <g>
          <rect x={6} y={52} width={146} height={8} rx={2} fill={FRAME} />
          <path d="M10 52 V32 Q10 12 30 12 H124 Q144 12 144 32 V52 Z" fill={accent} />
          <Shade x={10} y={12} w={134} h={40} />
          <g stroke="#000000" strokeOpacity="0.16" strokeWidth="1.2">
            <path d="M44 14 V52" /><path d="M78 12 V52" /><path d="M112 14 V52" />
          </g>
          <path d="M10 34 H144" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="1.4" />
          <Cab accent={accent} />
          <Wheel cx={26} /><Wheel cx={44} /><Wheel cx={168} />
        </g>
      )
    case 'van':
    default:
      return (
        <g>
          <Chassis x1={8} x2={150} />
          <rect x={8} y={10} width={136} height={50} rx={4} fill={accent} />
          <Shade x={8} y={10} w={136} h={50} />
          <Ribs x={8} y={10} w={136} h={50} n={9} />
          <rect x={8} y={34} width={136} height={3} fill="#ffffff" opacity="0.5" />
          <rect x={126} y={10} width={18} height={50} fill="#000000" opacity="0.1" />
          <Cab accent={accent} />
          <Wheel cx={26} /><Wheel cx={44} /><Wheel cx={168} />
        </g>
      )
  }
}

/** The truck drawing at the top of a capacity card: the body is tinted with the card's accent. Covered cards are drawn flat grey by the card. */
export function CapacityTruckArt({ kind, accent, label }: { kind: TruckKind; accent: string; label: string }) {
  return (
    <svg viewBox="0 0 200 76" role="img" aria-label={label} data-truck={kind} style={{ display: 'block', width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet">
      <ellipse cx="100" cy="72" rx="92" ry="3.5" fill="#000000" opacity="0.1" />
      <Art kind={kind} accent={accent} />
    </svg>
  )
}
