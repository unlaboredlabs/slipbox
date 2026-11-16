// A small labelled set for meaning search: notes, and queries with the notes
// that answer them. Used to choose and to test the relevance floor.
export const NOTES: Record<string, string> = {
  "projects/shop/payment-retries.md":
    "# Payment retries\n\nWhen a card payment is declined, we retry it after one day and again after three days, then email the customer to update their card.\n",
  "projects/shop/gift-cards.md":
    "# Gift cards\n\nGift card codes are sixteen characters, never expire, and can be combined with a discount code at checkout.\n",
  "projects/shop/refunds.md":
    "# Refunds\n\nRefunds go back to the original payment method within five business days; store credit is offered first.\n",
  "projects/shop/shipping.md":
    "# Shipping\n\nOrders placed before 2 pm ship the same day from the Leeds warehouse; international parcels go by DHL.\n",
  "shared/deploys.md":
    "# Deploys\n\nProduction releases go out on Tuesdays after the staging smoke tests pass; rollbacks use the previous container image.\n",
  "shared/team.md":
    "# Team\n\nAda leads backend, Grace runs design, and Linus is on call this week. Standup is at 9:30 on weekdays.\n",
  "agents/planner/notes.md":
    "# Planner notes\n\nSplit the Q3 roadmap into three milestones; the search rewrite comes after the billing migration.\n",
  "shared/office.md":
    "# Office\n\nOur office dog is a golden retriever named Biscuit; the kitchen is restocked on Mondays.\n",
  "shared/database.md":
    "# Database\n\nWe run Postgres 16 with nightly backups to S3; restoring a backup takes about twenty minutes.\n",
  "shared/security.md":
    "# Security\n\nAll staff use hardware security keys; passwords are kept in the team vault and rotated every quarter.\n",
};

/** Query -> the notes that answer it. An empty list means nothing in NOTES does. */
export const QUERIES: [string, string[]][] = [
  ["what happens when a card is declined", ["projects/shop/payment-retries.md"]],
  ["how often do we retry failed charges", ["projects/shop/payment-retries.md"]],
  ["do gift vouchers expire", ["projects/shop/gift-cards.md"]],
  ["how long until a customer gets their money back", ["projects/shop/refunds.md"]],
  ["when do orders leave the warehouse", ["projects/shop/shipping.md"]],
  ["which day do we release to production", ["shared/deploys.md"]],
  ["how do we undo a bad release", ["shared/deploys.md"]],
  ["who is on call", ["shared/team.md"]],
  ["what comes after the billing migration", ["agents/planner/notes.md"]],
  ["which canine lives at the workplace", ["shared/office.md"]],
  ["how do we recover lost data", ["shared/database.md"]],
  ["where are passwords stored", ["shared/security.md"]],
  // Wordier paraphrases, which score lower.
  ["when do we deploy new versions to customers?", ["shared/deploys.md"]],
  ["what does a shopper get if they have a voucher code", ["projects/shop/gift-cards.md"]],
  ["is there a way to get a payment back to the buyer", ["projects/shop/refunds.md"]],
  ["what should I do if I think my login was stolen", ["shared/security.md"]],
  ["what is the plan for the next quarter", ["agents/planner/notes.md"]],
  ["how quickly can an international customer expect a parcel", ["projects/shop/shipping.md"]],
  // More than one note answers these.
  ["how do declined payments and refunds work", ["projects/shop/payment-retries.md", "projects/shop/refunds.md"]],
  ["backups and password storage", ["shared/database.md", "shared/security.md"]],
  ["who works here and what is the office like", ["shared/team.md", "shared/office.md"]],
  ["what is our policy on card payments and gift cards", ["projects/shop/payment-retries.md", "projects/shop/gift-cards.md"]],
  // Nothing in the notes answers these.
  ["best recipe for sourdough bread", []],
  ["how to tune a guitar", []],
  ["the history of the roman empire", []],
  ["quantum entanglement explained", []],
  ["is there a lunch menu", []],
  ["how do I file my personal taxes", []],
  ["what is the weather tomorrow", []],
  ["recommend a good science fiction novel", []],
];
