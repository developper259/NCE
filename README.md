# NCE - Webview

Éditeur de code webview dédié au développement NDL, avec un moteur d’édition, un système de surbrillance, un gestionnaire de fichiers, un explorateur de projet.

## Présentation

Ce projet contient la partie interface applicative d’un éditeur de code embarqué dans une webview Electron. Il fournit :

- un éditeur de texte multi-lignes
- une gestion de l’indentation, du curseur, de la sélection et du rendu syntaxique
- un explorateur de fichiers et une recherche dans l’espace de travail
- des scrollers personnalisés pour la vue texte et les sidebars
- une intégration avec les modules de syntaxe et de thème

## Structure du projet

- `src/js/` : logique applicative JavaScript de l’éditeur
- `src/css/` : styles et thèmes de l’interface
- `src/html/` : structure HTML de la webview
- `src/modules/NSH/` : moteur de coloration / tokenisation / parsing
- `src/ts/` : couche TypeScript d’intégration côté app
- `assets/` : icônes, logos et ressources visuelles

## Démarrage

Prérequis :

- Node.js
- npm

Installation :

```bash
npm install
```

Lancement de l’application :

```bash
npm start
```

## Build

Pour générer un paquet applicatif :

```bash
npm run build
```

Ou une version non installée pour test local :

```bash
npm run dist
```

## Notes

- Le projet est conçu pour fonctionner dans un environnement Electron.
- La webview charge l’éditeur et les modules UI depuis les fichiers sous `src/`.
- La coloration syntaxique est gérée dans `src/modules/NSH/`.

## Licence

ISC
