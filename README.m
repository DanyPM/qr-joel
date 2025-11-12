# Environment variables

The server expects the following configuration values to be present:

- `APP_DOMAIN`
- `PORT`

At least one of the following messenger configurations must also be provided:

- `TELEGRAM_BOT_NAME`
- `WHATSAPP_PHONE_NUMBER`
- `MATRIX_BOT_LINK` – Base Matrix link that will have the start command appended to it
  (for example `https://matrix.to/#/@joelbot:example?message=`).
