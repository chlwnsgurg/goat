// @effect-diagnostics cryptoRandomUUID:off - browser home claims use the platform UUID source.
import {
  goatBotHomeAttemptKey,
  newGoatBotHomeClaim,
  planGoatBotHomeSync,
  reduceGoatBotHomeAttempts,
  type GoatBotHomeAttempts,
} from "@t3tools/client-runtime/goatBot/home";
import {
  AuthSettingsWriteScope,
  compareGoatBotHomeClaims,
  type EnvironmentId,
  type GoatBotHomeClaim,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { resolveGoatBotHomeSelection } from "./goatBotAvailability";
import { useGoatBotEnvironments } from "./goatBotHooks";

/** Read raw home snapshots, and write only to connected, capable, permitted servers. */
export function useGoatBotHomeSettings() {
  const environments = useGoatBotEnvironments();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const home = useMemo(
    () => resolveGoatBotHomeSelection(environments, botRef),
    [environments, botRef],
  );
  const writableIds = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const write = useCallback(
    async (environmentId: EnvironmentId, claim: GoatBotHomeClaim) => {
      const target = home.targets.find((entry) => entry.environmentId === environmentId);
      if (
        !target?.connected ||
        !target.supportsHome ||
        !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
      )
        return false;
      try {
        const result = await persist({ environmentId, input: { patch: { goatBotHome: claim } } });
        return result._tag === "Success";
      } catch {
        return false;
      }
    },
    [home.targets, persist],
  );
  return { ...home, environments, writableIds, write };
}

/** Mounted once by the sidebar; readers elsewhere never create or replicate a claim. */
export function useGoatBotHome() {
  const { targets, resolution, candidateId, writableIds, write } = useGoatBotHomeSettings();
  const attempts = useRef<GoatBotHomeAttempts>(new Map());
  const inFlight = useRef(new Map<string, symbol>());
  const observedMax = useRef<GoatBotHomeClaim | null>(null);
  const pendingClaim = useRef<GoatBotHomeClaim | null>(null);
  const previousClaimId = useRef<string | null>(null);
  const connected = useRef(new Set<EnvironmentId>());
  // Successful RPCs wait for snapshot readback rather than rewriting on every render.
  const awaitingReadback = useRef(new Map<string, object | null>());
  const snapshots = useRef(new Map<EnvironmentId, object | null>());
  const alive = useRef(false);
  const [revision, wake] = useState(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    for (const target of targets) {
      const snapshot = target.home;
      if (
        target.supportsHome &&
        snapshot !== null &&
        (observedMax.current === null ||
          compareGoatBotHomeClaims(snapshot, observedMax.current) > 0)
      )
        observedMax.current = snapshot;
      snapshots.current.set(target.environmentId, snapshot);
      if (target.connected && !connected.current.has(target.environmentId)) {
        for (const key of inFlight.current.keys()) {
          if (key.endsWith(`:${target.environmentId}`)) inFlight.current.delete(key);
        }
        for (const claimId of [previousClaimId.current, pendingClaim.current?.claimId]) {
          if (!claimId) continue;
          attempts.current = reduceGoatBotHomeAttempts(attempts.current, {
            type: "success",
            claimId,
            environmentId: target.environmentId,
          });
          awaitingReadback.current.delete(goatBotHomeAttemptKey(claimId, target.environmentId));
        }
      }
      for (const [key, previousSnapshot] of awaitingReadback.current) {
        if (key.endsWith(`:${target.environmentId}`) && previousSnapshot !== snapshot)
          awaitingReadback.current.delete(key);
      }
    }
    connected.current = new Set(
      targets.filter((target) => target.connected).map((target) => target.environmentId),
    );
    if (resolution.state === "unknown") return;
    if (resolution.state === "claimed") pendingClaim.current = null;
    if (resolution.state === "unclaimed" && pendingClaim.current === null) {
      if (candidateId === null || !writableIds.has(candidateId)) return;
      pendingClaim.current = newGoatBotHomeClaim({
        environmentId: candidateId,
        now: Date.now(),
        observedMax: observedMax.current,
        randomId: () => crypto.randomUUID(),
      });
    }
    const claim = resolution.state === "claimed" ? resolution.claim : pendingClaim.current;
    if (claim === null) return;
    if (previousClaimId.current !== claim.claimId) {
      attempts.current = reduceGoatBotHomeAttempts(attempts.current, {
        type: "claim-changed",
        claimId: claim.claimId,
      });
      awaitingReadback.current.clear();
      previousClaimId.current = claim.claimId;
    }
    const staleTargetIds = (
      resolution.state === "claimed"
        ? resolution.staleTargetIds
        : targets
            .filter((target) => target.connected && target.supportsHome)
            .map((target) => target.environmentId)
    ).filter((id) => writableIds.has(id));
    const planned = planGoatBotHomeSync({
      resolution: {
        state: "claimed",
        claim,
        homeConnected: true,
        homeSupportsBot: true,
        staleTargetIds,
      },
      attempts: attempts.current,
      inFlight: new Set([...inFlight.current.keys(), ...awaitingReadback.current.keys()]),
      now: Date.now(),
    });
    for (const request of planned.writes) {
      const { environmentId } = request;
      const key = goatBotHomeAttemptKey(claim.claimId, environmentId);
      const token = Symbol();
      inFlight.current.set(key, token);
      attempts.current = reduceGoatBotHomeAttempts(attempts.current, {
        type: "start",
        claimId: claim.claimId,
        environmentId,
        now: Date.now(),
      });
      const snapshot = snapshots.current.get(environmentId) ?? null;
      void write(environmentId, claim)
        .then((success) => {
          if (previousClaimId.current !== claim.claimId || inFlight.current.get(key) !== token)
            return;
          attempts.current = reduceGoatBotHomeAttempts(attempts.current, {
            type: success ? "success" : "failure",
            claimId: claim.claimId,
            environmentId,
            now: Date.now(),
          });
          if (success && snapshots.current.get(environmentId) === snapshot)
            awaitingReadback.current.set(key, snapshot);
        })
        .finally(() => {
          if (inFlight.current.get(key) === token) inFlight.current.delete(key);
          if (alive.current) wake((value) => value + 1);
        });
    }
    if (planned.nextWakeAt === null) return;
    const timer = setTimeout(
      () => wake((value) => value + 1),
      Math.max(0, planned.nextWakeAt - Date.now()),
    );
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Revision wakes retry planning after RPC completion or the backoff timer.
  }, [targets, resolution, candidateId, writableIds, write, revision]);
}
