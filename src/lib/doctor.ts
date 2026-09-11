/** Client-side shape of the server's setup-doctor report. */
export type DoctorReport = {
  checks: Array<{ id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; recommendation?: string }>
  ranAt: number
}
