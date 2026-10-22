export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailProvider {
  readonly name: string;

  unavailableReason(): Promise<string | null>;

  send(message: MailMessage): Promise<void>;
}
