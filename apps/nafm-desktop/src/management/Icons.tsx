import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function DriveIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 15h.01M11 15h6" /></IconBase>;
}

export function NetworkIcon(props: IconProps) {
  return <IconBase {...props}><path d="M5 18h14M7 14a7 7 0 0 1 10 0M9.5 10.5a3.6 3.6 0 0 1 5 0" /><circle cx="12" cy="17.5" r=".8" fill="currentColor" stroke="none" /></IconBase>;
}

export function CloseIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" /></IconBase>;
}

export function SearchIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="10" cy="10" r="6" /><path d="m14.5 14.5 5 5" /></IconBase>;
}

export function WarningIcon(props: IconProps) {
  return <IconBase {...props}><path d="M10.3 4.1 2.7 18a2 2 0 0 0 1.8 3h15a2 2 0 0 0 1.8-3L13.7 4.1a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></IconBase>;
}

export function RefreshIcon(props: IconProps) {
  return <IconBase {...props}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 8a7 7 0 0 1 11.5-1L20 12M4 12l2.4 5a7 7 0 0 0 11.5-1" /></IconBase>;
}

export function CheckIcon(props: IconProps) {
  return <IconBase {...props}><path d="m5 12 4 4L19 6" /></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 5v14M5 12h14" /></IconBase>;
}

export function OpenInIcon(props: IconProps) {
  return <IconBase {...props}><path d="M13 4h7v7m0-7L10 14M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4" /></IconBase>;
}

export function FolderIcon(props: IconProps) {
  return <IconBase {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></IconBase>;
}

export function TerminalIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h3" /></IconBase>;
}

export function WorkspaceIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M8 9v11" /></IconBase>;
}

export function TrashIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></IconBase>;
}
