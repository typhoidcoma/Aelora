Recommended CSS Design Tokens
:root {
  /* =========================
     CORE BACKGROUNDS
  ========================= */
  --bg-000: #0d0811;   /* deepest black-violet */
  --bg-050: #140d1d;   /* rich night plum */
  --bg-100: #1a1226;   /* dark indigo-plum */
  --bg-200: #25182f;   /* soft cosmic purple */
  --bg-300: #34202f;   /* muted nebula brown-plum */

  /* =========================
     SURFACE COLORS
  ========================= */
  --surface-100: #1a1320; /* main card bg */
  --surface-200: #241929; /* elevated card */
  --surface-300: #2f2131; /* hover surface */
  --surface-400: #4a3037; /* strong surface accent */

  /* =========================
     BORDERS / DIVIDERS
  ========================= */
  --border-subtle: #3a2633;
  --border-default: #563743;
  --border-strong: #7a4a45;
  --border-glow: #c77553;

  /* =========================
     TEXT
  ========================= */
  --text-primary: #fff4d2;   /* luminous cream */
  --text-secondary: #f2ddb2; /* warm soft gold */
  --text-muted: #c9ab91;     /* muted warm beige */
  --text-dim: #9c7a73;       /* dusty rose-brown */
  --text-inverse: #140d1d;   /* dark text on light buttons */

  /* =========================
     BRAND / PRIMARY
  ========================= */
  --brand-300: #e39e66; /* warm amber */
  --brand-400: #ca7553; /* ember orange */
  --brand-500: #fad46d; /* butterfly gold */
  --brand-600: #fae29f; /* soft glowing gold */
  --brand-700: #fcf5c5; /* pale radiant cream */

  /* =========================
     SECONDARY / ATMOSPHERIC
  ========================= */
  --secondary-300: #71525d; /* smoky mauve */
  --secondary-400: #5c3946; /* dusk plum */
  --secondary-500: #513236; /* warm nebula brown */
  --secondary-600: #9c5d4f; /* muted ember clay */

  /* =========================
     INTERACTIVE STATES
  ========================= */
  --link: #fadc84;
  --link-hover: #fff0bb;
  --focus-ring: rgba(250, 212, 109, 0.35);

  --button-primary-bg: #fad46d;
  --button-primary-hover: #fae29f;
  --button-primary-text: #140d1d;

  --button-secondary-bg: rgba(250, 212, 109, 0.08);
  --button-secondary-hover: rgba(250, 212, 109, 0.14);
  --button-secondary-text: #fff4d2;
  --button-secondary-border: #7a4a45;

  /* =========================
     STATUS COLORS
  ========================= */
  --success: #d8c774;  /* soft golden-green substitute */
  --warning: #e39e66;  /* amber warning */
  --danger: #c77553;   /* ember red-orange */
  --info: #b98ea0;     /* cosmic mauve */

  /* =========================
     GLOW / EFFECTS
  ========================= */
  --glow-gold-soft: rgba(250, 212, 109, 0.18);
  --glow-gold-medium: rgba(250, 212, 109, 0.32);
  --glow-peach-soft: rgba(227, 158, 102, 0.16);
  --shadow-dark: rgba(7, 4, 10, 0.6);

  /* =========================
     GRADIENTS
  ========================= */
  --gradient-page:
    radial-gradient(circle at center, #34202f 0%, #1a1226 40%, #140d1d 72%, #0d0811 100%);

  --gradient-card:
    linear-gradient(180deg, rgba(250, 212, 109, 0.05) 0%, rgba(255, 244, 210, 0.02) 100%);

  --gradient-brand:
    linear-gradient(135deg, #fcf5c5 0%, #fad46d 35%, #e39e66 68%, #ca7553 100%);

  --gradient-hero-glow:
    radial-gradient(circle, rgba(252, 245, 197, 0.95) 0%, rgba(250, 212, 109, 0.55) 28%, rgba(227, 158, 102, 0.18) 52%, rgba(13, 8, 17, 0) 72%);

  /* =========================
     SEMANTIC TOKENS
  ========================= */
  --page-bg: var(--bg-000);
  --section-bg: var(--bg-050);
  --card-bg: var(--surface-100);
  --card-bg-hover: var(--surface-200);
  --card-border: var(--border-subtle);

  --heading-color: var(--text-primary);
  --body-color: var(--text-secondary);
  --muted-color: var(--text-muted);

  --accent: var(--brand-500);
  --accent-hover: var(--brand-600);
  --accent-strong: var(--brand-400);
}
Suggested usage
Page background

Use a very dark cosmic background:

body {
  background: var(--gradient-page);
  color: var(--body-color);
}
Main cards / panels
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  box-shadow: 0 10px 30px var(--shadow-dark);
}
Headings
h1, h2, h3, h4 {
  color: var(--heading-color);
}
Primary button
.button-primary {
  background: var(--button-primary-bg);
  color: var(--button-primary-text);
  border: none;
  box-shadow: 0 0 24px var(--glow-gold-soft);
}

.button-primary:hover {
  background: var(--button-primary-hover);
}
Secondary button
.button-secondary {
  background: var(--button-secondary-bg);
  color: var(--button-secondary-text);
  border: 1px solid var(--button-secondary-border);
}
Links
a {
  color: var(--link);
}

a:hover {
  color: var(--link-hover);
}
Best semantic palette for a real site

If you want a tighter practical system, this is the clean version I’d actually use:

:root {
  --background: #0d0811;
  --background-elevated: #1a1320;
  --surface: #241929;
  --surface-hover: #2f2131;

  --text: #fff4d2;
  --text-soft: #f2ddb2;
  --text-muted: #c9ab91;

  --primary: #fad46d;
  --primary-hover: #fae29f;
  --secondary: #ca7553;
  --accent: #e39e66;

  --border: #563743;
  --border-soft: #3a2633;

  --glow: rgba(250, 212, 109, 0.28);
}