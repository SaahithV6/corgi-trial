/**
 * The shape a chaos action answers with, and its idle value.
 *
 * In its own module because a `"use server"` module may only export async
 * functions, and both the action module and the client component that calls it
 * need this constant. Same arrangement as
 * `src/components/accounts/action-result.ts`.
 */

export type ChaosActionStatus = 'idle' | 'done' | 'refused';

export type ChaosActionResult = {
  readonly status: ChaosActionStatus;
  readonly code: string | null;
  readonly message: string;
  /** Which control or button the answer is about, so the UI can place it. */
  readonly subject: string | null;
};

export const IDLE_CHAOS_RESULT: ChaosActionResult = {
  status: 'idle',
  code: null,
  message: '',
  subject: null,
};
