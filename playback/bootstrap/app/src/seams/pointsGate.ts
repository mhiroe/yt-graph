// Learning-points gate seam — viewing allowance is gated on study points,
// whose source is the partner side (dokoitsu). Dokoitsu is unimplemented,
// so the seam resolves to a fail-soft default policy while unconnected
// instead of blocking playback or leaving viewing unmetered.

export type PointsAllowance = {
  connected: boolean;
  // minutes of viewing currently permitted; null = unmetered
  remainingMinutes: number | null;
  policy: string;
  note?: string;
};

export interface PointsGateAdapter {
  readonly name: string;
  allowance(): Promise<PointsAllowance>;
}

// Provisional default — point semantics (earn/spend rate, ledger location)
// are an open question on the wish. Conservative cap aligned with the
// 30-min viewing rhythm until the user pins the policy.
export const UNCONNECTED_DEFAULT = { policy: "unconnected-default", capMinutes: 30 } as const;

export class DokoitsuPointsGate implements PointsGateAdapter {
  readonly name = "dokoitsu";
  async allowance(): Promise<PointsAllowance> {
    return {
      connected: false,
      remainingMinutes: UNCONNECTED_DEFAULT.capMinutes,
      policy: UNCONNECTED_DEFAULT.policy,
      note: "dokoitsu points pipe not connected",
    };
  }
}

export function createPointsGate(_kind: string = "auto"): PointsGateAdapter {
  return new DokoitsuPointsGate();
}
