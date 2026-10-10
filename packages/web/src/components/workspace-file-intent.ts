// Presentation intent only: the real file panel still owns path/trust/read admission.
export function openWorkspaceFile(reference: string, origin: Element): void {
  const href = window.location.href;
  window.dispatchEvent(new CustomEvent('aih-show-files'));
  // Showing the pane must commit before its loading listener receives the intent.
  // The originating link and address must still own this later task: navigation
  // may already have mounted another boundary before the task gets to run.
  window.setTimeout(() => {
    if (!origin.isConnected || window.location.href !== href) return;
    window.dispatchEvent(new CustomEvent('aih-open-file', { detail: reference }));
  }, 0);
}
