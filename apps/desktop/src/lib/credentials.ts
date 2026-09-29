/**
 * Credential storage, from the frontend's side.
 *
 * Deliberately three functions and no getter. A secret can be stored, cleared,
 * and asked about — never read back. See `src-tauri/src/credentials.rs` for why,
 * and for the consequence: an integration that needs a credential must make its
 * request in Rust.
 */

import { invoke } from '@tauri-apps/api/core';

export function credentialSet(integration: string, secret: string): Promise<void> {
  return invoke<void>('credential_set', { integration, secret });
}

export function credentialClear(integration: string): Promise<void> {
  return invoke<void>('credential_clear', { integration });
}

/** Whether one exists. The only read, and it returns a boolean. */
export async function credentialPresent(integration: string): Promise<boolean> {
  try {
    return await invoke<boolean>('credential_present', { integration });
  } catch {
    // No Tauri runtime, or no credential store. Absent is the safe answer: it
    // leaves the integration in "needs configuration" rather than "ready".
    return false;
  }
}
