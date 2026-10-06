# tg-bot

A Cloudflare Worker that tells you in Telegram when a customer pays through Stripe Checkout or a Payment Link, and
remembers who pays. It keeps Students and their Payer emails in a D1 database, announces each payment with the Student's
name, and lets you attach a payment from an unknown email to a Student (or dismiss it) with buttons in the chat.

It has two endpoints:

- `POST /stripe/webhook` handles `checkout.session.completed` and `checkout.session.async_payment_succeeded` events whose
  `payment_status` is `paid`. Everything else gets a 200, no message and no stored row.
- `POST /telegram/webhook` receives the bot's updates: button taps, name replies and the commands below.

Stripe retries are deduplicated by checkout session id: a payment that was already announced is not announced again. A
rare duplicate message is still possible (for example if Telegram accepted a message but the Worker failed right
afterwards), because delivery is at least once.

## Messages

Plain text, with the amount and a link to the payment in the Stripe dashboard (the link line is left out when the payment
has no payment intent):

- Known Payer: `💶 Olena paid 160,00 €`
- Unknown Payer: `💶 Unknown payer paid 160,00 €`, then `Anna K <anna@example.com>` and `Who is this?`, with buttons:
  `➕ New student`, a `💡 <name>` row when the Stripe customer name matches a Student, the active Students two per
  row (at most 90), and `✖️ Cancel`.
- Tapping a Student assigns the payment, saves the email as theirs and edits the message to
  `<email> saved as <name>'s email`. If the email already belongs to another Student, the payment still goes to the tapped
  Student and the message says `<email> already belongs to <owner>`.
