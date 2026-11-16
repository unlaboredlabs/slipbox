// Sample memory for the mock server: a few folders of notes, each with a short history.

type Seed = { path: string; versions: { agent: string; why: string; hoursAgo: number; content: string; deleted?: boolean }[] };

export const seedAgents = [
  { name: "claude-code", grants: [{ prefix: "shared/", mode: "write" }, { prefix: "projects/", mode: "write" }, { prefix: "agents/claude-code/", mode: "write" }], daysOld: 41, seenMinutesAgo: 2 },
  { name: "research", grants: [{ prefix: "shared/", mode: "read" }, { prefix: "agents/research/", mode: "write" }], daysOld: 30, seenMinutesAgo: 34 },
  { name: "shop-bot", grants: [{ prefix: "shared/", mode: "read" }, { prefix: "projects/shop/", mode: "write" }], daysOld: 12, seenMinutesAgo: 6 },
  { name: "ci-runner", grants: [{ prefix: "projects/infra/", mode: "read" }], daysOld: 60, seenMinutesAgo: 60 * 24 * 9, revoked: true },
] as const;

const checkoutV1 = `# Checkout

The checkout flow takes a cart to a paid order in three steps: address, shipping, payment.

## Steps

1. Address: validated with the postcode lookup before moving on.
2. Shipping: rates come from the carrier API, cached for ten minutes.
3. Payment: card details go straight to the payment provider; we only keep the token.

## Failure modes

- Carrier API down: fall back to flat-rate shipping.
`;

const checkoutV2 = `# Checkout

The checkout flow takes a cart to a paid order in three steps: address, shipping, payment.

## Steps

1. Address: validated with the postcode lookup before moving on.
2. Shipping: rates come from the carrier API, cached for ten minutes.
3. Payment: card details go straight to the payment provider; we only keep the token.

## Failure modes

- Carrier API down: fall back to flat-rate shipping.
- Payment declined: keep the cart, show the provider's message as is.
`;

const checkoutV3 = `# Checkout

The checkout flow takes a cart to a paid order in three steps: address, shipping, payment. Guest checkout is allowed; an account is offered after payment.

## Steps

1. Address: validated with the postcode lookup before moving on.
2. Shipping: rates come from the carrier API, cached for five minutes.
3. Payment: card details go straight to the payment provider; we only keep the token.

## Failure modes

- Carrier API down: fall back to flat-rate shipping.
- Payment declined: keep the cart, show the provider's message as is.
- Webhook late: the order stays "pending" until the provider confirms; never mark it paid from the redirect alone.

## Testing

Use the provider's test cards. \`4000 0000 0000 9995\` always declines.
`;

