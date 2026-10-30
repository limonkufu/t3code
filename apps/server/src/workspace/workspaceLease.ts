import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

const withLease = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(key, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(key);
        }),
      ),
    );
  });

export const withWorkspaceLease = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
  withLease(normalizeProjectPathForComparison(cwd), effect);
export const withNamedSpaceLease = <A, E, R>(spaceId: string, effect: Effect.Effect<A, E, R>) =>
  withLease(JSON.stringify(["space", spaceId]), effect);
