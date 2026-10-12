# Plan — pi-colgrep local : recherche sémantique + agent de localisation 2B

> Objectif : redonner aux agents Pi les outils ColGrep (recherche sémantique de code) via une
> extension, **plus** un mode « agent » qui délègue la localisation de code au modèle local
> `lightonai/colgrep-agent-2B`. Tout tourne en local sur le Mac (Apple Silicon, 32 Go).

---

## 0. Constats de l'analyse (état des lieux vérifié)

| Élément | État constaté | Conséquence |
|---|---|---|
| Binaire `colgrep` | **1.5.2** installé via cargo (`~/.cargo/bin/colgrep`) | ❌ pas de flag `--agent` ; il faut upgrader |
| Dernière version | **1.8.5** (publiée 2026-10-10, avec `--agent` / `--install-agent`) | upgrade requis |
| Modèle agent | **non installé** (aucun GGUF dans `~/Library/Application Support/colgrep` ni `~/.cache/colgrep`) | `colgrep --install-agent` à lancer (~2,5 Go) |
| Index existants | ~90 indices dans `…/colgrep/indices` (juin→sept) | vérifier compat après upgrade, ré-indexer si besoin |
| Config colgrep | `config.json` avec ignores sécurité (`.env`, `*secret*`, `*key*`, `*.pem`, `node_modules`…) | **à préserver tel quel** |
| Mac | arm64, 32 Go RAM | 2B Q8_0 (~2,5 Go) tourne en local avec accélération Metal, sans Python ni serveur |
| Package amont | `@gotgenes/pi-colgrep` v2.0.0 — MIT, TypeScript, ~2 700 lignes src+tests, tool `colgrep` + skill + cycle de ré-index | base de fork idéale |
| Setup Pi | packages locaux référencés par chemin relatif (`../../zob/<pkg>`) dans `~/.pi/agent/settings.json` | tous les agents (sessions, mesh, subagents) héritent d'un package racine |

### Ce qu'apporte le modèle `colgrep-agent-2B` (lightonai)
- MiniCPM5-2B (SFT + GRPO), Q8_0 GGUF ~2,5 Go, inférence locale embarquée dans le binaire colgrep.
- Boucle itérative (≤ 10 tours) : `colgrep` (recherche sémantique) + `terminal` (lecture read-only) + `finish`.
- Entrée : une **question / issue / bug report** en langage naturel.
- Sortie : liste de localisations `path/to/file:START-END` sur stdout (`--json` pour du structuré,
  `-c` pour afficher les lignes de code), progression sur stderr.
- Usage type : ~20 s sur M3 Pro pour 9 tours. But : **soulager les gros modèles** — l'agent Pi délègue
  la localisation et reçoit des `file:line` précis au lieu de brûler son contexte en grep/find.

---

## 1. Décision d'architecture

### Recommandation : **fork local du package amont + ajout du mode agent**

| Option | Verdict | Pourquoi |
|---|---|---|
| A. `pi install npm:@gotgenes/pi-colgrep` + `bash` pour l'agent | ❌ | mode agent non intégré : pas de timeout, pas de parsing JSON, pas de détection modèle manquant, pas de guard GPU, skill muette sur l'agent |
| B. Réécrire une extension de zéro | ❌ | gaspillage : le code amont est propre, testé (vitest), et MIT |
| **C. Fork/vendoring local + extension agent** | ✅ | ~90 % du travail existe (tool, cycle d'index, truncation, tests, skill) ; on ajoute le mode agent en première classe |

### Design du mode agent : **2e tool dédié `colgrep_agent`** (plutôt qu'un flag sur `colgrep`)

Pourquoi deux tools plutôt qu'un simple flag `agent: true` :
1. **Routing LLM plus clair** : descriptions distinctes → le modèle choisit vite « recherche rapide » vs « délègue la localisation complète ».
2. **Sémantique différente** : `colgrep` prend une *query* courte et répond en <5 s ; `colgrep_agent` prend une *question/issue* complète et répond en 20–90 s.
3. **Timeout différent** : 30 s vs 5 min par défaut.
4. **Guard de concurrence GPU** propre (1 run agent à la fois).

> Si tu préfères littéralement « un flag », on peut faire `colgrep({ agent: true, question })` —
> techniquement équivalent, mais moins lisible pour le routing. Décision à la Phase 2.1.

### Schéma cible

```
Agent Pi ──▶ tool `colgrep`          ──▶ colgrep --json "query" [-e re] [-k n] [path]
         ──▶ tool `colgrep_agent`    ──▶ colgrep --agent --json [-c] "question" [path]
                                          └─ boucle interne 2B (colgrep + terminal read-only)
                                          └─ retour : file:START-END (+ code si -c)
```

### Politique « colgrep-first » — remplacer les greps (exigence utilisateur)

**Objectif** : colgrep devient l'outil de recherche de code **par défaut** ; les sessions de grep/rg
interminables disparaissent. Ceci **inverse la philosophie de l'amont** (dont les non-goals disent
« ne remplace pas grep ») — c'est une divergence assumée du fork.

