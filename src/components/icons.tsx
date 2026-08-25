// Icon set for the app shell (SPEC design: warm Yoto-inspired theme).
// Stroke-based, 1.75px weight, 24x24 viewBox — keep new icons consistent with these.
import type { SVGProps } from "react";

const base = {
  width: 19,
  height: 19,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11 12 4.5 20 11" />
      <path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

export function PodcastsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 13.5v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13" width="4.2" height="6" rx="2" />
      <rect x="16.8" y="13" width="4.2" height="6" rx="2" />
    </svg>
  );
}

/** Card sliding into a slot — depicts inserting a Yoto card into the player. */
export function CardsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="8" y="2" width="8" height="6.5" rx="1.4" />
      <path d="M12 10v4.2" />
      <path d="M9.3 12.6 12 15.3l2.7-2.7" />
      <path d="M5.5 19h13" />
    </svg>
  );
}

export function ActivityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h3.5l2 7 4-15 2 8h4.5" />
    </svg>
  );
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} strokeLinecap="round" {...props}>
      <line x1="4" y1="6.5" x2="20" y2="6.5" />
      <circle cx="14.5" cy="6.5" r="2.1" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="9" cy="12" r="2.1" fill="currentColor" stroke="none" />
      <line x1="4" y1="17.5" x2="20" y2="17.5" />
      <circle cx="16" cy="17.5" r="2.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SignInIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function LogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="9" cy="10" r="1.5" fill="#fff" />
      <circle cx="15" cy="10" r="1.5" fill="#fff" />
      <path d="M8 15c1.2 1.1 2.6 1.7 4 1.7s2.8-.6 4-1.7" stroke="#fff" strokeWidth={1.75} strokeLinecap="round" />
    </svg>
  );
}
