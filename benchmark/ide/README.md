# Benchmark IDE de NCE

Cette suite mesure l'application Electron réelle : processus principal, fenêtre Electron, preload, renderer, contrôleurs et DOM. Les fichiers et workspaces générés sont déterministes et restent dans `.benchmark-data/ide/`, ignoré par Git. Le benchmark agent existant reste isolé dans `benchmark/agent`.

## Commandes

```powershell
npm run benchmark:quick
npm run benchmark:startup
npm run benchmark:editor
npm run benchmark:memory
npm run benchmark:full -- --machine hp-2gb
npm run benchmark:ide -- --mode standard --group files,tabs
npm run benchmark:ide -- --scenario file.open.large --verbose
npm run benchmark:ide -- --mode quick --scenario file.open.small --output .benchmark-data/ide/results/small.json
npm run benchmark:quick -- --output .benchmark-data/ide/results/quick.json
npm run benchmark:full -- --output .benchmark-data/ide/results/full.json
npm run benchmark:compare -- .benchmark-data/ide/results/before.json .benchmark-data/ide/results/after.json
```

`npm run benchmark` lance le mode standard. Les anciens évaluateurs restent accessibles avec `npm run benchmark:agent`, `npm run benchmark:validate`, `npm run benchmark:report` et `npm run benchmark:agent:compare`.

Les résultats JSON et Markdown sont écrits dans `.benchmark-data/ide/results/`. Chaque échantillon est sauvegardé au fil de l'exécution ; les résultats terminés avant un crash restent lisibles. Les options utiles sont `--mode`, `--group`, `--scenario`, `--machine`, `--output`, `--timeout`, `--quiet`, `--verbose`, `--debug` et `--list`.

## Intensités et fixtures

| Mode | Couverture représentative |
|---|---|
| quick | Démarrage x3, 1k et 10k lignes, ligne de 100k caractères, changement d'onglet, frappe, scroll, recherche |
| standard | Démarrage x5, workspace 50/2 000 fichiers, fichiers jusqu'à 100k lignes, tabs, saisie, curseur, Select All, recherche, mémoire et DOM |
| full | Démarrage x10, workspace jusqu'à 20 000 fichiers, fichier 500k/1M lignes, fichier 50 MB, ligne de 1M caractères, Unicode, mémoire répétée et recherche |

Pour générer les fixtures séparément :

```powershell
npm run benchmark:ide:fixtures -- --profile quick
npm run benchmark:ide:fixtures -- --profile standard
npm run benchmark:ide:fixtures -- --profile full
npm run benchmark:ide:fixtures -- --profile full --extreme
npm run benchmark:ide:clean
```

Le scénario `file.open.small` peut être exécuté seul dans un profil quick et écrit séparément du run quick complet. Le workspace de 100 000 fichiers n'est créé que si `--extreme` est fourni. Pour le mesurer, lancer `npm run benchmark:ide -- --mode full --extreme --scenario workspace.open.extreme`. Le nettoyage ne supprime que les fixtures et profils temporaires sous `.benchmark-data/ide`; il conserve les rapports.

## Mesures

- **Démarrage** : chaque échantillon démarre un nouveau processus Electron avec un profil utilisateur et une session isolés. Le runner mesure le lancement jusqu'à la fenêtre DevTools, l'initialisation de l'éditeur et deux frames stables. Les phases `app-ready`, création de BrowserWindow, `ready-to-show`, DOM prêt et `rendererReady` sont mesurées avec l'horloge monotone du processus principal.
- **Fenêtre** : NCE n'a qu'une fenêtre ; le scénario utilise son vrai chemin de création pendant le démarrage. Aucun comportement multi-fenêtre artificiel n'est ajouté.
- **Ouverture de fichier** : sépare la résolution de `TabManager.openFileWithPath`, le chargement complet attendu via `FileLoader.waitForFileLoaded`, puis deux RAF après la fin du modèle. `fileOpenRequestMs`, `fileModelReadyMs` et `fileStableRenderMs` distinguent ces étapes. Les validations vérifient les lignes du modèle, les octets lus et les lignes signalées par les chunks.
- **Interactions** : la frappe, Backspace, Enter, les flèches, Select All et la molette passent par des événements CDP envoyés à la vraie fenêtre. `actionDurationMs`, `rendererLogicalMs` et `inputToStableFrameMs` sont séparés. Select All valide sa plage et sa longueur logiques sans construire le texte ; les scénarios copy mesurent volontairement le chemin réel de copie.
- **Scroll et activité idle** : les scénarios de scroll envoient huit événements wheel à 100 ms d'intervalle pendant qu'un observateur RAF actif relève les intervalles et les long tasks. `idle.activity` attend sans créer de boucle RAF et compare les diagnostics renderer/main avant et après. Une attente idle n'implique pas que les propres tâches de NCE ou de Chromium soient inactives.
- **Onglets, recherche et workspace** : les méthodes de `TabManager`, `SearchController` et `FileExplorer` sont utilisées dans l'application Electron. Les workspaces sont chargés par le véritable explorer et son watcher.
- **Mémoire et CPU** : le rapport distingue le heap JS du renderer, le RSS du main process et, si Electron l'expose, la mémoire privée des processus Electron. Le CPU vient de snapshots cumulatifs `process.cpuUsage()` (microsecondes), associés à des timestamps monotones du même processus. `mainCpuTotalMs` additionne les deltas user/system ; `mainCpuCoreEquivalentPercent` vaut CPU ms / fenêtre ms × 100 et peut dépasser 100 % ; `mainCpuNormalizedPercent` divise ce résultat par les logical CPUs. Une mesure hors borne théorique est nulle, marquée invalide et diagnostiquée, jamais clampée. Le scénario de fermeture demande un GC via DevTools ; ce chiffre est une observation après GC, pas une preuve de fuite. Les working sets partagés ne sont pas additionnés.
- **DOM et frames** : les scénarios DOM reportent le compte observé sans imposer un nombre exact fragile ; le cas 100k lignes vérifie seulement un seuil large de virtualisation. Le premier callback RAF initialise l'horloge ; `frameIntervals` compte uniquement les différences entre callbacks consécutifs. Les deltas non finis ou négatifs sont exclus et ajoutés à `invalidFrameIntervalCount`.
- **Statistiques** : JSON conserve les samples bruts. Les agrégats contiennent minimum, médiane/p50, moyenne, p95, p99 à partir de 100 samples, maximum et écart-type. Aucun outlier n'est supprimé.

