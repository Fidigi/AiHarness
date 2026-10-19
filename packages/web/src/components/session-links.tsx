import type { MouseEvent } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

export function sessionLinkTo(sessionId: string, cwd?: string, messageId?: string): string {
  return `/chat/${encodeURIComponent(sessionId)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}${messageId ? `#${encodeURIComponent(messageId)}` : ''}`;
}

export function projectLinkTo(cwd: string): string {
  return `/?cwd=${encodeURIComponent(cwd)}`;
}

export interface LinkActivation {
  button: number;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}
export function isPlainLinkActivation(event: LinkActivation): boolean {
  return event.button === 0 && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

export interface SessionContextMenuTarget {
  sessionId: string;
  cwd?: string;
  /** The actual router-produced href, including any configured basename, never an auth URL. */
  href: string;
}
export type SessionContextMenuHook = (event: MouseEvent<HTMLAnchorElement>, target: Readonly<SessionContextMenuTarget>) => void;

interface SessionLinkProps extends Omit<LinkProps, 'to' | 'onContextMenu'> {
  sessionId: string;
  cwd?: string;
  messageId?: string;
  onSessionContextMenu?: SessionContextMenuHook;
}

/** Native modified/new-tab activation stays with the browser. A host callback
 * can replace a context menu, but this presentation hook sends no API command. */
export function SessionLink({ sessionId, cwd, messageId, onSessionContextMenu, ...props }: SessionLinkProps) {
  return <Link {...props} to={sessionLinkTo(sessionId, cwd, messageId)} onContextMenu={event => {
    onSessionContextMenu?.(event, { sessionId, cwd, href: event.currentTarget.getAttribute('href') ?? '' });
  }} />;
}
