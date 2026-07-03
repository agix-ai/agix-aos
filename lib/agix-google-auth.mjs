// agix-google-auth — shared Workspace auth chain for Agix agents.
//
// Auth model: ADC (operator's gcloud session, locally; or Cloud Run's attached
// SA in cloud) → IAM signJwt as the per-agent SA → JWT-bearer exchange with
// subject = tenant's Workspace user → 1-hour access token. No long-lived key
// files anywhere in the chain.
//
// sanitizeGoogleEnv() MUST be called at the top of every Agix tool that
// imports google-auth-library — a stray GOOGLE_APPLICATION_CREDENTIALS env
// var (often left over from another project's SA key file) silently hijacks
// google-auth-library's credential resolution before it reaches ADC.

// NOTE: `google-auth-library` + `googleapis` are LAZY (dynamic) imports — they
// are heavy (~194MB combined) and only the Workspace-email/Drive features use
// them. They are declared as OPTIONAL dependencies and are NOT bundled in the
// lean public pack. Importing them at module top-level would drag ~194MB into
// every CLI startup (the runtime imports this module for `sanitizeGoogleEnv`,
// which itself needs neither). So we import them inside the functions that
// actually use them, with a clear error if the optional dep is absent.

const ADC_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// Lazy loaders for the optional Google deps. Throw a CLEAR, actionable error
// (NOT a raw module-not-found stack) when the lean pack omitted them.
async function loadGoogleAuthLibrary() {
  try {
    return await import('google-auth-library');
  } catch {
    throw new Error(
      'Google Workspace auth needs the optional "google-auth-library" package, which ' +
      'is not bundled in the lean Agix pack. Install it to enable Workspace features:\n' +
      '  npm i -g google-auth-library googleapis\n' +
      'Or use the direct API / CLI path that does not require Workspace auth.'
    );
  }
}

async function loadGoogleapis() {
  try {
    return await import('googleapis');
  } catch {
    throw new Error(
      'Google Workspace integration needs the optional "googleapis" package, which ' +
      'is not bundled in the lean Agix pack. Install it to enable Workspace features:\n' +
      '  npm i -g googleapis google-auth-library\n' +
      'Or use the direct API / CLI path that does not require Workspace auth.'
    );
  }
}

export function sanitizeGoogleEnv() {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

// Returns an impersonated access token suitable for direct use in an
// Authorization: Bearer header. Performs the full chain:
//   1. ADC → source token (operator's gcloud session, or Cloud Run SA)
//   2. IAM signJwt as `saEmail` asserting `subject` + `scopes`
//   3. JWT-bearer token exchange → impersonated access token
export async function getImpersonatedToken({ saEmail, subject, scopes }) {
  if (!saEmail) throw new Error('getImpersonatedToken: saEmail required');
  if (!subject) throw new Error('getImpersonatedToken: subject required');
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('getImpersonatedToken: scopes (array) required');
  }

  const { GoogleAuth } = await loadGoogleAuthLibrary();
  const auth = new GoogleAuth({ scopes: ADC_SCOPES });

  let sourceClient;
  try {
    sourceClient = await auth.getClient();
  } catch (err) {
    throw new Error(
      `Cannot load Application Default Credentials.\n` +
      `Run: gcloud auth application-default login\n` +
      `Then: gcloud auth application-default set-quota-project agix-platform\n` +
      `Underlying error: ${err.message}`
    );
  }

  const sourceTokenResp = await sourceClient.getAccessToken();
  const sourceToken = typeof sourceTokenResp === 'string'
    ? sourceTokenResp
    : sourceTokenResp.token;
  if (!sourceToken) {
    throw new Error('ADC returned an empty access token. Run: gcloud auth application-default login');
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtPayload = {
    iss: saEmail,
    sub: subject,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const signJwtUrl =
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:signJwt`;
  const signResp = await fetch(signJwtUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sourceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload: JSON.stringify(jwtPayload) }),
  });
  if (!signResp.ok) {
    const body = await signResp.text();
    throw new Error(
      `IAM signJwt failed (${signResp.status}). Check that the operator (or Cloud Run SA) ` +
      `has roles/iam.serviceAccountTokenCreator on ${saEmail}.\n${body}`
    );
  }
  const { signedJwt } = await signResp.json();

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });
  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(
      `JWT-bearer token exchange failed (${tokenResp.status}). The most common cause is that ` +
      `Domain-Wide Delegation has not been authorized for the SA's Client ID at ` +
      `https://admin.google.com/ac/owl/domainwidedelegation with scope ${scopes.join(' ')}.\n${body}`
    );
  }
  const tokenData = await tokenResp.json();
  return {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + Math.max(60, (tokenData.expires_in ?? 3600) - 60) * 1000,
  };
}

// Convenience: returns a google.auth.OAuth2 client carrying an impersonated
// access token, ready to hand to a googleapis service constructor.
export async function getImpersonatedOAuth2Client({ saEmail, subject, scopes }) {
  const { accessToken, expiresAt } = await getImpersonatedToken({ saEmail, subject, scopes });
  const { google } = await loadGoogleapis();
  const client = new google.auth.OAuth2();
  client.setCredentials({
    access_token: accessToken,
    expiry_date: expiresAt,
    token_type: 'Bearer',
  });
  return client;
}
