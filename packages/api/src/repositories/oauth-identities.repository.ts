// OAuth identities repository — typed query functions over `oauth_identity`.
//
// Supports the Auth_Service link-or-create flow for google/apple identities
// (Requirement 1.5). All queries are parameterized.

import { type Queryable, queryMaybeOne } from './queryable.js';
import { mapOAuthIdentity } from './rows.js';
import type { OAuthIdentityRecord, OAuthProvider } from './types.js';

const OAUTH_COLUMNS = `
  id, user_id, provider, provider_user_id, email, created_at
`;

/** Link a provider identity to a user. */
export async function linkOAuthIdentity(
  db: Queryable,
  input: {
    userId: string;
    provider: OAuthProvider;
    providerUserId: string;
    email?: string | null;
  },
): Promise<OAuthIdentityRecord> {
  const sql = `
    INSERT INTO oauth_identity (user_id, provider, provider_user_id, email)
    VALUES ($1, $2, $3, $4)
    RETURNING ${OAUTH_COLUMNS}
  `;
  const params = [
    input.userId,
    input.provider,
    input.providerUserId,
    input.email ?? null,
  ];
  const row = await queryMaybeOne(db, sql, params);
  if (!row) throw new Error('linkOAuthIdentity did not return a row.');
  return mapOAuthIdentity(row);
}

/** Find a linked identity by provider and provider-supplied user id. */
export async function findOAuthIdentity(
  db: Queryable,
  provider: OAuthProvider,
  providerUserId: string,
): Promise<OAuthIdentityRecord | null> {
  const sql = `
    SELECT ${OAUTH_COLUMNS} FROM oauth_identity
    WHERE provider = $1 AND provider_user_id = $2
  `;
  const row = await queryMaybeOne(db, sql, [provider, providerUserId]);
  return row ? mapOAuthIdentity(row) : null;
}
