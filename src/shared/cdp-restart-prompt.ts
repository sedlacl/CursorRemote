export interface CdpRestartOfferInput {
  promptEnabled: boolean;
  cdpListening: boolean;
  alreadyClaimedThisLaunch: boolean;
}

/** Ask once per Cursor launch, and only when the setting is on and CDP is down. */
export function shouldOfferCdpRestart(input: CdpRestartOfferInput): boolean {
  return input.promptEnabled && !input.cdpListening && !input.alreadyClaimedThisLaunch;
}

/** One claim file per Cursor process so every window does not ask again. */
export function cdpRestartPromptClaimFileName(launchPid: string): string {
  const pid = launchPid.trim();
  if (!pid) {
    throw new Error('Launch PID is required for the CDP restart prompt claim');
  }
  return `cdp-restart-prompt.${pid}`;
}
