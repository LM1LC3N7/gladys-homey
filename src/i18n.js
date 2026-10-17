// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, badges), in English and
// French. Never put the API key in one of them.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fallbackSeconds = Math.round(TIMINGS.fallbackPoll / 1000);

/** The permissions to give the API key, as the Homey web app names them. */
const PERMISSIONS = {
  en: '"View devices", "Control devices", "View zones" and "View System"',
  fr: '« View devices », « Control devices », « View zones » et « View System » (libellés anglais de Homey)',
};

/** Why Homey is unreachable, with the hint that fits. */
function unreachable(err) {
  const reason = err?.message ?? 'unknown error';
  const hints = {
    certificate: {
      en: 'Use the plain address of Homey: http:// and its IP address.',
      fr: "Utilisez l'adresse simple de Homey : http:// et son adresse IP.",
    },
    redirect: {
      en: 'Type the IP address of Homey, like http://192.168.1.20.',
      fr: "Saisissez l'adresse IP de Homey, par exemple http://192.168.1.20.",
    },
    format: {
      en: 'Is it the IP address of your Homey Pro?',
      fr: "Est-ce bien l'adresse IP de votre Homey Pro ?",
    },
  };
  const hint = hints[err?.kind] ?? {
    en: 'Check its IP address (not localhost) and that it is on. Retrying in a few seconds.',
    fr: 'Vérifiez son adresse IP (pas localhost) et qu’il est allumé. Nouvel essai dans quelques secondes.',
  };
  return {
    en: `Homey is unreachable: ${reason}. ${hint.en}`,
    fr: `Homey est injoignable : ${reason}. ${hint.fr}`,
  };
}

/** Why the realtime events are missing, with what to do. */
function liveReason(err) {
  if (err?.kind === 'auth' || err?.kind === 'forbidden') {
    return {
      en: `Homey refused the live updates (${err.message}): give the API key the "View System" permission too.`,
      fr: `Homey a refusé les mises à jour en direct (${err.message}) : donnez aussi à la clé d'API la permission « View System ».`,
    };
  }
  return {
    en: `No live updates from Homey (${err?.message ?? 'unknown error'}), retrying.`,
    fr: `Pas de mises à jour en direct de Homey (${err?.message ?? 'erreur inconnue'}), nouvel essai.`,
  };
}

const trim = (text) =>
  text.length > LIMITS.badgeMessage ? `${text.slice(0, LIMITS.badgeMessage - 1)}…` : text;

