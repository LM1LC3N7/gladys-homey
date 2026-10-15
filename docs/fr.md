# Pont Homey Pro

Cette intégration relie Gladys à **votre Homey Pro** et propose chaque appareil
Homey dans l'onglet **Découverte** de Gladys : lumières, prises, volets,
thermostats, serrures, boutons, capteurs, compteurs. Une fois un appareil
ajouté, ses états suivent Homey **en direct**, et Gladys le pilote **à travers
Homey**, qui garde ses appareils Zigbee, Z-Wave, Matter, Wi-Fi et
d'applications. Passez à Gladys à votre rythme, pièce par pièce, ou utilisez
les deux côte à côte. Tout reste sur votre réseau local. Non officiel, sans
lien avec Athom.

> **Version de développement (0.1).** Écrite d'après la documentation de l'API
> Web de Homey et testée contre un Homey Pro simulé, pas encore sur un vrai.
> Vos retours sont les bienvenus sur le dépôt GitHub.

## Quel Homey

| Homey                           | Ça marche ?                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Homey Pro (Early 2023)          | Oui : il a l'API locale et les clés d'API qu'utilise l'intégration.                    |
| Homey Pro mini                  | Probablement : même logiciel Homey Pro, avec les clés d'API. Pas encore testé.         |
| Homey Self-Hosted Server        | Probablement, s'il propose les clés d'API. Pas encore testé.                           |
| Homey Pro (Early 2019) et avant | Non : ni clés d'API ni API locale (une application de pont MQTT est la voie pour eux). |
| Homey Cloud (Homey Bridge)      | Non : il tourne dans le cloud d'Athom, il n'y a pas d'API sur votre réseau local.      |

## Ce que vous obtenez

