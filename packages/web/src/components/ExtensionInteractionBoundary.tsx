import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import type { ExtensionInteractionSnapshot } from '@ai-harness/core';
import type { TranslationFunction } from '../i18n/types';

export interface ExtensionInteractionDialogProps {
  request: ExtensionInteractionSnapshot;
  waitingCount: number;
  onResolve(response: { cancelled: boolean; value?: unknown }): Promise<void>;
  restoreFocusRef: RefObject<HTMLElement | null>;
  canRestoreFocus?(): boolean;
  canFocusInitially?(): boolean;
  renderOutput(content: string): ReactNode;
  t: TranslationFunction;
}
interface BoundaryProps extends Omit<ExtensionInteractionDialogProps, 'onResolve'> {
  locale: string;
  onResolve(response: { cancelled: boolean; value?: unknown }, signal: AbortSignal): Promise<void>;
}
export function interactionLoadingMessages(locale: string) {
  return locale === 'fr' ? {
    retry: 'Recharger et réessayer',
    warning: 'Copiez votre texte non envoyé avant de recharger la page : il risque d’être perdu.',
  } : {
    retry: 'Reload and retry',
    warning: 'Copy unsent text before reloading the page: it may be lost.',
  };
}
type Renderer = ComponentType<ExtensionInteractionDialogProps>;
let renderer: Renderer | undefined;
let pending: Promise<Renderer> | undefined;
function loadRenderer(): Promise<Renderer> {
  return pending ??= import('./ExtensionInteractionDialog').then(module => {
    renderer = module.default;
    return renderer;
  });
}
export default function ExtensionInteractionBoundary(props: BoundaryProps) {
  const [Renderer, setRenderer] = useState<Renderer | undefined>(() => renderer);
  const [failed, setFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const requestKey = JSON.stringify(props.request);
  const focusKey = JSON.stringify([props.request.id, props.request.kind]);
  const focusAdmission = useRef({ key: focusKey, allowed: true });
  if (focusAdmission.current.key !== focusKey) focusAdmission.current = { key: focusKey, allowed: true };
  const ready = useRef(Boolean(Renderer));
  ready.current = Boolean(Renderer);
  useLayoutEffect(() => {
    // Observe intent before the optional renderer exists, including focus followed by blur.
    const rememberFocus = () => { if (!ready.current) focusAdmission.current.allowed = false; };
    document.addEventListener('focusin', rememberFocus, true);
    return () => document.removeEventListener('focusin', rememberFocus, true);
  }, []);
  const lifetime = useRef({ key: requestKey, controller: new AbortController() });
  if (lifetime.current.key !== requestKey) {
    lifetime.current.controller.abort();
    lifetime.current = { key: requestKey, controller: new AbortController() };
  }
  useLayoutEffect(() => {
    if (lifetime.current.controller.signal.aborted) lifetime.current.controller = new AbortController();
    return () => lifetime.current.controller.abort();
  }, []);
  useEffect(() => {
    let mounted = true;
    void loadRenderer().then(component => {
      if (mounted) setRenderer(() => component);
    }, () => { if (mounted) setFailed(true); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => { setCancelling(false); }, [requestKey]);
  const resolve = async (response: { cancelled: boolean; value?: unknown }) => {
    const signal = lifetime.current.controller.signal;
    if (!signal.aborted) await props.onResolve(response, signal);
  };
  if (Renderer) return <Renderer {...props} onResolve={resolve}
    canFocusInitially={() => focusAdmission.current.allowed && props.canFocusInitially?.() !== false} />;
  const cancel = () => {
    if (cancelling) return;
    setCancelling(true);
    const current = lifetime.current;
    void resolve({ cancelled: true }).finally(() => {
      if (!current.controller.signal.aborted && lifetime.current === current) setCancelling(false);
    });
  };
  const messages = interactionLoadingMessages(props.locale);
  // Loading grants neither a modal nor a focus trap. Its rejection stays cached.
  return <section className="session-info" aria-label={props.request.title} aria-busy={!failed}>
    <h3>{props.request.title}</h3>
    {props.waitingCount > 0 && <p>{props.t('chat.extensionInteraction.waiting', { count: props.waitingCount })}</p>}
    {props.request.message && <p>{props.request.message}</p>}
    <p role="status">{props.t(failed ? 'chat.extensionInteractionFailed' : 'common.loading')}</p>
    <button type="button" disabled={cancelling} onClick={cancel}>{props.t('common.close')}</button>
    <button type="button" disabled={cancelling} onClick={cancel}>{props.t('common.cancel')}</button>
    {failed && <><p>{messages.warning}</p><button type="button" onClick={() => window.location.reload()}>{messages.retry}</button></>}
  </section>;
}