export const T = {
  noKey: {
    en: 'Paste an API key of your Homey in the configuration: Homey web app (my.homey.app), Settings → API Keys.',
    fr: "Collez une clé d'API de votre Homey dans la configuration : application web Homey (my.homey.app), Settings → API Keys.",
  },
  badAddress(reason) {
    if (reason === 'credentials') {
      return {
        en: 'No user name or password in the address: Homey uses the API key.',
        fr: "Pas d'utilisateur ni de mot de passe dans l'adresse : Homey utilise la clé d'API.",
      };
    }
    if (reason === 'cloud') {
      return {
        en: 'my.homey.app is the web app, not your Homey: type the IP address of your Homey Pro, or leave the address empty to find it on the network.',
        fr: "my.homey.app est l'application web, pas votre Homey : saisissez l'adresse IP de votre Homey Pro, ou laissez l'adresse vide pour le trouver sur le réseau.",
      };
    }
    if (reason === 'local-name') {
      return {
        en: 'Names ending in .local cannot be reached from the integration: type the IP address of Homey, or leave the address empty to find it on the network.',
        fr: "Les noms en .local ne sont pas joignables depuis l'intégration : saisissez l'adresse IP de Homey, ou laissez l'adresse vide pour le trouver sur le réseau.",
      };
    }
    return {
      en: 'The address of Homey is not valid: type its IP address, like 192.168.1.20.',
      fr: "L'adresse de Homey n'est pas valide : saisissez son adresse IP, par exemple 192.168.1.20.",
    };
  },
  /** The status of a configuration error (see normalizeConfig). */
  configError(error) {
    return error === 'no-key' ? T.noKey : T.badAddress(error);
  },
  connecting: {
    en: 'Connecting to Homey…',
    fr: 'Connexion à Homey…',
  },
  /**
   * @param {string} version the Homey software
   * @param {number} devices offered in Discovery
   * @param {'connecting'|'live'|'down'} live the realtime events
   * @param {Error} [liveError] why they are down
   */
  connected(version, devices, live, liveError) {
    const base = {
      en: `Connected to Homey${version ? ` ${version}` : ''}: ${plural(devices, 'device', 'devices')} in Discovery.`,
      fr: `Connecté à Homey${version ? ` ${version}` : ''} : ${plural(devices, 'appareil', 'appareils')} dans Découverte.`,
    };
    if (live === 'live') {
      return {
        en: `${base.en} Live updates on.`,
        fr: `${base.fr} Mises à jour en direct actives.`,
      };
    }
    if (live === 'down') {
      const why = liveReason(liveError);
      return {
        en: `${base.en} ${why.en} Meanwhile the devices are read every ${fallbackSeconds} s.`,
        fr: `${base.fr} ${why.fr} En attendant, les appareils sont lus toutes les ${fallbackSeconds} s.`,
      };
    }
    return base;
  },
  /** The status of a failed call (a HomeyError). */
  failure(err) {
    switch (err?.kind) {
      case 'auth':
        return {
          en: 'Homey refused the API key: create a new one in the Homey web app (Settings → API Keys) and paste it in the configuration.',
          fr: "Homey a refusé la clé d'API : créez-en une nouvelle dans l'application web Homey (Settings → API Keys) et collez-la dans la configuration.",
        };
      case 'forbidden':
        return {
          en: `The API key lacks a permission (${err.message}): create one with ${PERMISSIONS.en}.`,
          fr: `Il manque une permission à la clé d'API (${err.message}) : créez-en une avec ${PERMISSIONS.fr}.`,
        };
      case 'not-homey':
        return {
          en: `No Homey Pro answers at this address (${err.message}). Type the IP address of your Homey Pro (2023), or leave the address empty to find it on the network.`,
          fr: `Aucun Homey Pro ne répond à cette adresse (${err.message}). Saisissez l'adresse IP de votre Homey Pro (2023), ou laissez l'adresse vide pour le trouver sur le réseau.`,
        };
      case 'not-found':
        return {
          en: 'No Homey Pro found on the network: type its IP address in the configuration.',
          fr: 'Aucun Homey Pro trouvé sur le réseau : saisissez son adresse IP dans la configuration.',
        };
      case 'several':
        return {
          en: `Several Homeys found (${err.message}): type the address of yours in the configuration.`,
          fr: `Plusieurs Homey trouvés (${err.message}) : saisissez l'adresse du vôtre dans la configuration.`,
        };
      case 'discovery':
        return {
          en: `Gladys could not look for Homey on the network (${err.message}): type its IP address in the configuration.`,
          fr: `Gladys n'a pas pu chercher Homey sur le réseau (${err.message}) : saisissez son adresse IP dans la configuration.`,
        };
      case 'api':
      case 'notfound':
        return {
          en: `Homey answered with an error: ${err.message}.`,
          fr: `Homey a répondu par une erreur : ${err.message}.`,
        };
      default:
        return unreachable(err);
    }
  },
  test: {
    ok: ({ version, url, devices, total, empty, zones, live }) => {
      const zonesText =
        zones === undefined
          ? {
              en: 'zones not readable (no "View zones" permission)',
              fr: 'zones illisibles (pas de permission « View zones »)',
            }
          : { en: plural(zones, 'zone', 'zones'), fr: plural(zones, 'zone', 'zones') };
      const liveText = live.ok
        ? { en: 'Live updates: OK.', fr: 'Mises à jour en direct : OK.' }
        : liveReason(live.error);
      return {
        en:
          `Connection OK, Homey${version ? ` ${version}` : ''} at ${url}: ${plural(total, 'device', 'devices')}, ${zonesText.en}. ` +
          `${plural(devices, 'device', 'devices')} offered in Discovery` +
          (empty > 0 ? `, ${empty} left out (nothing Gladys can show yet). ` : '. ') +
          liveText.en,
        fr:
          `Connexion OK, Homey${version ? ` ${version}` : ''} à ${url} : ${plural(total, 'appareil', 'appareils')}, ${zonesText.fr}. ` +
          `${plural(devices, 'appareil proposé', 'appareils proposés')} dans Découverte` +
          (empty > 0
            ? `, ${empty} écarté${empty === 1 ? '' : 's'} (rien que Gladys sache afficher pour l'instant). `
            : '. ') +
          liveText.fr,
      };
    },
  },
  badge: {
    unavailable: (message) => {
      const text = String(message ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return text
        ? {
            en: trim(`Unavailable in Homey: ${text}`),
            fr: trim(`Indisponible dans Homey : ${text}`),
          }
        : {
            en: 'Homey marks this device as unavailable.',
            fr: 'Homey indique que cet appareil est indisponible.',
          };
    },
    noLive: {
      en: `No live updates from Homey: the state is read every ${fallbackSeconds} seconds.`,
      fr: `Pas de mises à jour en direct de Homey : l'état est lu toutes les ${fallbackSeconds} secondes.`,
    },
  },
};

/**
 * The labels of the options of guarded commands, exactly as in the manifest
 * (checked by test/manifest.test.js): option -> [manifest key, label].
 */
export const GUARD_OPTIONS = {
  lock: [
    'allow_unlock',
    { en: 'Allow unlocking from Gladys', fr: 'Autoriser le déverrouillage depuis Gladys' },
  ],
  garage: [
    'allow_garage_door_control',
    {
      en: 'Allow garage door and gate control from Gladys',
      fr: 'Autoriser le pilotage des portes de garage et portails depuis Gladys',
    },
  ],
  valve: [
    'allow_valve_control',
    {
      en: 'Allow valve and sprinkler control from Gladys',
      fr: "Autoriser le pilotage des vannes et de l'arrosage depuis Gladys",
    },
  ],
  alarm: [
    'allow_alarm_control',
    {
      en: 'Allow alarm and siren control from Gladys',
      fr: 'Autoriser le pilotage des alarmes et sirènes depuis Gladys',
    },
  ],
};

/** The refusals of a command: the ack of Gladys carries one text, given in both languages. */
const both = (en, fr) => `${en} / ${fr}`;
export const REFUSALS = {
  denied: (option) => {
    const label = GUARD_OPTIONS[option][1];
    return both(
      `Command refused: turn on "${label.en}" in the Homey integration settings.`,
      `Commande refusée : activez « ${label.fr} » dans les réglages de l'intégration Homey.`,
    );
  },
  tooSlow: both(
    'Homey answered too slowly: command not sent.',
    'Homey a répondu trop lentement : commande non envoyée.',
  ),
  unknownDevice: both(
    'This device is not known to Homey right now: command refused.',
    "Cet appareil n'est pas connu de Homey en ce moment : commande refusée.",
  ),
  noAnswer: both(
    'State unknown, Homey did not answer: command refused.',
    "État inconnu, Homey n'a pas répondu : commande refusée.",
  ),
  unknownState: both('State unknown: command refused.', 'État inconnu : commande refusée.'),
  unavailable: both(
    'The device is unavailable in Homey, its state may be stale: command refused.',
    "L'appareil est indisponible dans Homey, son état est peut-être périmé : commande refusée.",
  ),
};
