# Shopkeeper Android push contract

The backend uses the existing mobile auth, device registration table, notification engine and WhatsApp webhook. It does not introduce a second notification history or webhook.

## Expo app setup

1. In Firebase Console, create/select the Android Firebase app matching the Expo Android application ID and enable Firebase Cloud Messaging.
2. Configure native Firebase for the Expo EAS build. Keep `google-services.json` in the private app build configuration (do not commit it if repository policy treats it as a secret). Do not add a Firebase service-account JSON/private key to the app.
3. Use `expo-notifications` and a physical Android device. Request notification permission, create an Android notification channel, then obtain the native FCM device token with `getDevicePushTokenAsync()` (not an Expo push token).
4. Generate one random installation `deviceId`, persist it securely on the device, and reuse it across launches/token refreshes. On login, send the token to the backend. If the FCM token rotates, send the same `deviceId` and new `pushToken` again.
5. When the user signs out, call `DELETE /api/mobile/v1/devices` with that installation `deviceId`, then call `POST /api/mobile/v1/auth/logout`. These operations revoke only the current bearer session's device registration. Do not send a tenant ID.
6. Handle foreground notifications and notification taps in Expo. `data.route` is an internal app route; `data.conversationId`, `data.messageId`, `data.contactName`, `data.preview`, and `data.timestamp` are optional display/routing values. Fetch the authoritative notification/message after opening the app; push payloads are not the source of truth.

## Backend device API

All endpoints use HTTPS and `Authorization: Bearer <accessToken>`. Tenant and user identity are taken from the server-validated session.

`POST` or `PATCH /api/mobile/v1/devices` body:

```json
{
  "deviceId": "stable-installation-id",
  "pushToken": "native-fcm-registration-token",
  "pushProvider": "fcm",
  "platform": "android",
  "appVersion": "1.0.0",
  "deviceName": "Pixel"
}
```

`DELETE /api/mobile/v1/devices` body:

```json
{ "deviceId": "stable-installation-id" }
```

An active push token cannot be claimed by a different user, tenant or installation. Tokens are encrypted at rest; their SHA-256 digest is used for lookup. Session refresh rebinds the registration to the rotated session. Logout and explicit session revocation deactivate only registrations linked to that session.

## Server configuration

Set these only in the backend deployment's encrypted server environment:

- `FCM_PROJECT_ID`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY` (newlines or literal `\n` separators are accepted)

Grant the service account permission to send Firebase Cloud Messaging messages and enable the FCM HTTP v1 API. Never use `NEXT_PUBLIC_` for these variables. Deploy migration `2026-09-23-mobile-push-infrastructure.sql` and ensure the existing `/api/cron/notification-delivery` worker runs (the standard schedule is every minute).

## Events and retry behavior

A newly persisted WhatsApp message queues one in-app notification and one push delivery per tenant owner/admin and the assigned conversation agent. Meta webhook message-ID idempotency plus the notification engine's `(tenant, channel, request key)` uniqueness prevents duplicate queue records. Push uses a short display preview and non-secret routing identifiers only. An FCM `UNREGISTERED` response disables that device token. Temporary provider errors are retried by the existing delivery worker; partial acceptance is not retried to avoid duplicate notifications. A push outage does not fail inbound WhatsApp processing.
