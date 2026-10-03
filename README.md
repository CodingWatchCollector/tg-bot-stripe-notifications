# tg-bot

A Cloudflare Worker that sends you a Telegram message when a customer pays through Stripe Checkout or a Payment Link.
The message shows the amount, the customer and a link to the payment in the Stripe dashboard.

It has one endpoint, `POST /stripe/webhook`. It handles `checkout.session.completed` and
`checkout.session.async_payment_succeeded` events whose `payment_status` is `paid`. Everything else gets a 200 and no message.
There is no storage: if Stripe retries a delivery you may get a duplicate message.

## Setup

1. Install dependencies: `pnpm install`.
2. Create the bot. In Telegram, message `@BotFather`, send `/newbot` and follow the prompts. Copy the bot token.
3. Find your chat id. Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `message.chat.id` from the response.
   For a group, add the bot to the group, send a message there and read the (negative) id the same way.
4. Local config: copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in `STRIPE_WEBHOOK_SECRET`,
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
5. Run locally with `pnpm dev`, then in another terminal:
   ```
   stripe listen --forward-to localhost:8787/stripe/webhook
   stripe trigger checkout.session.completed
   ```
   `stripe listen` prints a `whsec_...` signing secret; put that one in `.dev.vars`. A Telegram message should arrive.

## Deploy

1. Set the Telegram secrets (each command prompts for the value):
   ```
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_CHAT_ID
   ```
2. Deploy with `pnpm run deploy`. Wrangler prints the Worker URL.
3. In the Stripe dashboard (Developers > Webhooks) add an endpoint `https://<your-worker>/stripe/webhook`
   and select the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Open the endpoint, reveal its signing secret (`whsec_...`) and store it with
   `pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET`.

## Things that go wrong

- Test mode, live mode and `stripe listen` each have a different `whsec_` secret. The secret in the Worker must belong to
  the endpoint that delivers the events. Create a separate endpoint for each mode and switch the secret when you switch modes.
- Set the endpoint's API version to the one the installed `stripe` package expects (`Stripe.API_VERSION`, also in the
  package's `CHANGELOG.md`), so event payloads have the shape the code reads.
- Stripe retries every non-2xx response. A wrong secret therefore shows up as repeated 400 responses in the Stripe
  dashboard, with `stripe signature rejected:` in the Worker logs (Workers Logs are enabled in `wrangler.jsonc`).
  A 500 `misconfigured` means one of the three variables is missing; the log names it.
- Do not enable tracing in `wrangler.jsonc`: spans would record the Telegram URL, which contains the bot token.

## Development

- `pnpm test` runs the unit tests (Vitest, Node, no network).
- `pnpm typecheck` runs `tsc`.
- Layout: `src/domain` (provider-free types), `src/stripe` (verification and mapping), `src/app` (use cases),
  `src/notify` (message format and Telegram transport), `src/http` (webhook handler), `src/worker.ts` (routing and wiring).
- Planned extensions are in `docs/v2.md`.
