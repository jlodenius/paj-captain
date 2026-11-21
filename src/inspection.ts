import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CAPTAIN_INSPECTION_EVENT = "paj:captain-inspection:v1";

export async function setCaptainInspection(
  events: Pick<ExtensionAPI["events"], "emit"> | undefined,
  piSessionId: string,
  enabled: boolean,
): Promise<void> {
  let response: Promise<void> | undefined;
  let querying = true;
  try {
    events?.emit(CAPTAIN_INSPECTION_EVENT, {
      enabled,
      piSessionId,
      reply(result: unknown) {
        if (!(result instanceof Promise)) return;
        void result.catch(() => undefined);
        if (querying && !response) response = result;
      },
    });
  } finally {
    querying = false;
  }
  if (!response)
    throw new Error(
      "Captain inspection requires a compatible live Paj receiver; reload Paj",
    );
  await response;
}
