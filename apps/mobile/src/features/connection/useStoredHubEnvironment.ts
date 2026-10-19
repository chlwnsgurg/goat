import type { EnvironmentId } from "@goat/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { loadHubEnvironmentId } from "./hubEnvironment";

export function useStoredHubEnvironment() {
  const [storedHubId, setStoredHubId] = useState<EnvironmentId | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoaded(false);
      void loadHubEnvironmentId().then(
        (id) => {
          if (!active) return;
          setStoredHubId(id);
          setError(null);
          setLoaded(true);
        },
        () => {
          if (active) setError("Couldn't load the saved hub. Reopen this screen to try again.");
        },
      );
      return () => {
        active = false;
      };
    }, []),
  );

  return { storedHubId, loaded, error };
}
