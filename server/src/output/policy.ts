/** Process-lifetime gates, deliberately independent of saved settings, imports and API commands. */
export const PREVIEW = process.env.LIGHTESOTA_PREVIEW === "1";
export const OUTPUT_COMMISSIONED = process.env.LIGHTESOTA_OUTPUT_COMMISSIONED === "1";
export const OUTPUT_VETO = PREVIEW || !OUTPUT_COMMISSIONED;
export const HAZE_COMMISSIONED = process.env.LIGHTESOTA_HAZE_COMMISSIONED === "1";
export const HAZE_VETO = OUTPUT_VETO || !HAZE_COMMISSIONED;
export const HAZE_DISABLED_REASON = !HAZE_COMMISSIONED ? "Haze uncommissioned: building approval and physical testing pending"
  : PREVIEW ? "Haze disabled in preview" : !OUTPUT_COMMISSIONED ? "Whole output is uncommissioned" : null;

export function requireHazeOutput(): void {
  if (HAZE_VETO) throw new Error(HAZE_DISABLED_REASON!);
}

export function requirePhysicalOutput(): void {
  if (OUTPUT_VETO) throw new Error(PREVIEW ? "Physical output is permanently vetoed in this preview process" : "Physical output requires explicit operator commissioning before process start");
}
