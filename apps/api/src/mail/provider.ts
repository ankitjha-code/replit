/**
 * The boundary between the platform and whatever sends email.
 *
 * The same shape as the execution, storage and database ports, for the same
 * reason: the platform decides a message should be sent and something else
 * sends it. An installation with no mail server refuses honestly rather than
 * recording a token nobody will ever receive.
 *
 * ## Why this exists at all
 *
 * Two features need it and neither can be half-built. **Verifying an address**
 * needs a message sent to that address — that is the entire mechanism. **Resetting
 * a password** needs one too, and it is the feature that decides whether a
 * forgotten password means asking an operator to edit a row.
 *
 * Both were left out until now precisely because a token table with no way to
 * deliver a token would look like the feature while being none of it.
 *
 * ## What an implementation may not do
 *
 * 1. **Never log a message body.** Every message this platform sends contains a
 *    credential; a mail log would be a credential log.
 * 2. **A failure to send is a failure of the operation.** A reset request that
 *    silently failed to send would leave somebody waiting for a message that is
 *    not coming, with no way to tell that from a slow one.
 * 3. **Nothing about a recipient is inferred.** The address comes from a row and
 *    is sent exactly as stored.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /**
   * Plain text only.
   *
   * No HTML, and that is a decision rather than an omission. An HTML message is
   * a document with links in it, which is the shape every phishing message
   * takes; the messages this platform sends are three lines and a URL, and
   * reading exactly what you are about to click is worth more than a logo.
   */
  text: string;
}

export interface MailProvider {
  /** Recorded nowhere, but useful in a health probe and in logs. */
  readonly name: string;

  /**
   * Why mail cannot be sent, or null when it can.
   *
   * Asked before a token is written, so an installation with no mail server
   * refuses the whole operation rather than storing something nobody can use.
   */
  unavailableReason(): Promise<string | null>;

  send(message: MailMessage): Promise<void>;
}
