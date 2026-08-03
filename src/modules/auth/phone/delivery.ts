export interface OtpDeliveryPort { deliver(phoneE164: string, otp: string): Promise<void> }
export class TestOtpDelivery implements OtpDeliveryPort {
  readonly deliveries: Array<{ phoneE164: string; otp: string }> = [];
  async deliver(phoneE164: string, otp: string): Promise<void> { this.deliveries.push({ phoneE164, otp }); }
}
export class DevelopmentOtpDelivery implements OtpDeliveryPort {
  private readonly values = new Map<string, string>();
  async deliver(phoneE164: string, otp: string): Promise<void> { this.values.set(phoneE164, otp); }
  take(phoneE164: string): string | undefined { const value = this.values.get(phoneE164); this.values.delete(phoneE164); return value; }
}
