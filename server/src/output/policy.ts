/** Process-lifetime gates, deliberately independent of saved settings, imports and API commands. */
export const PREVIEW = process.env.LIGHTESOTA_PREVIEW === "1";
export const OUTPUT_COMMISSIONED = process.env.LIGHTESOTA_OUTPUT_COMMISSIONED === "1";
export const OUTPUT_VETO = PREVIEW || !OUTPUT_COMMISSIONED;

export function requirePhysicalOutput(): void {
  if (OUTPUT_VETO) throw new Error(PREVIEW ? "Physical output is permanently vetoed in this preview process" : "Physical output requires explicit operator commissioning before process start");
}
