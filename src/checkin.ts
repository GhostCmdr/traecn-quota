/**
 * 与 src/extension.ts 的 checkinStateDay 同口径：'sv' locale 稳定产出 YYYY-MM-DD，
 * 不随系统语言变化。
 */
export function todayString(now: Date = new Date()): string {
  return now.toLocaleDateString('sv');
}

/**
 * 是否该发这次 claim。
 *
 * 判据只有本地日期，刻意不看 status 接口的 checked_in / did_checked_in ——
 * 实测这两个字段会给出互相矛盾的值，而服务端对重复领取幂等，
 * 所以「今天成功过一次就不再发」是最省事且安全的守卫。
 */
export function shouldClaim(lastSuccessDate: string | undefined, today: string): boolean {
  return lastSuccessDate !== today;
}
