# Connect with Meta

The WhatsApp module and platform tenant cards share the EmbeddedSignupConnect launcher.

## Behavior

- The read-only readiness request preloads the Facebook SDK; it does not create a signup session.
- With configuration/SDK ready, a click invokes FB.login synchronously, before any network await, to retain browser popup permission.
- The same click starts the authenticated server signup session. Its tenant/user-bound state is still required by the existing callback; tokens are exchanged and stored server-side.
- If clicked before preparation finishes, the UI prepares first and asks for another explicit click. It never tries to open a popup after an asynchronous wait.
- Missing settings, SDK/network failures and authorization errors appear below the button. The button remains retryable rather than permanently disabled.
- Cancellation/timeout releases the button. Only FINISH messages from the exact trusted Facebook origins are accepted, and the callback waits briefly if the FINISH message arrives after the authorization code.

## Production configuration

Set WHATSAPP_APP_ID and WHATSAPP_CONFIG_ID in the deployed server environment, then restart/redeploy. These must identify the same Meta app and its WhatsApp Embedded Signup / Facebook Login for Business configuration. Do not invent IDs from a screenshot or use another tenant's credentials.

WHATSAPP_APP_SECRET is needed for server-side code exchange. Keep it private; never add it to a NEXT_PUBLIC variable or commit it. The existing encryption and database configuration must also be valid.

In the Meta app dashboard, verify the production domain erp.muenot.co.in, allowed JavaScript SDK domains and applicable OAuth settings. Allow popups for the ERP site and allow connect.facebook.net through browser extensions/network policies.

The actual Facebook login/onboarding screen is hosted by Meta, not recreated by this application. Its wording, artwork and account prompts depend on the selected Meta configuration and Facebook session.

## Verification

Regression tests cover synchronous SDK launch, Business Login options, missing configuration, cancellation, timeout, initial clickable markup and trusted-origin messages. Production build is also checked. A real Facebook login and completed WABA onboarding still require deployment credentials and user interaction; automated tests do not connect a real account.

## Signup succeeds but status returns integration: null

The session tenant container must be allocated synchronously before getSession awaits cookies or JWT verification. Creating it only after those awaits does not propagate it back into the calling route's continuation. The status route can consequently have a valid session but no tenant context, while signup's explicit tenant scope successfully saves a connection.

getSession now initializes a fresh, empty tenant container before its first await, then populates that container only after session validation and tenant resolution. Fresh containers isolate concurrent requests; missing/revoked sessions do not retain inherited tenant state. Existing tenant selection and impersonation rules remain unchanged.

The regression suite exercises the real session/context code with mocked cookies, token verification and persistence boundaries, including the WhatsApp status route. It does not alter production tenant ownership or migrate previously saved integrations. After deploying, refresh the workspace before attempting another signup. If the row is still absent, compare the saved integration's tenant with the user's authorized workspace; do not expose another tenant's integration as a fallback.
