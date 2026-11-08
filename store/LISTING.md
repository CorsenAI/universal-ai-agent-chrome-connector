# Chrome Web Store listing

The text pasted into the developer dashboard, in both shipped languages. Limits: title 45
characters, short description 132 characters (both come from the manifest and `_locales`, and are
checked by `scripts/verify-extension-zip.mjs`). Every claim below is backed by code and tests in this
repository; nothing says "official", "certified" or "secure" as a bare adjective.

## English (default)

**Title** (43 characters, from `_locales/en/messages.json`)

```
Universal AI Agent Connector — by Corsen AI
```

**Short description** (121 characters, from `_locales/en/messages.json`)

```
Your signed-in web chats become a local OpenAI/Anthropic API; tabs you choose become MCP tools for AI agents. Local only.
```

**Detailed description**

```
Universal AI Agent Connector links the Chrome tabs you choose to the AI agents running on your own computer, through a small open-source companion app. Nothing goes through Corsen AI.

TWO ROLES, CHOSEN PER TAB
Every tab starts as Ignored: private, never read, never touched. From the toolbar button or the side panel, you can give a tab one of two roles:
• MCP — your agents can read the page as clean Markdown or as an accessibility tree with short element handles; click, type, select, scroll and navigate with real browser input; see console errors and failed requests; read the page's own JSON and GraphQL calls; and take a screenshot.
• LLM — a chat site you are signed in to answers the requests of tools on your computer: each prompt is typed into the page and the answer read back as text, one request at a time, at the page's own pace.

ONE-CLICK AGENT SETUP
The companion app detects Claude Code, Cursor, Windsurf / Devin Desktop, Claude Desktop, Cline, Roo Code and OpenCode, and writes their MCP configuration for you, after a timestamped backup, with Unlink and Restore.

PRIVATE BY DEFAULT, VISIBLE, REVERSIBLE
• Chrome shows its "started debugging this browser" bar while a tab is controlled; cancel it and the tab is private again.
• Panic stop detaches every tab in one click.
• Agents cannot change a tab's role. A request for a tab without a role fails; it never falls back to another tab.
• Passwords, one-time codes, card fields, hidden inputs, secret address parameters and credential headers are masked in the browser before anything leaves it. Screenshots are pixels and are not masked.
• The extension talks only to the companion on 127.0.0.1, after a mutual HMAC pairing. No analytics, no telemetry, no remote code.

REQUIREMENTS
The companion app, free and open source (Apache-2.0): Node.js 22 or newer, then run npx @corsen-ai/universal-connector. Source and documentation: https://github.com/CorsenAI/universal-ai-agent-chrome-connector

Unofficial community project by Corsen AI. Not affiliated with or endorsed by Google, Anthropic, OpenAI, DeepSeek, Alibaba, Moonshot, Cursor, Cognition, Cline or Roo Code. Using a chat service through its web page is subject to that service's terms; you are responsible for how you use your accounts.
```

**Category:** Developer Tools
**Language:** English (the extension also ships French)
**Homepage:** https://github.com/CorsenAI/universal-ai-agent-chrome-connector
**Support:** https://github.com/CorsenAI/universal-ai-agent-chrome-connector/issues
**Privacy policy:** https://corsen.ai/privacy/universal-ai-agent-connector/ — same text as
`docs/privacy/index.html`

## Français

**Titre** (43 caractères, depuis `_locales/fr/messages.json`)

```
Universal AI Agent Connector — by Corsen AI
```

**Description courte** (124 caractères, depuis `_locales/fr/messages.json`)

```
Vos chats web connectés deviennent une API OpenAI/Anthropic locale ; les onglets choisis, des outils MCP pour vos agents IA.
```

**Description détaillée**

```
Universal AI Agent Connector relie les onglets Chrome que vous choisissez aux agents IA qui tournent sur votre propre ordinateur, grâce à une petite application compagnon open source. Rien ne passe par Corsen AI.

DEUX RÔLES, CHOISIS ONGLET PAR ONGLET
Chaque onglet démarre « Ignoré » : privé, jamais lu, jamais touché. Depuis le bouton de la barre d'outils ou le panneau latéral, vous donnez à un onglet l'un de deux rôles :
• MCP — vos agents lisent la page en Markdown propre ou en arbre d'accessibilité avec de courts identifiants d'éléments ; cliquent, saisissent, sélectionnent, font défiler et naviguent avec de vraies entrées du navigateur ; voient les erreurs de console et les requêtes en échec ; lisent les appels JSON et GraphQL de la page ; et prennent une capture d'écran.
• LLM — un site de chat où vous êtes connecté répond aux requêtes des outils de votre ordinateur : chaque prompt est saisi dans la page et la réponse relue en texte, une requête à la fois, au rythme de la page.

CONFIGURATION DES AGENTS EN UN CLIC
L'application compagnon détecte Claude Code, Cursor, Windsurf / Devin Desktop, Claude Desktop, Cline, Roo Code et OpenCode, et écrit leur configuration MCP pour vous, après une sauvegarde horodatée, avec Délier et Restaurer.

PRIVÉ PAR DÉFAUT, VISIBLE, RÉVERSIBLE
• Chrome affiche sa barre « a commencé à déboguer ce navigateur » tant qu'un onglet est piloté ; annulez-la et l'onglet redevient privé.
• L'arrêt d'urgence détache tous les onglets en un clic.
• Les agents ne peuvent pas changer le rôle d'un onglet. Une requête vers un onglet sans rôle échoue ; jamais de repli sur un autre onglet.
• Mots de passe, codes à usage unique, champs de carte, champs cachés, paramètres d'adresse secrets et en-têtes d'identification sont masqués dans le navigateur avant tout envoi. Les captures d'écran sont des pixels et ne sont pas masquées.
• L'extension ne parle qu'à l'application compagnon sur 127.0.0.1, après un appairage HMAC mutuel. Ni statistiques, ni télémétrie, ni code distant.

PRÉREQUIS
L'application compagnon, gratuite et open source (Apache-2.0) : Node.js 22 ou plus récent, puis npx @corsen-ai/universal-connector. Code source et documentation : https://github.com/CorsenAI/universal-ai-agent-chrome-connector

Projet communautaire non officiel de Corsen AI. Sans lien avec Google, Anthropic, OpenAI, DeepSeek, Alibaba, Moonshot, Cursor, Cognition, Cline ou Roo Code, ni approuvé par eux. Utiliser un service de chat par sa page web relève des conditions de ce service ; vous êtes responsable de l'usage de vos comptes.
```

## Graphic assets

See `ASSETS.md`: store icon 128×128, three screenshots 1280×800, small promo tile 440×280, marquee
1400×560 — all regenerated from the real product by `pnpm store:assets`.