Les durées cross-process ne soustraient pas les `performance.now()` de deux time origins. Les phases main restent dans leur domaine monotone ; le délai observable depuis le spawn est mesuré par `process.hrtime.bigint()` dans le runner. Les profils startup sont « cold-ish » : le profil Electron est neuf, mais les caches du système d'exploitation ne sont pas vidés.

## Comparaisons et bruit

```powershell
npm run benchmark:compare -- before.json after.json
npm run benchmark:compare -- --threshold-percent 8 before.json after.json
```

Le comparateur met les latences, intervalles/retards de frames, mémoire, CPU et tailles DOM en contexte, et avertit si machine, OS, RAM, Electron, configuration, version de rapport ou fixtures diffèrent. Les anciens rapports sans `reportVersion` sont lus comme version 1. Les rapports dont `environment.fixtureVersion` et `configuration.fixtureVersion` se contredisent produisent un avertissement et aucune version n'est choisie pour eux. Le seuil de 5 % (et 1 ms absolue pour les latences) ne fait qu'étiqueter les petites variations ; il ne bloque ni CI ni développement. Les p95 des rapports Markdown ne sont montrés qu'à partir de 20 échantillons ; le p99 reste nul sous 100 mesures. Il n'existe pas encore de baseline ni de budget strict : mesurer `main` et garder le JSON avant toute optimisation.

Le JSON contient la version de schéma et de rapport, l'environnement, le commit/branche/état Git, la configuration et son hash, la validation et le hash des fixtures, les samples bruts, les statistiques, les événements de démarrage, les erreurs et les chemins des rapports. La version des fixtures des deux sections est copiée du manifeste chargé et validé. Le reportVersion est passé à 2 car les métriques CPU et le nombre d'intervalles RAF ont une sémantique corrigée ; schemaVersion reste 1. Le label `--machine` est fourni par l'utilisateur ; aucun identifiant matériel privé n'est collecté.

## Instrumentation et sécurité

Le runner active `NCE_BENCHMARK=1` uniquement pour ses processus Electron isolés. Les chemins `userData` et `sessionData` sont redirigés vers le profil temporaire sous `.benchmark-data/ide/profiles`. Les hooks de diagnostics et mesures de lecture sont conditionnés à ce flag ; aucun observer, timer périodique ou allocation de benchmark ne tourne en usage normal. Le serveur DevTools est démarré sur une adresse loopback et un port éphémère, puis le processus est fermé et son profil temporaire supprimé.

Aucune dépendance npm n'a été ajoutée. La suite s'appuie sur Electron/Chromium, Node.js et les contrôleurs existants. `npm run benchmark:ide:test` teste les statistiques, le comparateur, les générateurs et la validation de chemins.

## Validation et CI

Le workflow `.github/workflows/benchmark-ide.yml` lance le quick benchmark à la demande et chaque nuit sur un runner Ubuntu, puis archive les JSON/Markdown. Les chiffres GitHub Actions servent à détecter des changements dans le même type d'environnement, pas à comparer directement avec un PC ou un HP 2 GB.

Sur une machine de 2 GB, commencer par `npm run benchmark:quick -- --machine hp-2gb`. N'exécuter le mode full qu'après avoir vérifié le disque libre et fermé les autres applications ; le fichier 50 MB, la ligne d'un million de caractères et le workspace 20k sont volontairement exigeants. Éviter `--extreme` sur cette machine.

## Limites connues

- La fenêtre n'est pas ouverte de façon répétée indépendamment du processus : NCE ne possède actuellement qu'une seule BrowserWindow, donc création/affichage se mesure au startup.
- Le shutdown complet est chronométré dans chaque itération startup ; les sous-étapes de cleanup interne ne sont pas exposées par Electron.
- Le CPU mesuré ici couvre le main process pendant les interactions ; il n'additionne pas les threads renderer/Chromium et ne constitue pas une mesure CPU totale cross-platform.
- L'état visuel final est défini par deux RAF et les conditions fonctionnelles du scénario. Cela ne prouve pas que Chromium ou tous les threads OS sont inactifs.
- L'ouverture de très gros fichiers peut naturellement échouer ou expirer sur une petite machine. Le JSON conserve le timeout/crash au lieu de produire un résultat artificiel.