export const seedFiles: Seed[] = [
  {
    path: "shared/profile.md",
    versions: [
      { agent: "claude-code", why: "Add the shared profile", hoursAgo: 900, content: `# Shared profile\n\nWho we are and how we work, for every agent.\n\n- Two people: Sam (product, design) and Ines (backend, infra).\n- Main language is TypeScript; Bun on the server.\n` },
      { agent: "claude-code", why: "Note that Ines is away in December", hoursAgo: 52, content: `# Shared profile\n\nWho we are and how we work, for every agent.\n\n- Two people: Sam (product, design) and Ines (backend, infra).\n- Ines is away 15–31 December; send infra questions to Sam then.\n- Main language is TypeScript; Bun on the server.\n- Prefer small pull requests, one change each.\n` },
    ],
  },
  {
    path: "shared/conventions.md",
    versions: [
      { agent: "claude-code", why: "Write down code conventions", hoursAgo: 700, content: `# Conventions\n\nHow code is written here, so every agent writes it the same way.\n\n## Code\n\n- Plain functions over classes.\n- No default exports.\n- Errors carry a code and a human message.\n\n## Commits\n\n- One line, imperative, under 70 characters.\n- Say why in the body when it isn't obvious.\n\n## Reviews\n\nEvery pull request gets one review before merge. Small fixes can be merged by the author after CI passes.\n` },
    ],
  },
  {
    path: "shared/people.md",
    versions: [
      { agent: "research", why: "List who to ask about what", hoursAgo: 300, content: `# People\n\nWho to ask about what.\n\n| Topic | Ask |\n|---|---|\n| Design, copy | Sam |\n| Database, deploys | Ines |\n| Payments provider | Ines |\n\nBoth prefer a short written question over a call.\n` },
    ],
  },
  {
    path: "shared/glossary.md",
    versions: [
      { agent: "research", why: "Start a glossary", hoursAgo: 340, content: `# Glossary\n\nWords we use in a specific way.\n\n- **Note**: one Markdown file in the memory.\n- **Profile**: a folder's \`profile.md\`, loaded first.\n` },
      { agent: "claude-code", why: "Remove the glossary; terms moved into conventions", hoursAgo: 150, content: "", deleted: true },
      { agent: "research", why: "Bring the glossary back with section terms", hoursAgo: 30, content: `# Glossary\n\nWords we use in a specific way.\n\n- **Note**: one Markdown file in the memory.\n- **Profile**: a folder's \`profile.md\`, loaded first.\n- **Section**: the part of a note under one heading; search returns sections.\n` },
    ],
  },
  {
    path: "projects/shop/profile.md",
    versions: [
      { agent: "shop-bot", why: "Start the shop profile", hoursAgo: 280, content: `# Shop\n\nThe online shop for prints and posters, live at shop.example.com.\n\n- Stack: Bun, Postgres, a small React front end.\n- Payments through a hosted provider; we never see card numbers.\n- Deploys from main, twice a week.\n` },
    ],
  },
  {
    path: "projects/shop/checkout.md",
    versions: [
      { agent: "shop-bot", why: "Describe the checkout flow", hoursAgo: 260, content: checkoutV1 },
      { agent: "claude-code", why: "Add declined payments to failure modes", hoursAgo: 75, content: checkoutV2 },
      { agent: "shop-bot", why: "Guest checkout, shorter rate cache, late webhooks", hoursAgo: 3, content: checkoutV3 },
    ],
  },
  {
    path: "projects/shop/deploy.md",
    versions: [
      { agent: "claude-code", why: "Document deploys", hoursAgo: 200, content: `# Deploy\n\nHow the shop gets to production.\n\n## Steps\n\n1. Merge to main; CI builds the image.\n2. \`bun run migrate\` runs against production before the switch.\n3. Traffic moves over once health checks pass.\n\n## Rollback\n\nRedeploy the previous image. Migrations are written to be backwards compatible for one release.\n` },
    ],
  },
  {
    path: "projects/shop/decisions/payments-provider.md",
    versions: [
      { agent: "research", why: "Record why we picked the payments provider", hoursAgo: 400, content: `# Payments provider\n\nWe use a hosted checkout page from the provider rather than our own card form.\n\n## Why\n\n- Keeps us out of card data compliance scope.\n- Their page handles 3-D Secure and wallets.\n\n## Trade-offs\n\nLess control over the look of the payment step.\n` },
    ],
  },
  {
    path: "projects/infra/profile.md",
    versions: [
      { agent: "claude-code", why: "Start the infra profile", hoursAgo: 500, content: `# Infra\n\nOne small VPS per environment, provisioned by hand and written down here.\n\n- Production: 2 vCPU, 4 GB, Postgres on the same box.\n- Backups nightly to object storage.\n` },
    ],
  },
  {
    path: "projects/infra/backups.md",
    versions: [
      { agent: "claude-code", why: "Document backups", hoursAgo: 480, content: `# Backups\n\nPostgres is dumped nightly at 03:00 UTC and kept for 30 days.\n\n## Restore\n\n1. Download the dump for the day.\n2. \`pg_restore --clean -d shop dump.pgc\`\n3. Check order counts against the payment provider.\n` },
      { agent: "claude-code", why: "Restores were tested; note the time it takes", hoursAgo: 20, content: `# Backups\n\nPostgres is dumped nightly at 03:00 UTC and kept for 30 days. A full restore takes about 12 minutes.\n\n## Restore\n\n1. Download the dump for the day.\n2. \`pg_restore --clean -d shop dump.pgc\`\n3. Check order counts against the payment provider.\n\nLast tested on 14 November.\n` },
    ],
  },
  {
    path: "agents/claude-code/notes.md",
    versions: [
      { agent: "claude-code", why: "Start my notes", hoursAgo: 600, content: `# Notes\n\nThings I keep relearning.\n\n- Run tests with \`bun test\`, not \`npm test\`.\n- The shop's staging database is reset every Sunday.\n` },
    ],
  },
  {
    path: "agents/research/reading-list.md",
    versions: [
      { agent: "research", why: "Start a reading list", hoursAgo: 330, content: `# Reading list\n\nPapers and posts worth a second look.\n\n- Reciprocal rank fusion (Cormack et al., 2009): why merging ranked lists by rank beats merging by score.\n- BM25 and its variants, for tuning the word index.\n` },
    ],
  },
];