**Fait technique vérifié** : `DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"]` → les tools
builtin `grep`/`find` ne sont **pas actifs par défaut** dans cette version de Pi. Les greps des agents
passent par **bash** (`rg`, `grep -r`, `find`). Le levier principal est donc un guard sur `tool_call`.

**Division des rôles** :

| Outil | Rôle | Quand |
|---|---|---|
| `colgrep` | Recherche de code **par défaut** — intention OU pattern (`-e`) | Exploration, « où est… », localiser une zone |
| `colgrep_agent` | **Escalade** : localisation approfondie déléguée au 2B local | Question complexe, issue, bug, feature à localiser |
| `grep`/`rg`/`find` | **Dernier recours uniquement** | Pipes système (`ps \| grep`), fichiers hors index/hors code, index indisponible |

**Enforcement à 3 niveaux** (l'extension fournit les 3, le choix se fait en config) :

1. **Steering (toujours actif)** — descriptions des tools + `promptGuidelines` + skill réécrite :
   « colgrep est l'outil par défaut pour toute recherche de contenu ; grep seulement pour les cas
   ci-dessus ». Standard Pi, zéro risque.
2. **Guard `tool_call` (opt-in — désactivé par défaut)** — décision utilisateur : **c'est l'agent qui décide** via l'explication (steering). Le guard reste implémenté comme filet de sécurité activable. 3 modes : `off` (défaut) | `warn` (bloque 1 fois puis laisse passer) | `strict`, avec **allow-list** (jamais bloqués) : pipes (`… | grep`), `ps`/`history`/`env`, chemins hors repo, greps sur fichier unique non récursifs, `git grep` (configurable).
3. **Masquage builtin (optionnel)** — si un projet a activé les tools builtin `grep`/`find`
   (`+grep` dans `defaultTools`), l'extension peut les retirer via re-registration `exposure:
   "hidden"`. Rarement nécessaire ici.

**À vérifier en Phase 1.3 (conditionne le mode strict)** :
- `colgrep -e "pattern" -k 500` retourne-t-il une énumération **exhaustive** (équivalent `grep -rn` pour les refactors) ?
- Comportement sur fichiers non-code (logs, txt) : indexés ou exclus par défaut ?
- Si l'énumération exhaustive est fiable → le guard strict peut rediriger *tout* grep de code sans perte.
  Sinon → le mode `strict` garde une échappatoire documentée (ex. `git grep` autorisé).

**Garde-fou anti-boucle** : le message de blocage est *actionnable et unique* (équivalent colgrep
prêt à coller), et un même pattern bloqué 2 fois de suite laisse passer au 3e essai (évite le
blocage d'un agent qui insiste pour une raison légitime).

---

## 2. Phases de travail

### Phase 1 — Backend : upgrade binaire + modèle (≈ 30 min)

1. **Upgrade colgrep 1.5.2 → 1.8.5**
   - `cargo install colgrep --force` (ou `brew install lightonai/tap/colgrep`).
   - Vérifier `colgrep --version`, présence de `--agent`, `--install-agent`, `--json`.
2. **Installer le modèle agent**
   - `colgrep --install-agent` → télécharge `colgrep-agent-2B-Q8_0.gguf` (~2,5 Go), vérifie le chargement, prépare le prompt cache (accélère le 1er run).
3. **Vérification fonctionnelle** sur un repo réel (ex. ce repo ou `pi-subagents`) :
   - `colgrep --agent --json "où est géré le fallback de modèle ?"` → **capturer le format JSON exact** (pas documenté en détail → il nourrira le parser de la Phase 2).
   - Chrono, vérifier « (GPU) » dans le bandeau (Metal actif).
   - Tester `-c` (lignes de code) et le scoping `path`.
   - **Exhaustivité de `-e`** : `colgrep -e "pattern" -k 500` vs `rg -n "pattern"` sur un même repo → le mode strict du guard en dépend.
   - **Fichiers non-code** : logs/txt indexés ou pas (allow-list du guard).
   - Tester compatibilité des index existants : si ré-index réclamé → `colgrep init` (le cycle auto de l'extension s'en charge ensuite).
4. **Préserver la config** existante (`~/Library/Application Support/colgrep/config.json`) : ignorer `--uninstall` et tout ce qui purge les données.

Risques : latence du premier run (prompt cache) → à absorber ici, pas en prod ; format JSON inconnu → parsing défensif + fallback texte brut côté extension.

### Phase 2 — Le package `zob/pi-colgrep` (≈ 3–4 h)

**2.1 Scaffold** — copie des sources amont dans `/Users/cgarrot/zob/pi-colgrep` :
```
zob/pi-colgrep/
├── package.json            # name local, "pi": { extensions, skills }, type: module
├── src/
│   ├── extension.ts        # + enregistrement colgrep_agent, dispo modèle, commandes slash
│   ├── tools/
│   │   ├── colgrep.ts          # (amont, inchangé)
│   │   └── colgrep_agent.ts    # NOUVEAU
│   ├── lib/
│   │   ├── agent.ts            # NOUVEAU : args, exec, parse JSON, timeout, dispo modèle, lock
│   │   ├── args.ts / format.ts / search.ts / availability.ts
│   │   ├── reindex.ts / config.ts / index-status.ts / exec.ts   # (amont)
│   └── tool-result.ts      # (amont)
├── skills/colgrep/SKILL.md # enrichie : table grep / colgrep / colgrep_agent
├── test/                   # suite amont + nouveaux tests agent
├── THIRD_PARTY_LICENSES/   # conservé (Apache-2.0 next-plaid) + mention fork MIT gotgenes
└── README.md / PLAN.md
```
Attribution conservée : en-tête « Adapted from @gotgenes/pi-colgrep (MIT) » dans les fichiers repris.

**2.2 `src/lib/agent.ts` (nouveau)** — cœur du mode agent, testable sans SDK Pi :
- `buildAgentArgs({ question, path? })` → `["--agent", "--json", …, question, path?]`.
- `parseAgentResult(stdout)` → normalise en liste `{ file, startLine, endLine }` + fallback défensif (si JSON inattendu, retour texte brut). **Schéma validé en Phase 1** (voir section 6).
- `checkAgentModelInstalled()` → détection du GGUF : blob ≥ 2 GiB dans `~/.cache/huggingface/hub/models--lightonai--colgrep-agent-2B-GGUF/blobs/` (nommé par SHA, **sans extension**) ; si absent → message d'aide : `colgrep --install-agent`.
- Timeout configurable (défaut 300 000 ms), propagation `AbortSignal` (ESC de l'utilisateur).
- Guard de concurrence : refus poli si un run agent est déjà en vol dans la session ; **lockfile cross-sessions** optionnel (`~/.pi/agent/extensions/pi-colgrep/agent.lock`) car les sessions mesh peuvent tirer en parallèle sur le même GPU.

**2.2bis `src/lib/guard.ts` (nouveau, politique colgrep-first)** :
- `classifyBashCommand(cmd, cwd)` → `{ action: "allow" | "block", reason?, colgrepEquivalent? }`.
- Détection des recherches récursives de code : `rg`, `grep -r/-R`, `ag`, `ack`, `ugrep -r`… (parse simple en shell-words, pas de faux positifs sur strings entre quotes si évitable).
- Allow-list : pipes (`| grep`), `ps`/`history`/`env --dry`, chemins hors repo indexé, fichier unique non récursif, `git grep` (configurable).
- Génération de l'équivalent colgrep : pattern → `colgrep -e "<pattern>" -k 200` (+ chemin) ; intention → suggestion `colgrep "<mots-clés>"`.
- Anti-boucle : compteur par pattern, au 3e blocage identique → laisse passer avec note `details`.
- Branché dans `extension.ts` via `pi.on("tool_call", …)` sur `bash` uniquement, selon `config.guard.mode`.

**2.3 `src/tools/colgrep_agent.ts` (nouveau)** :
- Params : `question` (requis), `path?`. **Pas de `showCode` en v1** : vérifié en Phase 1, `--json -c` n'inclut pas le contenu → l'agent lit lui-même les `file:line` retournés (plus économe en tokens).
- `promptSnippet` / `promptGuidelines` : *« Déliegue la localisation quand la question ressemble à une issue/bug/'où est-ce que…' ; retourne file:line précis ; garde ton contexte pour le fix »*.
- `renderCall`/`renderResult` : durée du run, nb de localisations ; en mode replié `✓ 5 locations · 21s`.
- Truncation identique au tool amont (`truncateHead` + dump complet en tmp si trop long).

**2.4 `src/extension.ts` (modifié)** :
- Enregistre les 2 tools.
- `session_start` : dispo binaire (amont) + **dispo modèle agent** (check rapide, non bloquant) → status line si absent.
- Commandes slash : `/colgrep-reindex` (existante) + `/colgrep-agent-install` (lance `--install-agent` avec feedback UI).

**2.5 Config étendue** (mêmes fichiers global/projet que l'amont) :
```jsonc
{
  "indexOnStartup": true,          // (amont)
  "guard": {                       // politique colgrep-first
    "mode": "off",                // "off" (défaut — l'agent décide) | "warn" | "strict"
    "allowGitGrep": true,
    "allowedTools": ["rg", "grep", "ag", "ack"]   // commandes surveillées
  },
  "agent": {
    "enabled": true,               // masque le tool colgrep_agent si false
    "timeoutMs": 300000,
    "maxConcurrent": 1             // par session ; lockfile global en option
  }
}
```

**2.6 Skill enrichie** — nouvelle table de décision **colgrep-first** :

| Tâche | Outil |
|---|---|
| Recherche de code par défaut (intention) | `colgrep` |
| Recherche de code par pattern (équivalent grep) | `colgrep -e "pattern"` |
| « Où est implémenté X ? » / issue / bug report | `colgrep_agent` |
| Symbole exact exhaustif (refactor) | `colgrep -e` avec `-k` élevé (si vérif Phase 1 OK), sinon `grep` |
| Pipe système / process / hors repo | `grep`/`rg` (bash) — autorisé par le guard |

+ exemples de questions agent, guidance anti-pattern (ne pas spammer l'agent pour une recherche simple ;
ne pas faire 15 greps là où 1 run agent suffit ; ne pas remplacer colgrep par grep « parce que c'est plus rapide à écrire »).

### Phase 3 — Tests (≈ 1–2 h)

1. Porter la suite vitest amont (15 fichiers : args, availability, config, format, reindex, search, extension, tools) — les modules sont déjà découplés via `Exec` injecté.
2. Nouveaux tests : `parseAgentResult` (happy / vide / malformé), timeout + abort, modèle absent, guard concurrence, `buildAgentArgs`.
3. **Smoke réel** selon le skill `pi-package-testing` : `pi -e` sur le playground `pitest`, session fraîche → vérifier : tools visibles, skill chargée, recherche OK, run agent OK, ré-index auto après `edit`.

### Phase 4 — Rollout pour tous les agents (≈ 15 min)

1. `~/.pi/agent/settings.json` → `"packages": [ …, "../../zob/pi-colgrep" ]`.
2. Session de vérification complète (recherche, agent, ré-index, status line).
3. Les agents mesh/subagents héritent automatiquement (sessions Pi standard).
4. *(Optionnel)* Proposer un PR amont à `gotgenes/pi-packages` avec le mode agent — bonne volonté open-source, et ça évite de diverger pour toujours.

---

## 3. Risques & mitigations

| Risque | Mitigation |
|---|---|
| Format `--agent --json` non documenté | Capture réelle en Phase 1.3 ; parser défensif + fallback texte |
| Upgrade casse les index existants (format changé depuis juin) | Ré-index unique par projet ; cycle auto de l'extension ensuite |
| 1er run lent (prompt cache) | Préparé par `--install-agent` ; documenter ; status line |
| Contention GPU entre sessions mesh | Guard par session + lockfile global optionnel |
| **Guard trop agressif** : faux positifs, agent bloqué sur un besoin légitime | Modes `off`/`warn`/`strict` ; allow-list ; anti-boucle (3e blocage passe) ; **`off` par défaut** |
| Dérive vs amont (divergence philosophique assumée) | Fork minimal, fichiers amont intacts hors guidelines ; PR amont en option (le mode agent peut intéresser l'amont, le guard non) |

## 4. Ordre de grandeur

| Phase | Durée |
|---|---|
| 1. Backend (upgrade + modèle + vérifs) | ~30 min |
| 2. Package (fork + agent) | ~3–4 h |
| 3. Tests + smoke | ~1–2 h |
| 4. Rollout | ~15 min |
| **Total** | **≈ une demi-journée** |

## 5. Ce qui est explicitement hors périmètre

- Remplacer `grep`/`find` intégrés **inconditionnellement** (les cas pipes système, hors index et exhaustifs gardent bash/grep ; d'où les modes du guard).
- Bundler/patcher le binaire colgrep (prérequis utilisateur, comme l'amont).
- Parité CLI complète (sous-ensemble de params uniquement, le reste via `bash`).
- Tourner le modèle sur le t3600 distant (tout doit rester local Mac, comme demandé).

## 6. Phase 1 — RÉSULTATS (✅ terminée, 12 oct)

### Installations
- **colgrep 1.5.2 → 1.8.5** : binaire prebuilt aarch64 via l'installer officiel, à `~/.cargo/bin/colgrep` (60 Mo, pas de compilation cargo).
- **Modèle agent** : `colgrep-agent-2B-Q8_0.gguf` (2,5 GiB) dans `~/.cache/huggingface/hub/models--lightonai--colgrep-agent-2B-GGUF/blobs/f238da91…` ; shaders Metal compilés dans `~/Library/Application Support/colgrep/agent/metal/`. **GPU actif** (bandeau « (GPU) »).
- Disque : 15 → 28 GiB libres après purge APFS (l'installation n'a pas aggravé).

### Schéma JSON `colgrep --agent --json` (capturé, à utiliser tel quel par le parser)
```json
{
  "query": "…",
  "locations": [{ "file": "/chemin/ABSOLU/fichier.ts", "start_line": 16, "end_line": 41 }],
  "submitted": true,
  "end_reason": "Answered",
  "error": null,
  "turns": 3, "searches": 1, "reads": 1,
  "prompt_tokens": 5953, "cached_prompt_tokens": 4332, "completion_tokens": 161,
  "llm_seconds": 6.48, "tool_seconds": 0.19, "seconds": 20.83
}
```
Notes parser : `file` = **chemin absolu** (à relativiser) ; `locations` peut être vide ; `error` peut être non-null ; `-c` avec `--json` **n'ajoute pas de contenu** (même schéma) ; en mode non-TTY stderr est vide (pas de streaming de progression — les métriques JSON suffisent).

### Mesures réelles (Mac arm64, Metal)
| Test | Résultat |
|---|---|
| Agent, question ciblée (« where is the colgrep binary availability checked ») | **20,9 s**, 3 tours → `src/lib/availability.ts:16` **exact** |
| Agent, question absurde (« zzzz qqqq… ») | 19,5 s, 8 tours, 23k prompt tokens, retourne quand même 2 localisations (le modèle force une réponse) |
| Agent, « where is the agent routing decided » sur `pi-subagents` | ~correct → `src/models/routing.ts:65-182 resolveChildModel` |
| `colgrep -e` exhaustif vs `rg -l` | **identiques** (4 fichiers, k=500 et même k par défaut) — docs `.md` incluses |
| Fichiers non-code | `.md`/`README` **indexés et cherchables** par défaut (l'option `--code-only` existe pour exclure) |
| Index de juin (v1.5.2) lus par 1.8.5 | ✅ compatibles, mise à jour à la volée (recherche 10,5 s incluant l'update) |

### Conséquences pour le design (ajustements)
- **Pas de `showCode` en v1** : `--json -c` ne renvoie pas le contenu → le tool rend `file:START-END`, l'agent lit ensuite avec `read` (plus économe).
- **Check de dispo du modèle** : blob ≥ 2 GiB dans le cache HF (nommé par SHA, sans extension) — check instantané, pas de run agent.
- `colgrep status` (nouvelle commande 1.8.5) peut servir au check d'index.
- Réglages agent avancés disponibles via `colgrep settings --agent-*` (max-turns, temperature, context, gpu-layers, **endpoint OpenAI-compatible**, thinking…) → surfacés plus tard si besoin, pas en v1.
- `colgrep -e` étant exhaustif, le mode `strict` du guard est sans perte si activé un jour.
- `colgrep update` (self-update) existe désormais ; garder `--install-agent` idempotent vérifié.

### Prochaine étape → ✅ FAIT — voir section 7 ci-dessous.

## 7. Phases 2–4 — RÉSULTATS (✅ terminées, 12 oct)

### Livrables
Package complet : `/Users/cgarrot/zob/pi-colgrep` (fork local de `@gotgenes/pi-colgrep` v2.0.0, MIT, attributions conservées)

| Fichier | Contenu |
|---|---|
| `src/lib/agent.ts` | **Nouveau** — `buildAgentArgs`, `parseAgentResult`, `formatAgentLocation(s)`, `isAgentModelInstalled` (check HF cache par taille, zéro subprocess), `runAgent` |
| `src/lib/guard.ts` | **Nouveau** — `classifyBashCommand` (off/warn/strict, allow-list pipes/single-file/git grep/rg --files, anti-boucle 2 blocages max) |
| `src/tools/colgrep_agent.ts` | **Nouveau** — tool + limiteur de concurrence + truncation + rendering TUI |
| `src/tools/colgrep.ts` | Guidelines **colgrep-first** (inversées vs amont) |
| `src/extension.ts` | 2 tools, probe modèle au session_start, guard `tool_call`, `/colgrep-agent-install` |
| `src/lib/config.ts` | Sections `guard` + `agent`, merge par section global↔projet |
| `skills/colgrep/SKILL.md` | Table colgrep-first + escalation `colgrep_agent` (attribution LightOn conservée) |
| `README.md`, `CHANGELOG.md` | Documentation complète du fork |

### Vérifications
- **182 tests unitaires passants** / 12 fichiers (`npm test`) + `tsc --noEmit` clean.
- **Smoke E2E réel via Pi** (provider `opencode-go`, quota zai épuisé) :
  - `colgrep` → `src/retry.ts:1-11` en **851 ms** (hitCount=2, details OK) ;
  - `colgrep_agent` → **le 2B local** a localisé `src/retry.ts:4-5` en **6,8 s** (4 tours, 1 recherche) ;
  - le modèle a ensuite lu les fichiers retournés (`read` × 3) — workflow locating → reading conforme.
- **Chargement global vérifié** avec tout le stack local (mesh, subagents, goals…) : tools exécutés, **skill colgrep chargée**, aucun warning loader.
- Fix loader : `peerDependencies: "*"` (host-provided) + `devDependencies` pour les types.

### Rollout
- `~/.pi/agent/settings.json` → `packages += "../../zob/pi-colgrep"` ⇒ **tous les agents Pi** (sessions, mesh, subagents) ont les 2 tools + la skill.

### Décisions finales
- **Guard `off` par défaut** — c'est l'agent qui décide, guidé par les descriptions/guidelines/skill. `warn`/`strict` activables en config quand on voudra durcir.
- **Pas de `showCode`** : `--json -c` ne renvoie pas le contenu ; l'agent lit lui-même les localisations (plus économe en tokens).
