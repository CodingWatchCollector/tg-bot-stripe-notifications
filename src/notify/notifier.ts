export interface Button {
  text: string;
  data: string;
}

export interface Notifier {
  send(text: string, opts?: { buttons?: Button[][] }): Promise<{ messageId: number }>;
}

// Carries only a pre-sanitized description: transport errors can contain the bot token.
export class NotifyError extends Error {
  override name = "NotifyError";
  readonly safeDetail: string;

  constructor(safeDetail: string) {
    super(safeDetail);
    this.safeDetail = safeDetail;
  }
}
