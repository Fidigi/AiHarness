export function terminalLifecycleMessages(locale: string) {
  return locale === 'fr' ? {
    input: 'Saisie du terminal refusée. Masquez puis rouvrez le terminal avant de continuer.',
    limit: 'Saisie trop volumineuse ou en attente : 64 Kio par envoi, 256 Kio et 64 envois en attente maximum.',
    connection: 'Connexion au terminal indisponible. Reconnexion sans renvoyer la saisie.',
    expired: 'Ce terminal n’est plus disponible. Créez explicitement un nouveau terminal.',
    truncated: 'Historique du terminal incomplet : reprise depuis la sortie conservée.',
  } : {
    input: 'Terminal input refused. Hide and reopen the terminal before continuing.',
    limit: 'Input too large or pending: 64 KiB per send, at most 256 KiB and 64 pending sends.',
    connection: 'Terminal connection unavailable. Reconnecting without resending input.',
    expired: 'This terminal is no longer available. Explicitly create a new terminal.',
    truncated: 'Terminal history incomplete: replaying retained output.',
  };
}
