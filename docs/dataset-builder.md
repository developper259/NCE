# Dataset Builder V1

Le Dataset Builder exécute séquentiellement de vraies instances de l’Agent NCE dans des copies temporaires de fixtures, observe leur `AgentEventBus`, calcule un diff indépendant puis valide l’état final sans faire confiance à `task_complete`. Il ne contient aucun juge ou superviseur IA.

## Tâches et lancement

La configuration centrale versionnée est `dataset.json` à la racine. Après avoir
créé `dataset/private/provider.json`, `npm run dataset:build` suffit. Les options
CLI (`--tasks`, `--output`, `--model`, `--no-artifacts`, etc.) remplacent les
valeurs du fichier. `--print-config` affiche une synthèse sans lancer de tâche.

Une ligne JSON par tâche :

```json
{"id":"fix-add","prompt":"Corrige add sans modifier les tests.","workspace":{"template":"fixtures/fix-add"},"agent":{"permissions":"code"},"validation":{"forbiddenChangedPaths":["test/"],"assertions":[{"type":"command","command":"npm","args":["test"],"timeoutMs":30000}]},"metadata":{"category":"bugfix","language":"javascript"}}
```

`workspace.template` est relatif au fichier de tâches. Les assertions disponibles sont `file_exists`, `file_not_exists`, `file_contains`, `file_not_contains` et `command`; `allowedChangedPaths` et `forbiddenChangedPaths` acceptent des chemins exacts ou des préfixes terminés par `/`.

```sh
NCE_DATASET_BASE_URL=https://provider.example/v1 \
NCE_DATASET_API_KEY=... \
npm run dataset:build -- --tasks dataset/tasks/pilot.jsonl --output dataset/output/pilot --provider openai-compatible --model model-id
```

Options : `--task`, `--limit`, `--resume`, `--keep-workspaces`, `--artifacts`, `--provider`, `--model`. Aucune clé n’est acceptée en argument CLI.

## Sortie et sécurité

`dataset.jsonl` contient une ligne atomique par tentative (`schemaVersion: 1`, `sampleId: taskId:1`) : tâche, statut Agent, modèle, trajectoire normalisée, réponse, métriques, diff filesystem, validation, intégrité et verdict. Les échecs sont conservés. Avec `--artifacts`, les événements bruts nettoyés et les snapshots sont écrits sous `artifacts/<sampleId>/`.

Les templates sont copiés sans suivre de symlink; les traversals sont refusés. Les commandes utilisent `spawn` avec `shell:false`, un cwd forcé et un timeout. Une seconde passe récursive retire credentials, Bearer tokens et chemins machine, tout en conservant les métriques de tokens. Les workspaces sont supprimés après écriture, sauf avec `--keep-workspaces`; un workspace est conservé si l’écriture du seul sample échoue.

## Limites V1

Une seule tentative et une seule tâche à la fois; JSONL uniquement; pas d’installation automatique; pas de glob complexe; le runtime headless utilise un provider OpenAI-compatible configuré par environnement. La validation exécute des commandes locales de tâches considérées fiables.
