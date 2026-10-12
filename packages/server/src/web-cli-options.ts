const DEFAULT_PORT = 3080;
const DEFAULT_HOSTNAME = '127.0.0.1';

export interface WebCliOptions {
  port: number;
  hostname: string;
  noOpen: boolean;
  help: boolean;
}

function parsePort(value: string | undefined, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Port invalide pour ${source} : ${value ?? ''}`);
  }
  return port;
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** Parse Web launcher startup flags. Command-line values override the environment. */
export function parseWebCliArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): WebCliOptions {
  const environmentPort = environment.AI_HARNESS_WEB_PORT || environment.WEB_PORT || environment.PORT;
  let port = environmentPort ? parsePort(environmentPort, 'la variable d’environnement') : DEFAULT_PORT;
  let hostname = environment.AI_HARNESS_WEB_HOSTNAME || environment.WEB_HOSTNAME || DEFAULT_HOSTNAME;
  let noOpen = isEnabled(environment.AI_HARNESS_WEB_NO_OPEN) || isEnabled(environment.WEB_NO_OPEN);
  let help = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--no-open') {
      noOpen = true;
    } else if (argument === '--port' || argument === '-p') {
      port = parsePort(args[++index], argument);
    } else if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length), '--port');
    } else if (argument === '--hostname' || argument === '-H') {
      hostname = args[++index]?.trim() || '';
      if (!hostname) throw new Error(`Valeur manquante pour ${argument}`);
    } else if (argument.startsWith('--hostname=')) {
      hostname = argument.slice('--hostname='.length).trim();
      if (!hostname) throw new Error('Valeur manquante pour --hostname');
    } else {
      throw new Error(`Option inconnue : ${argument}`);
    }
  }

  return { port, hostname, noOpen, help };
}

export function webCliHelp(): string {
  return `AiHarness Web

Usage : ai-harness-web [options]

Options :
  -h, --help              Afficher cette aide
  -p, --port <port>       Port HTTP (défaut : 3080)
  -H, --hostname <hôte>   Adresse d’écoute (défaut : 127.0.0.1)
      --no-open           Ne pas ouvrir le navigateur

Variables d’environnement :
  AI_HARNESS_WEB_PORT       Port HTTP (alias : WEB_PORT, PORT)
  AI_HARNESS_WEB_HOSTNAME   Adresse d’écoute (alias : WEB_HOSTNAME)
  AI_HARNESS_WEB_NO_OPEN=1  Désactiver l’ouverture du navigateur
  AI_HARNESS_AUTH_TOKEN     Protéger les routes API avec un Bearer token
  AI_HARNESS_ADMIN_TOKEN    Token administrateur pour les credentials
  AI_HARNESS_MASTER_KEY     Chiffrer les credentials persistants
`;
}
