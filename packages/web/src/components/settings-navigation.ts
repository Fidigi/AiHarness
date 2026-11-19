import {
  isSettingsSection, type SettingsNavigation, type SettingsPosition, type SettingsSection,
} from '../store/settings-navigation';

function unique(root: Element, attribute: string, value: string | undefined, group?: Element): HTMLElement | undefined {
  if (!value) return undefined;
  // Values are compared as data, never interpolated into CSS selectors.
  const matches = Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`))
    .filter(element => element.getAttribute(attribute) === value
      && (!group || element.closest('[data-settings-group]') === group));
  return matches.length === 1 ? matches[0] : undefined;
}
function sectionElement(root: HTMLElement, section: SettingsSection): HTMLElement | undefined {
  const matches = Array.from(root.querySelectorAll<HTMLElement>('.settings-section[id]')).filter(element => element.id === section);
  return matches.length === 1 ? matches[0] : undefined;
}
export function settingsPositionTarget(root: HTMLElement, section: SettingsSection, position?: SettingsPosition): HTMLElement | undefined {
  const host = sectionElement(root, section);
  if (!host) return undefined;
  const group = unique(host, 'data-settings-group', position?.group);
  // Missing/ambiguous groups cannot borrow another group's matching row.
  const selection = !position?.group || group ? unique(group ?? host, 'data-settings-selection', position?.selection, group) : undefined;
  return selection ?? group ?? host;
}
function controlLabel(element: HTMLElement): string | null {
  const aria = element.getAttribute('aria-label');
  if (aria && aria.length <= 512) return JSON.stringify([element.localName, 'aria', aria]);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return null;
  // Direct native label text only: never read/clone control values or option text.
  const text = Array.from(element.labels ?? []).map(label => Array.from(label.childNodes)
    .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim()).join(' ').trim();
  return text && text.length <= 512 ? JSON.stringify([element.localName, 'label', text]) : null;
}
function uniqueControl(root: HTMLElement, label: string | null): HTMLElement | undefined {
  if (!label) return undefined;
  const matches = Array.from(root.querySelectorAll<HTMLElement>('[aria-label],input,select,textarea'))
    .filter(element => controlLabel(element) === label);
  return matches.length === 1 ? matches[0] : undefined;
}
function visible(element: HTMLElement): boolean {
  return element.isConnected && !element.closest('[hidden],[inert],[aria-hidden="true"]')
    && element.getClientRects().length > 0 && !element.matches(':disabled');
}
function openAncestors(element: HTMLElement, root: HTMLElement): void {
  for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
}
function focusRegion(element: HTMLElement): void {
  if (!element.matches('button,input,select,textarea,a[href],summary,[tabindex]')) element.tabIndex = -1;
  // Return into the visible fresh region, not an offscreen logical focus after
  // authority replacement has changed the scroll container's content height.
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  element.focus({ preventScroll: true });
}

/** DOM-only presentation lifetime. No control is clicked and no value is restored. */
export function bindSettingsNavigation(root: HTMLElement, initial: SettingsNavigation, options: {
  hash?: string;
  entryReady?: Promise<void>;
  save: (section: SettingsSection, position: SettingsPosition) => void;
}): () => void {
  const doc = root.ownerDocument;
  const dialogs = 'dialog,[aria-modal="true"],[role="dialog"],[role="alertdialog"]';
  const ownerDialog = root.closest(dialogs);
  const hasOtherDialog = () => Array.from(doc.querySelectorAll(dialogs)).some(dialog => dialog !== ownerDialog);
  const otherDialog = (element: Element) => {
    const dialog = element.closest(dialogs);
    return dialog === ownerDialog ? null : dialog;
  };
  const hash = options.hash?.replace(/^#/, '');
  const section = isSettingsSection(hash) ? hash : initial.section;
  const position = initial.positions[section];
  type FocusIntent = { element: HTMLElement; section: SettingsSection; position: SettingsPosition; label: string | null; action: string | null };
  let disposed = false, entryPending = true, restoringFallback = false, hashRecorded = false;
  let entryAllowed = !options.entryReady;
  let last: FocusIntent | undefined, dialogOrigin: FocusIntent | undefined;
  let pending: { intent: FocusIntent; fallback?: HTMLElement } | undefined;
  const coarse = () => window.matchMedia?.('(pointer: coarse)').matches === true;
  const recordHash = () => {
    if (!hashRecorded && isSettingsSection(hash) && sectionElement(root, hash)) {
      hashRecorded = true;
      options.save(hash, {});
    }
  };
  const restoreEntry = () => {
    if (!entryAllowed || !entryPending || disposed) return;
    recordHash();
    const target = settingsPositionTarget(root, section, position);
    if (!target) return;
    openAncestors(target, root);
    target.scrollIntoView({ block: 'start' });
    if (hash === 'mcp' && !hasOtherDialog()
      && (doc.activeElement === doc.body || doc.activeElement === root)) focusRegion(target);
    // A lazy catalogue may not yet contain the saved identity. Refine only while
    // there has been no user intent. Never substitute another resource.
    if ((!position?.selection || target.getAttribute('data-settings-selection') === position.selection)
      && (!position?.group || target.getAttribute('data-settings-group') === position.group
        || target.closest('[data-settings-group]')?.getAttribute('data-settings-group') === position.group)) entryPending = false;
  };
  const focus = (event: FocusEvent) => {
    if (restoringFallback || !(event.target instanceof HTMLElement)) return;
    // The modal's initial non-editable focus is not newer navigation intent.
    // Pointer/key intent still retires entry before a user focuses this control.
    if (entryPending && (event.target === ownerDialog
      || event.target.matches('[data-settings-entry-focus]') && ownerDialog?.contains(event.target))) return;
    entryPending = false; pending = undefined;
    // Preserve only the invoking section, never modal inputs. The dialog keeps
    // normal return ownership; navigation takes over only if its invoker retires.
    const dialog = otherDialog(event.target);
    if (dialog && root.contains(dialog)) { dialogOrigin ??= last; last = undefined; return; }
    dialogOrigin = undefined;
    if (!root.contains(event.target) || dialog) { last = undefined; return; }
    const host = event.target.closest<HTMLElement>('.settings-section[id]');
    if (!host || !isSettingsSection(host.id)) return;
    const group = event.target.closest<HTMLElement>('[data-settings-group]')?.getAttribute('data-settings-group');
    const selection = event.target.closest<HTMLElement>('[data-settings-selection]')?.getAttribute('data-settings-selection');
    const position = { ...(group ? { group } : {}), ...(selection ? { selection } : {}) };
    last = { element: event.target, section: host.id, position,
      label: controlLabel(event.target), action: event.target.getAttribute('data-settings-focus') };
    options.save(host.id, position);
  };
  const intent = (event: Event) => {
    entryPending = false;
    if (dialogOrigin && (!(event.target instanceof Element) || !otherDialog(event.target))) dialogOrigin = undefined;
    if (pending) { pending = undefined; last = undefined; }
    // A current focused control's own action may replace it. Any other intent
    // withdraws deferred return, including pointer intent that has no focus event.
    if (event.type === 'wheel' || !(event.target instanceof Node) || !last?.element.contains(event.target)
      || event instanceof KeyboardEvent && (event.key === 'Tab' || event.key === 'Escape')) last = undefined;
  };
  const changed = (records: MutationRecord[]) => {
    restoreEntry();
    if (disposed) return;
    if (dialogOrigin && !hasOtherDialog()) {
      const origin = dialogOrigin;
      if (!origin.element.isConnected && doc.activeElement === doc.body) { dialogOrigin = undefined; last = origin; }
      else if (doc.activeElement !== doc.body) dialogOrigin = undefined;
      // While the invoker is connected, leave the normal dialog return task alone.
      // Retain the handoff until that task focuses or an awaited authority change
      // retires the invoker; a closed-dialog commit may precede that change.
    }
    if (!pending && last) {
      const captured = last;
      // Unrelated lazy content must not flush geometry of a still-live control.
      // Its own content/ancestor visibility changes and disconnection still retire it.
      const visibilityMayChange = records.some(record => record.type === 'attributes'
        && record.target instanceof Element && record.target.contains(captured.element)
        || record.type === 'childList' && captured.element.contains(record.target));
      if (!captured.element.isConnected || visibilityMayChange && !visible(captured.element)) pending = { intent: captured };
    }
    if (!pending) return;
    const temporarilyOwned = doc.activeElement === pending.intent.element && !visible(pending.intent.element);
    if (doc.activeElement !== doc.body && doc.activeElement !== pending.fallback && !temporarilyOwned) {
      pending = undefined; last = undefined; return;
    }
    if (hasOtherDialog()) return;
    const intent = pending.intent;
    const target = settingsPositionTarget(root, intent.section, intent.position);
    if (!target) return;
    openAncestors(target, root);
    const complete = (!intent.position.selection || target.getAttribute('data-settings-selection') === intent.position.selection)
      && (!intent.position.group || target.getAttribute('data-settings-group') === intent.position.group
        || target.closest('[data-settings-group]')?.getAttribute('data-settings-group') === intent.position.group);
    if (!complete) {
      // A safe fallback is usable immediately, but is not a new row choice.
      // Refine only if the same fresh row arrives while this fallback is still
      // owned. Any newer pointer/key/focus intent withdraws the pending return.
      if (pending.fallback !== target && visible(target)) {
        pending.fallback = target;
        restoringFallback = true;
        try { focusRegion(target); } finally { restoringFallback = false; }
      }
      return;
    }
    const action = unique(target, 'data-settings-focus', intent.action ?? undefined);
    const label = uniqueControl(target, intent.label);
    const candidate = action ?? label ?? target;
    const editable = 'input,textarea,select,[contenteditable]';
    const region = target.matches(editable) ? sectionElement(root, intent.section) ?? root : target;
    // Coarse return must never raise an editable keyboard.
    const destination = coarse() && candidate.matches(editable) ? region : candidate;
    if (!visible(destination)) return;
    pending = undefined; last = undefined;
    focusRegion(destination);
  };
  doc.addEventListener('focusin', focus);
  doc.addEventListener('pointerdown', intent, true);
  doc.addEventListener('keydown', intent, true);
  doc.addEventListener('wheel', intent, { capture: true, passive: true });
  const observer = new MutationObserver(changed);
  observer.observe(root, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'inert', 'aria-hidden'] });
  // Record a valid address independently of focus, before a modal's own focus
  // task can retire entry refinement. It grants no configuration authority.
  recordHash();
  // The host can finish passive initialization before initial alignment without
  // delaying layout ownership, hash metadata, newer intent or context cleanup.
  void options.entryReady?.then(() => { entryAllowed = true; restoreEntry(); }, () => { entryPending = false; });
  const frame = window.requestAnimationFrame(restoreEntry);
  return () => {
    disposed = true; last = undefined; dialogOrigin = undefined; pending = undefined;
    observer.disconnect(); window.cancelAnimationFrame(frame);
    doc.removeEventListener('focusin', focus);
    doc.removeEventListener('pointerdown', intent, true);
    doc.removeEventListener('keydown', intent, true);
    doc.removeEventListener('wheel', intent, true);
  };
}