| Capacité Homey                                                                            | Dans Gladys                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `onoff`, `dim`                                                                            | une lumière (appareil lumière, ou prise d'une lampe), sinon un interrupteur      |
| `light_hue` + `light_saturation`, `light_temperature`, `light_mode`                       | couleur (RVB) et température de couleur, celle que montre Homey                  |
| `windowcoverings_state` (haut / arrêt / bas), `windowcoverings_set`                       | un volet (ou un rideau) : ouvrir, fermer, arrêter, position                      |
| `target_temperature`, `thermostat_mode` (auto, chauffage, froid, arrêt)                   | un thermostat : consigne et mode                                                 |
| `locked`                                                                                  | une serrure                                                                      |
| `button`                                                                                  | un bouton : chaque appui est un événement pour vos scènes, et il s'actionne      |
| `measure_temperature`, `_humidity`, `_pressure`, `_luminance`, `_co2`, `_pm25`, `_noise`  | le capteur de la bonne catégorie                                                 |
| `measure_power`, `meter_power`, `measure_voltage`, `measure_current`                      | puissance et énergie (sur l'interrupteur d'une prise), tension, courant          |
| `meter_gas`, `meter_water`                                                                | un volume en m³                                                                  |
| `measure_battery`, `alarm_battery`                                                        | le niveau de batterie, batterie faible                                           |
| `alarm_motion`, `alarm_contact`, `alarm_water`, `alarm_smoke`, `alarm_co`, `alarm_tamper` | détecteurs de mouvement, d'ouverture, de fuite, de fumée, de CO et d'arrachement |

Chaque appareil Homey donne **un appareil Gladys**, nommé d'après l'appareil
et sa zone (« Lampe (Salon) ») ; son identifiant Homey, sa zone, sa classe et
son pilote sont gardés dans ses paramètres. Les sous-capacités d'un appareil
(« onoff.2 », une deuxième sortie ; « measure_temperature.outside ») deviennent
des fonctionnalités à part, nommées avec leur titre Homey. Les appareils sans
aucune de ces capacités (les enceintes, pour l'instant) sont écartés.

## Prérequis

- Un Homey Pro (Early 2023), voir plus haut, sur le même réseau local que
  Gladys.
- Une **clé d'API** de ce Homey.

## Installation

1. Ouvrez l'application web Homey (<https://my.homey.app>), **Settings → API
   Keys → New API Key** (Réglages → Clés API). Donnez-lui un nom (« Gladys »)
   et ces permissions :
   - **View devices** et **Control devices** (obligatoires) ;
   - **View zones** (la pièce dans le nom des appareils) ;
   - **View System** (les mises à jour en direct : sans elle, Gladys lit les
     appareils toutes les 10 secondes).

   Homey n'affiche la clé qu'une fois : copiez-la.

2. Dans Gladys, ouvrez l'intégration, **Configuration** :
   - **Clé d'API Homey** : collez-la.
   - **Adresse de Homey** : laissez-la vide, Gladys trouve votre Homey sur le
     réseau local. Ou saisissez son adresse IP, par exemple `192.168.1.20`. Pas
     un nom en `.local` : l'intégration tourne dans son propre conteneur et ne
     sait pas les résoudre.
3. Cliquez sur **Tester la connexion** : la version de Homey, son adresse, le
   nombre d'appareils et de zones, les appareils proposés et le fonctionnement
   des mises à jour en direct s'affichent.
4. Ouvrez l'onglet **Découverte** et ajoutez les appareils voulus. Leurs
   valeurs sont envoyées dès leur ajout.

## Options

- **Intervalle minimum entre deux mesures d'un capteur** : 10 secondes par
  défaut (0 à 300). Une prise qui remonte sa puissance chaque seconde est
  envoyée à Gladys à ce rythme. Interrupteurs, lumières, boutons, détecteurs de
  mouvement et d'ouverture ne sont jamais retardés.

## Bon à savoir

- **Homey reste aux commandes des appareils** : Gladys envoie ses ordres à
  Homey, qui les pilote. Gardez Homey allumé.
- **Mises à jour en direct** : les changements arrivent dans Gladys en moins
  d'une seconde. La liste entière est relue toutes les 5 minutes. Quand les
  mises à jour en direct sont refusées ou perdues, les appareils sont lus
  toutes les 10 secondes en attendant, et Gladys réessaie le direct en
  arrière-plan.
- **Boutons** : les boutons que Homey expose comme capacité (boutons virtuels
  de Homey, boutons de certaines applications) envoient chaque appui à vos
  scènes, et Gladys peut les actionner. La plupart des télécommandes (IKEA,
  Hue, Aqara…) n'existent dans Homey que comme déclencheurs de Flow, que l'API
  Web ne montre pas : faites un Flow Homey qui appuie sur un bouton virtuel, et
  utilisez ce bouton dans Gladys.
- **Couleurs** : une ampoule en mode couleur montre sa couleur, en mode blanc sa
  température de couleur (le `light_mode` de Homey) ; Gladys change de mode
  quand il règle l'une ou l'autre.
- **Contacts de porte** : Homey dit « alarme de contact » pour une porte
  ouverte, Gladys 0 pour ouvert et 1 pour fermé ; l'intégration convertit.
- **Badge de transport** : un appareil passe « injoignable » quand Homey l'est,
  ou quand Homey le marque indisponible (avec la raison donnée par Homey) ; un
  point orange signale que le direct est coupé et que l'état est lu toutes les
  10 secondes.
- **Appareils ajoutés, renommés ou déplacés** dans Homey : ils apparaissent dans
  Découverte en quelques secondes (au plus tard à la lecture complète
  suivante). Le bouton **Scanner** les relit tout de suite.
- **Nouvelle adresse IP** (DHCP) : quand Homey ne répond plus, Gladys le
  recherche sur le réseau par son identifiant et garde sa nouvelle adresse.

## Dépannage

| Message d'état                             | Que faire                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Homey a refusé la clé d'API                | Créez une nouvelle clé (Settings → API Keys) et collez-la.                                                   |
| Il manque une permission à la clé d'API    | Créez une clé avec View devices, Control devices, View zones et View System.                                 |
| Homey a refusé les mises à jour en direct  | Donnez la permission View System à la clé (créez-en une nouvelle). En attendant, Gladys lit toutes les 10 s. |
| Aucun Homey Pro trouvé sur le réseau       | Saisissez l'adresse IP de Homey dans la configuration.                                                       |
| Plusieurs Homey trouvés                    | Saisissez l'adresse du vôtre dans la configuration.                                                          |
| Aucun Homey Pro ne répond à cette adresse  | Vérifiez l'adresse IP. Un Homey Pro (Early 2019) ou un Homey Cloud ne peut pas être utilisé.                 |
| Homey est injoignable : connection refused | Vérifiez l'adresse, vue depuis la machine Gladys (pas `localhost`), et que Homey est allumé.                 |

Les journaux de l'intégration (Gladys, page de l'intégration) donnent le
détail.

## Vie privée

Tout reste sur votre réseau local : l'intégration ne parle qu'à votre Homey,
par son API locale. La clé d'API est stockée comme secret par Gladys et jamais
écrite dans les journaux. Homey est une marque d'Athom B.V. ; cette
intégration n'a aucun lien avec Athom.