- `✖️ Cancel` dismisses the payment: `💶 Payment dismissed: 160,00 €`.
- `➕ New student` asks for a name (reply to the bot's prompt). Names are 1-64 characters and unique ignoring case.
- A second tap on a handled payment is answered `Already handled`.

Commands, in the configured chat only (updates from other chats are ignored):

- `/students` lists the active Students.
- `/rename Old name -> New name` renames a Student. Earlier messages are not edited.

If Telegram privacy mode is on for the bot and a bare command gets no answer, send `/students@<bot username>` instead.

## Setup

1. Install dependencies: `pnpm install`.
2. Create the production bot. In Telegram, message `@BotFather`, send `/newbot` and follow the prompts. Copy the bot token.
3. Find the production chat id. Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `message.chat.id` from the response.
   For a group, add the bot to the group, send a message there and read the (negative) id the same way.

## Deploy

Do the steps in this order. Each secret is set once, after the step that produces its value.

1. Create the D1 database: `pnpm exec wrangler d1 create tg-bot`. There is no id to copy: the binding in `wrangler.jsonc`
   resolves the database by name. If the command offers to add the binding to `wrangler.jsonc`, answer no, it is already there.
2. Apply the migrations: `pnpm exec wrangler d1 migrations apply tg-bot --remote`.
3. Set the Telegram secrets (each command prompts for the value):
   ```
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_CHAT_ID
   ```
4. Generate the webhook secret with `openssl rand -hex 32` (Telegram allows `A-Za-z0-9_-`, 1-256 characters) and store it
   with `pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET`. The value you use locally is independent of this one.
5. Deploy with `pnpm run deploy` (always with `run`: the shorthand without it is a different pnpm command). Wrangler prints the Worker URL.
   Deploying before steps 1 and 2 gives an empty database, and every Stripe event answers 500 until the migrations are applied.
6. Register the Telegram webhook with `setWebhook`, using your bot token and the secret from step 4:
   ```
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -H "content-type: application/json" \
     -d '{"url":"https://<your-worker>/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
   ```
7. Only now point Stripe at the new code. In the Stripe dashboard (Developers > Webhooks) add an endpoint
   `https://<your-worker>/stripe/webhook` and select the events `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`.
8. Open the endpoint, reveal its signing secret (`whsec_...`) and store it with
   `pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET`.

### Update an existing deployment

Run these in order:

1. List the applied migrations: `pnpm exec wrangler d1 migrations list tg-bot --remote`.
2. Check the build: `pnpm exec wrangler deploy --dry-run`.
3. Apply the pending migrations: `pnpm exec wrangler d1 migrations apply tg-bot --remote`.
4. Deploy right away: `pnpm run deploy`.

Between steps 3 and 4 Stripe deliveries fail with 500 and Stripe retries them; the retry is safe because payments are
deduplicated by checkout session id. Telegram edits made by the old code in that window show a `/test/` dashboard link.
Never deploy before migrating: the new code then fails every Stripe delivery. A dropped column can only be restored with
D1 Time Travel together with a code revert.

## Local development

Local runs use a separate test bot and test group, Stripe test mode and the local D1 database. Never use the production
bot token locally: a bot has one webhook URL, and the production bot must keep its.

1. Create a test bot with `@BotFather` and a test group, and find the group's chat id as in Setup.
2. Copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in the test bot token, the test chat id and any value
   for `TELEGRAM_WEBHOOK_SECRET`.
3. Create the local database: `pnpm exec wrangler d1 migrations apply tg-bot --local`. Local data lives in the gitignored
   `.wrangler/` directory; delete it to reset. After pulling, re-run `pnpm exec wrangler d1 migrations apply tg-bot --local`:
   an old local database rejects Stripe events until the newest migration is applied.
4. Start the Worker: `pnpm dev`.
5. In a second terminal run `stripe listen --forward-to localhost:8787/stripe/webhook`. It prints a `whsec_...` signing
   secret; put it in `.dev.vars` as `STRIPE_WEBHOOK_SECRET` and restart `pnpm dev`.
6. In a third terminal run `pnpm dev:telegram`. It polls the test bot for updates and forwards them to the local
   `/telegram/webhook` (set `DEV_WORKER_URL` in `.dev.vars` to forward elsewhere).
7. Pay through a test-mode Payment Link with the card `4242 4242 4242 4242`, or run
   `stripe trigger checkout.session.completed`.

Notes: dashboard links always point at the live dashboard, so on test-mode payments they open the live dashboard and will
not find the payment. While `pnpm dev:telegram` runs, `getUpdates` in a browser (the chat id lookup) answers 409. Variables already
exported in your shell win over `.dev.vars`.

## Things that go wrong

- Test mode, live mode and `stripe listen` each have a different `whsec_` secret. The secret in the Worker must belong to
  the endpoint that delivers the events. Create a separate endpoint for each mode and switch the secret when you switch modes.
- Set the endpoint's API version to the one the installed `stripe` package expects (`Stripe.API_VERSION`, also in the
  package's `CHANGELOG.md`), so event payloads have the shape the code reads.
- Stripe retries every non-2xx response. A wrong secret therefore shows up as repeated 400 responses in the Stripe
  dashboard, with `stripe signature rejected:` in the Worker logs (Workers Logs are enabled in `wrangler.jsonc`).
- A 500 `misconfigured` means a key is missing; the log names it. The Stripe route needs `STRIPE_WEBHOOK_SECRET`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and the `DB` binding. The Telegram route needs `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` and `DB`.
- Buttons spin and nothing happens: the `secret_token` given to `setWebhook` differs from `TELEGRAM_WEBHOOK_SECRET`.
  `getWebhookInfo` shows `last_error_message` (a 401 from the Worker).
- If the group is upgraded to a supergroup its chat id changes and the bot ignores it (the log says
  `telegram update from other chat ignored:`) until `TELEGRAM_CHAT_ID` is updated.
- Do not enable tracing in `wrangler.jsonc`: spans would record the Telegram URL, which contains the bot token.

## Development

- `pnpm test` runs the unit tests (Vitest, Node, no network). The D1 database is faked over `node:sqlite`.
- `pnpm typecheck` runs `tsc`.
- Layout: `src/domain` (provider-free types), `src/stripe` (verification and mapping), `src/db` (the only code with SQL),
  `src/app` (use cases and message format), `src/bot` (grammY bot), `src/notify` (Telegram transport),
  `src/http` (webhook handlers), `src/worker.ts` (routing and wiring), `migrations` (D1 schema), `scripts` (local forwarder).
- Planned extensions are in `docs/v2.md`.
