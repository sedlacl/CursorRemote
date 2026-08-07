import React from 'react';

const SVG_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export interface ModeIconProps {
  modeId: string;
  size?: number;
  className?: string;
}

export function ModeIcon({ modeId, size = 16, className }: ModeIconProps) {
  const svgProps = { ...SVG_PROPS, width: size, height: size, className };

  switch (modeId) {
    case 'agent':
      return (
        <svg {...svgProps}>
          <path d="M12 12c-2-3-3.5-4-5.5-4a4 4 0 1 0 0 8c2 0 3.5-1 5.5-4Z" />
          <path d="M12 12c2 3 3.5 4 5.5 4a4 4 0 1 0 0-8c-2 0-3.5 1-5.5 4Z" />
        </svg>
      );
    case 'plan':
      return (
        <svg {...svgProps}>
          <circle cx="5" cy="8" r="2" />
          <path d="M9 8h11" />
          <circle cx="5" cy="16" r="2" />
          <path d="M9 16h8" />
        </svg>
      );
    case 'debug':
      return (
        <svg {...svgProps}>
          <path d="M9.5 5.5 8 3.5M14.5 5.5l1.5-2" />
          <path d="M8 9 5 7.5M8 12H4.5M8 15l-3 1.5" />
          <path d="m16 9 3-1.5M16 12h3.5M16 15l3 1.5" />
          <path d="M12 6v13" />
          <path d="M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0Z" />
        </svg>
      );
    case 'multitask':
      return (
        <svg {...svgProps}>
          <path d="M15 6.7a7.5 7.5 0 1 0 4.2 6.7" />
          <path d="M11 3.5A10 10 0 0 1 21 11" />
        </svg>
      );
    case 'chat':
    case 'ask':
      return (
        <svg {...svgProps}>
          <path d="M7 5h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 3V8a3 3 0 0 1 3-3Z" />
        </svg>
      );
    default:
      return null;
  }
}
